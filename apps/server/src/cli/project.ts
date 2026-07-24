import {
  CommandId,
  type OrchestrationReadModel,
  ProjectId,
  ProjectScriptIcon,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  CliOrchestrationDeclaredResponseError,
  CliOrchestrationRequestError,
  CliOrchestrationUndeclaredStatusError,
  cliOrchestrationErrorFromRequest,
  dispatchLiveOrchestrationCommand,
  fetchLiveOrchestrationSnapshot,
  tryResolveLiveOrchestrationServer,
  withCliOrchestrationSession,
} from "./orchestration.ts";
import {
  addProjectAction,
  ProjectActionAlreadyExistsError,
  ProjectActionNotFoundError,
  ProjectActionValidationError,
  removeProjectAction,
  updateProjectAction,
} from "./projectActions.ts";
import {
  findActiveProjectTarget,
  normalizeWorkspaceRootForProjectCommand,
  ProjectIdentifierEmptyError,
  ProjectNotFoundError,
} from "./projectTarget.ts";

type ProjectCommandExecutionMode = "live" | "offline";
type ProjectCliDispatchCommand = Extract<
  ClientOrchestrationCommand,
  { type: "project.create" | "project.meta.update" | "project.delete" }
>;

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const jsonOutput = (value: unknown) => JSON.stringify(value, null, 2);

export class ProjectCommandIdGenerationError extends Schema.TaggedErrorClass<ProjectCommandIdGenerationError>()(
  "ProjectCommandIdGenerationError",
  {
    operation: Schema.Literal("generateProjectCommandId"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to generate a project command identifier.";
  }
}

export class ProjectTitleEmptyError extends Schema.TaggedErrorClass<ProjectTitleEmptyError>()(
  "ProjectTitleEmptyError",
  {
    operation: Schema.Literal("validateProjectTitle"),
    title: Schema.String,
  },
) {
  override get message(): string {
    return "Project title cannot be empty.";
  }
}

export class ProjectAlreadyExistsError extends Schema.TaggedErrorClass<ProjectAlreadyExistsError>()(
  "ProjectAlreadyExistsError",
  {
    operation: Schema.Literal("addProject"),
    projectId: ProjectId,
    workspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `An active project already exists for '${this.workspaceRoot}'.`;
  }
}

export const ProjectCommandError = Schema.Union([
  ProjectCommandIdGenerationError,
  CliOrchestrationDeclaredResponseError,
  CliOrchestrationUndeclaredStatusError,
  CliOrchestrationRequestError,
  ProjectTitleEmptyError,
  ProjectIdentifierEmptyError,
  ProjectNotFoundError,
  ProjectAlreadyExistsError,
  ProjectActionAlreadyExistsError,
  ProjectActionNotFoundError,
  ProjectActionValidationError,
]);
export type ProjectCommandError = typeof ProjectCommandError.Type;

export function projectCommandErrorFromLiveServerRequest(cause: unknown): ProjectCommandError {
  return cliOrchestrationErrorFromRequest(cause);
}

const projectCommandUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(
    (cause) =>
      new ProjectCommandIdGenerationError({
        operation: "generateProjectCommandId",
        cause,
      }),
  ),
);

const ProjectCliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

const resolveProjectTitle = Effect.fn("resolveProjectTitle")(function* (
  workspaceRoot: string,
  explicitTitle?: string,
) {
  if (explicitTitle !== undefined) {
    const trimmed = explicitTitle.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
    return yield* new ProjectTitleEmptyError({
      operation: "validateProjectTitle",
      title: explicitTitle,
    });
  }

  const path = yield* Path.Path;
  const basename = path.basename(workspaceRoot).trim();
  return basename.length > 0 ? basename : "project";
});

const getOfflineSnapshot = Effect.fn("getOfflineSnapshot")(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  return yield* projectionSnapshotQuery.getSnapshot();
});

const runProjectMutation = Effect.fn("runProjectMutation")(function* (
  flags: CliAuthLocationFlags,
  json: boolean,
  run: (input: {
    readonly snapshot: OrchestrationReadModel;
    readonly dispatch: (
      command: ProjectCliDispatchCommand,
    ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
    readonly mode: ProjectCommandExecutionMode;
  }) => Effect.Effect<
    string,
    Error,
    | Crypto.Crypto
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Path.Path
    | WorkspacePaths.WorkspacePaths
  >,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = json ? "None" : config.logLevel;

  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const liveMode = yield* tryResolveLiveOrchestrationServer(
      environmentAuth,
      config,
      "t3 project cli",
    );

    if (Option.isSome(liveMode)) {
      return yield* withCliOrchestrationSession(environmentAuth, "t3 project cli", (token) =>
        Effect.gen(function* () {
          const snapshot = yield* fetchLiveOrchestrationSnapshot(liveMode.value.origin, token);
          const output = yield* run({
            snapshot,
            dispatch: (command) =>
              dispatchLiveOrchestrationCommand(liveMode.value.origin, token, command).pipe(
                Effect.asVoid,
              ),
            mode: "live",
          });
          yield* Console.log(output);
        }),
      );
    }

    const offlineRuntimeLayer = ProjectCliRuntimeLive.pipe(
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
    );

    return yield* Effect.gen(function* () {
      const snapshot = yield* getOfflineSnapshot();
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const output = yield* run({
        snapshot,
        dispatch: (command) => orchestrationEngine.dispatch(command),
        mode: "offline",
      });
      yield* Console.log(output);
    }).pipe(Effect.provide(offlineRuntimeLayer));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.runtimeLayer, WorkspacePaths.layer).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
    Effect.provideService(References.MinimumLogLevel, minimumLogLevel),
  );
});

const projectAddCommand = Command.make("add", {
  ...projectLocationFlags,
  workspaceRoot: Argument.string("path").pipe(
    Argument.withDescription("Workspace root to add as a project."),
  ),
  title: Flag.string("title").pipe(Flag.withDescription("Optional project title."), Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Add a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      flags.json,
      Effect.fn("projectAddMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(flags.workspaceRoot);
        const existingProject = snapshot.projects.find(
          (project) => project.deletedAt === null && project.workspaceRoot === workspaceRoot,
        );
        if (existingProject) {
          return yield* new ProjectAlreadyExistsError({
            operation: "addProject",
            projectId: existingProject.id,
            workspaceRoot,
          });
        }

        const title = yield* resolveProjectTitle(workspaceRoot, Option.getOrUndefined(flags.title));
        const projectId = ProjectId.make(yield* projectCommandUuid);
        yield* dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId,
          title,
          workspaceRoot,
          defaultModelSelection: ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        return flags.json
          ? jsonOutput({ projectId, title, workspaceRoot, action: "added" })
          : `Added project ${projectId} (${title}) at ${workspaceRoot}.`;
      }),
    ),
  ),
);

const projectRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to remove."),
  ),
  json: jsonFlag,
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Delete the project and all of its threads."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Remove a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      flags.json,
      Effect.fn("projectRemoveMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          projects: snapshot.projects,
          identifier: flags.project,
        });
        yield* dispatch({
          type: "project.delete",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          force: flags.force,
        });
        return flags.json
          ? jsonOutput({ projectId: project.id, title: project.title, action: "removed" })
          : `Removed project ${project.id} (${project.title}).`;
      }),
    ),
  ),
);

const projectRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to rename."),
  ),
  title: Argument.string("title").pipe(Argument.withDescription("New project title.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Rename a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      flags.json,
      Effect.fn("projectRenameMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          projects: snapshot.projects,
          identifier: flags.project,
        });
        const nextTitle = yield* resolveProjectTitle(project.workspaceRoot, flags.title);
        if (nextTitle === project.title) {
          return flags.json
            ? jsonOutput({
                projectId: project.id,
                title: nextTitle,
                previousTitle: project.title,
                action: "unchanged",
              })
            : `Project ${project.id} is already named ${nextTitle}.`;
        }

        yield* dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          title: nextTitle,
        });
        return flags.json
          ? jsonOutput({
              projectId: project.id,
              title: nextTitle,
              previousTitle: project.title,
              action: "renamed",
            })
          : `Renamed project ${project.id} to ${nextTitle}.`;
      }),
    ),
  ),
);

const projectListCommand = Command.make("list", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active projects."),
  Command.withHandler((flags) =>
    runProjectMutation(flags, flags.json, ({ snapshot, mode }) => {
      const projects = snapshot.projects
        .filter((project) => project.deletedAt === null)
        .map((project) => ({
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          defaultModelSelection: project.defaultModelSelection,
        }));
      return Effect.succeed(
        flags.json
          ? jsonOutput({ mode, projects })
          : projects.length === 0
            ? "No active projects."
            : projects
                .map((project) => `${project.id}\t${project.title}\t${project.workspaceRoot}`)
                .join("\n"),
      );
    }),
  ),
);

const projectActionTargetArgument = Argument.string("project").pipe(
  Argument.withDescription("Project id or workspace root."),
);

const projectActionIdArgument = Argument.string("action").pipe(
  Argument.withDescription("Exact project action id."),
);

const projectActionIconFlag = Flag.choice("icon", ProjectScriptIcon.literals).pipe(
  Flag.withDescription("Action icon."),
);

const findProjectForAction = Effect.fn("findProjectForAction")(function* (
  snapshot: OrchestrationReadModel,
  identifier: string,
) {
  const target = yield* findActiveProjectTarget({
    projects: snapshot.projects,
    identifier,
  });
  return snapshot.projects.find((project) => project.id === target.id)!;
});

const projectActionListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: projectActionTargetArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List a project's actions."),
  Command.withHandler((flags) =>
    runProjectMutation(flags, flags.json, ({ snapshot, mode }) =>
      Effect.gen(function* () {
        const project = yield* findProjectForAction(snapshot, flags.project);
        return flags.json
          ? jsonOutput({
              mode,
              projectId: project.id,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              actions: project.scripts,
            })
          : project.scripts.length === 0
            ? `Project ${project.id} has no actions.`
            : project.scripts
                .map((action) => `${action.id}\t${action.name}\t${action.icon}\t${action.command}`)
                .join("\n");
      }),
    ),
  ),
);

const projectActionAddCommand = Command.make("add", {
  ...projectLocationFlags,
  project: projectActionTargetArgument,
  id: Flag.string("id").pipe(Flag.withDescription("Optional stable action id."), Flag.optional),
  name: Flag.string("name").pipe(Flag.withDescription("Action display name.")),
  command: Flag.string("command").pipe(Flag.withDescription("Shell command to run.")),
  icon: projectActionIconFlag.pipe(Flag.withDefault("play")),
  runOnWorktreeCreate: Flag.boolean("run-on-worktree-create").pipe(
    Flag.withDescription("Run automatically after creating a worktree."),
    Flag.withDefault(false),
  ),
  previewUrl: Flag.string("preview-url").pipe(
    Flag.withDescription("Optional desktop preview URL."),
    Flag.optional,
  ),
  autoOpenPreview: Flag.boolean("auto-open-preview").pipe(
    Flag.withDescription("Open the configured preview automatically."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Add a project action."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      flags.json,
      Effect.fn("projectActionAddMutation")(function* ({ snapshot, dispatch }) {
        const project = yield* findProjectForAction(snapshot, flags.project);
        const result = addProjectAction({
          projectId: project.id,
          scripts: project.scripts,
          action: {
            ...(Option.isSome(flags.id) ? { id: flags.id.value } : {}),
            name: flags.name,
            command: flags.command,
            icon: flags.icon,
            runOnWorktreeCreate: flags.runOnWorktreeCreate,
            ...(Option.isSome(flags.previewUrl) ? { previewUrl: flags.previewUrl.value } : {}),
            autoOpenPreview: flags.autoOpenPreview,
          },
        });
        if ("_tag" in result) {
          return yield* result;
        }
        yield* dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          expectedUpdatedAt: project.updatedAt,
          scripts: Array.from(result.scripts),
        });
        return flags.json
          ? jsonOutput({
              projectId: project.id,
              action: "added",
              projectAction: result.action,
              clearedRunOnWorktreeCreate: result.clearedRunOnWorktreeCreate,
            })
          : `Added action ${result.action.id} (${result.action.name}) to project ${project.id}.`;
      }),
    ),
  ),
);

const projectActionUpdateCommand = Command.make("update", {
  ...projectLocationFlags,
  project: projectActionTargetArgument,
  actionId: projectActionIdArgument,
  name: Flag.string("name").pipe(Flag.withDescription("New action display name."), Flag.optional),
  command: Flag.string("command").pipe(Flag.withDescription("New shell command."), Flag.optional),
  icon: projectActionIconFlag.pipe(Flag.optional),
  runOnWorktreeCreate: Flag.boolean("run-on-worktree-create").pipe(
    Flag.withDescription("Enable or disable automatic worktree setup."),
    Flag.optional,
  ),
  previewUrl: Flag.string("preview-url").pipe(
    Flag.withDescription("New desktop preview URL."),
    Flag.optional,
  ),
  clearPreviewUrl: Flag.boolean("clear-preview-url").pipe(
    Flag.withDescription("Remove the preview URL and automatic preview setting."),
    Flag.withDefault(false),
  ),
  autoOpenPreview: Flag.boolean("auto-open-preview").pipe(
    Flag.withDescription("Enable or disable automatic preview opening."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Update a project action."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      flags.json,
      Effect.fn("projectActionUpdateMutation")(function* ({ snapshot, dispatch }) {
        const project = yield* findProjectForAction(snapshot, flags.project);
        if (flags.clearPreviewUrl && Option.isSome(flags.previewUrl)) {
          return yield* new ProjectActionValidationError({
            field: "previewUrl",
            detail: "cannot be set and cleared in the same command",
          });
        }
        const result = updateProjectAction({
          projectId: project.id,
          scripts: project.scripts,
          actionId: flags.actionId,
          updates: {
            ...(Option.isSome(flags.name) ? { name: flags.name.value } : {}),
            ...(Option.isSome(flags.command) ? { command: flags.command.value } : {}),
            ...(Option.isSome(flags.icon) ? { icon: flags.icon.value } : {}),
            ...(Option.isSome(flags.runOnWorktreeCreate)
              ? { runOnWorktreeCreate: flags.runOnWorktreeCreate.value }
              : {}),
            ...(flags.clearPreviewUrl
              ? { previewUrl: null }
              : Option.isSome(flags.previewUrl)
                ? { previewUrl: flags.previewUrl.value }
                : {}),
            ...(Option.isSome(flags.autoOpenPreview)
              ? { autoOpenPreview: flags.autoOpenPreview.value }
              : {}),
          },
        });
        if ("_tag" in result) {
          return yield* result;
        }
        const changed = !Equal.equals(result.scripts, project.scripts);
        if (changed) {
          yield* dispatch({
            type: "project.meta.update",
            commandId: CommandId.make(yield* projectCommandUuid),
            projectId: project.id,
            expectedUpdatedAt: project.updatedAt,
            scripts: Array.from(result.scripts),
          });
        }
        return flags.json
          ? jsonOutput({
              projectId: project.id,
              action: changed ? "updated" : "unchanged",
              projectAction: result.action,
              clearedRunOnWorktreeCreate: result.clearedRunOnWorktreeCreate,
            })
          : changed
            ? `Updated action ${result.action.id} (${result.action.name}) in project ${project.id}.`
            : `Action ${result.action.id} is unchanged.`;
      }),
    ),
  ),
);

const projectActionRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  project: projectActionTargetArgument,
  actionId: projectActionIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Remove a project action."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      flags.json,
      Effect.fn("projectActionRemoveMutation")(function* ({ snapshot, dispatch }) {
        const project = yield* findProjectForAction(snapshot, flags.project);
        const result = removeProjectAction({
          projectId: project.id,
          scripts: project.scripts,
          actionId: flags.actionId,
        });
        if ("_tag" in result) {
          return yield* result;
        }
        yield* dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          expectedUpdatedAt: project.updatedAt,
          scripts: Array.from(result.scripts),
        });
        return flags.json
          ? jsonOutput({
              projectId: project.id,
              action: "removed",
              projectAction: result.action,
            })
          : `Removed action ${result.action.id} (${result.action.name}) from project ${project.id}.`;
      }),
    ),
  ),
);

const projectActionCommand = Command.make("action").pipe(
  Command.withDescription("Manage project actions."),
  Command.withSubcommands([
    projectActionListCommand,
    projectActionAddCommand,
    projectActionUpdateCommand,
    projectActionRemoveCommand,
  ]),
);

export const projectCommand = Command.make("project").pipe(
  Command.withDescription("Manage projects."),
  Command.withSubcommands([
    projectListCommand,
    projectAddCommand,
    projectRemoveCommand,
    projectRenameCommand,
    projectActionCommand,
  ]),
);
