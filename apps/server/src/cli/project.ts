import {
  CommandId,
  type OrchestrationProjectShell,
  type ProjectMutation,
  ProjectId,
  type ProjectScript,
  ProjectScriptIcon,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import { ProjectServiceLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectRepositoryIdentityStore from "../project/ProjectRepositoryIdentityStore.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { projectMutationOperation } from "../project/ProjectMutation.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { withCliJsonErrorOutput } from "./errorOutput.ts";
import {
  type CliLiveOrchestrationServer,
  type CliLiveServerReadTimeouts,
  CliOrchestrationConflictError,
  CliOrchestrationDeclaredResponseError,
  CliOrchestrationOutcomeUnknownError,
  CliOrchestrationReadTimeoutError,
  CliOrchestrationRequestError,
  CliOrchestrationServerUnavailableError,
  CliOrchestrationUndeclaredStatusError,
  cliOrchestrationErrorFromRequest,
  dispatchLiveProjectMutation,
  fetchLiveEnvironmentDescriptor,
  fetchLiveServerSettings,
  resolveCliLiveServerReadTimeouts,
  updateLiveServerSettings,
  withResolvedLiveOrchestrationServer,
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

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const jsonOutput = (value: unknown) => JSON.stringify(value, null, 2);

export class ProjectCommandIdGenerationError extends Schema.TaggedError<ProjectCommandIdGenerationError>()(
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

export class ProjectTitleEmptyError extends Schema.TaggedError<ProjectTitleEmptyError>()(
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

export class ProjectAlreadyExistsError extends Schema.TaggedError<ProjectAlreadyExistsError>()(
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

export class ProjectActionServerUnsupportedError extends Schema.TaggedError<ProjectActionServerUnsupportedError>()(
  "ProjectActionServerUnsupportedError",
  {
    operation: Schema.Literal("validateProjectActionServerCapability"),
    serverVersion: Schema.String,
  },
) {
  override get message(): string {
    return `The running T3 Code server (${this.serverVersion}) does not support safe project action updates. Update and restart T3 Code, then retry.`;
  }
}

export const ProjectCommandError = Schema.Union([
  ProjectCommandIdGenerationError,
  CliOrchestrationDeclaredResponseError,
  CliOrchestrationUndeclaredStatusError,
  CliOrchestrationRequestError,
  CliOrchestrationConflictError,
  CliOrchestrationOutcomeUnknownError,
  CliOrchestrationReadTimeoutError,
  CliOrchestrationServerUnavailableError,
  ProjectTitleEmptyError,
  ProjectIdentifierEmptyError,
  ProjectNotFoundError,
  ProjectAlreadyExistsError,
  ProjectActionServerUnsupportedError,
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

const ProjectCliRuntimeLive = ProjectServiceLayerLive.pipe(
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(ProjectRepositoryIdentityStore.layer),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(
    ProjectFaviconResolver.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(T3ProjectFileLoader.layer),
    ),
  ),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(SqlitePersistence.layerConfig),
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

/** A project as both the live shell and the offline project snapshot expose it. */
type ProjectCliProject = {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly deletedAt?: string | null;
};

type ProjectCliDispatch = (mutation: ProjectMutation) => Effect.Effect<void, Error>;

/** Adds a project unless an active one already owns the normalized workspace root. */
export const addProjectFromCli = Effect.fn("addProjectFromCli")(function* (input: {
  readonly projects: ReadonlyArray<ProjectCliProject>;
  readonly workspaceRoot: string;
  readonly title?: string;
  readonly dispatch: ProjectCliDispatch;
}) {
  const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(input.workspaceRoot);
  const existingProject = input.projects.find(
    (project) => project.deletedAt == null && project.workspaceRoot === workspaceRoot,
  );
  if (existingProject) {
    return yield* new ProjectAlreadyExistsError({
      operation: "addProject",
      projectId: existingProject.id,
      workspaceRoot,
    });
  }

  const title = yield* resolveProjectTitle(workspaceRoot, input.title);
  const projectId = ProjectId.make(yield* projectCommandUuid);
  yield* input.dispatch({
    type: "project.create",
    commandId: CommandId.make(yield* projectCommandUuid),
    projectId,
    title,
    workspaceRoot,
  });
  return { projectId, title, workspaceRoot };
});

/**
 * Shared CLI environment for project commands: resolves the data directory,
 * silences logs in `--json` mode, and reports failures through the JSON
 * error contract.
 */
const runWithProjectCliEnvironment = <A, E, R>(
  flags: CliAuthLocationFlags,
  json: boolean,
  body: (input: {
    readonly config: ServerConfig.ServerConfig["Service"];
    readonly minimumLogLevel: ServerConfig.ServerConfig["Service"]["logLevel"];
    readonly environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"];
    readonly timeouts: CliLiveServerReadTimeouts;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = json ? "None" : config.logLevel;

    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const timeouts = yield* resolveCliLiveServerReadTimeouts(flags.timeoutMs ?? Option.none());
      return yield* body({ config, minimumLogLevel, environmentAuth, timeouts });
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
  }).pipe(withCliJsonErrorOutput(json));

/**
 * Project add/remove/rename go through the running server when one owns this
 * data directory, and through the project service directly otherwise. A
 * server that is alive but unresponsive fails instead of falling back, so the
 * CLI never writes behind a live server's back.
 */
const runProjectMutation = <E, R>(
  flags: CliAuthLocationFlags,
  json: boolean,
  run: (input: {
    readonly projects: ReadonlyArray<ProjectCliProject>;
    readonly dispatch: ProjectCliDispatch;
    readonly mode: ProjectCommandExecutionMode;
  }) => Effect.Effect<string, E, R>,
) =>
  runWithProjectCliEnvironment(
    flags,
    json,
    Effect.fnUntraced(function* ({ config, minimumLogLevel, environmentAuth, timeouts }) {
      const live = yield* withResolvedLiveOrchestrationServer(
        { environmentAuth, config, label: "t3 project cli", timeouts },
        (server, token) =>
          run({
            projects: server.shell.projects,
            dispatch: (mutation) =>
              dispatchLiveProjectMutation(server.origin, token, mutation).pipe(Effect.asVoid),
            mode: "live",
          }),
      );
      if (Option.isSome(live)) {
        return yield* Console.log(live.value);
      }

      const output = yield* Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const snapshot = yield* projects.snapshot;
        return yield* run({
          projects: snapshot.projects,
          dispatch: (mutation) => projectMutationOperation(projects, mutation).pipe(Effect.asVoid),
          mode: "offline",
        });
      }).pipe(
        Effect.provide(
          ProjectCliRuntimeLive.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
      );
      yield* Console.log(output);
    }),
  );

interface LiveProjectCommandInput {
  readonly live: CliLiveOrchestrationServer;
  readonly getSettings: Effect.Effect<ServerSettings, Error, HttpClient.HttpClient>;
  readonly updateSettings: (patch: ServerSettingsPatch) => Effect.Effect<ServerSettings, Error>;
}

/**
 * Settings-backed project reads and action updates need the running server:
 * action edits are a compare-and-set against its canonical settings.
 */
const runLiveProjectCommand = <E, R>(
  flags: CliAuthLocationFlags,
  json: boolean,
  run: (input: LiveProjectCommandInput) => Effect.Effect<string, E, R>,
  options?: {
    readonly requireConditionalProjectScriptUpdates?: boolean;
  },
) =>
  runWithProjectCliEnvironment(
    flags,
    json,
    Effect.fnUntraced(function* ({ config, environmentAuth, timeouts }) {
      const live = yield* withResolvedLiveOrchestrationServer(
        { environmentAuth, config, label: "t3 project cli", timeouts },
        (server, token) =>
          Effect.gen(function* () {
            if (options?.requireConditionalProjectScriptUpdates) {
              const descriptor = yield* fetchLiveEnvironmentDescriptor(server.origin, timeouts);
              if (descriptor.capabilities.conditionalProjectSettingsScriptUpdates !== true) {
                return yield* new ProjectActionServerUnsupportedError({
                  operation: "validateProjectActionServerCapability",
                  serverVersion: descriptor.serverVersion,
                });
              }
            }
            return yield* run({
              live: server,
              getSettings: fetchLiveServerSettings(server.origin, token, timeouts),
              updateSettings: (patch) => updateLiveServerSettings(server.origin, token, patch),
            });
          }),
      );
      if (Option.isNone(live)) {
        return yield* new CliOrchestrationServerUnavailableError({
          operation: "resolveLiveServer",
          statePath: config.serverRuntimeStatePath,
        });
      }
      yield* Console.log(live.value);
    }),
  );

const projectAddCommand = Command.make("add", {
  ...projectLocationFlags,
  workspaceRoot: Argument.String("path").pipe(
    Argument.withDescription("Workspace root to add as a project."),
  ),
  title: Flag.String("title").pipe(Flag.withDescription("Optional project title."), Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Add a project."),
  Command.withHandler((flags) =>
    runProjectMutation(flags, flags.json, ({ projects, dispatch }) =>
      Effect.gen(function* () {
        const { projectId, title, workspaceRoot } = yield* addProjectFromCli({
          projects,
          workspaceRoot: flags.workspaceRoot,
          ...(Option.isSome(flags.title) ? { title: flags.title.value } : {}),
          dispatch,
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
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or workspace root to remove."),
  ),
  json: jsonFlag,
  force: Flag.Boolean("force").pipe(
    Flag.withDescription("Delete the project and all of its threads."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Remove a project."),
  Command.withHandler((flags) =>
    runProjectMutation(flags, flags.json, ({ projects, dispatch }) =>
      Effect.gen(function* () {
        const project = yield* findActiveProjectTarget({ projects, identifier: flags.project });
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
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or workspace root to rename."),
  ),
  title: Argument.String("title").pipe(Argument.withDescription("New project title.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Rename a project."),
  Command.withHandler((flags) =>
    runProjectMutation(flags, flags.json, ({ projects, dispatch }) =>
      Effect.gen(function* () {
        const project = yield* findActiveProjectTarget({ projects, identifier: flags.project });
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
          type: "project.update",
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

export const projectListSummary = (
  project: OrchestrationProjectShell,
  settings?: ServerSettings,
) => {
  const resolved =
    settings === undefined ? undefined : resolveProjectSettings(settings, project.id, project);
  return {
    id: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    defaultModelSelection:
      resolved === undefined
        ? project.defaultModelSelection
        : resolved.settings.defaultModelSelection,
    // Per-project thread env-mode override; null means the checked-in
    // the environment setting and t3.json decide (older servers omit it).
    defaultThreadEnvMode:
      resolved === undefined
        ? (project.defaultThreadEnvMode ?? null)
        : resolved.sources.defaultThreadEnvMode === "project"
          ? resolved.settings.defaultThreadEnvMode
          : null,
    autoPull: resolved?.settings.defaultAutoPull ?? project.autoPull ?? false,
  };
};

const projectListCommand = Command.make("list", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active projects."),
  Command.withHandler((flags) =>
    runLiveProjectCommand(flags, flags.json, ({ live, getSettings }) =>
      Effect.gen(function* () {
        const settings = yield* getSettings;
        const projects = live.shell.projects.map((project) =>
          projectListSummary(project, settings),
        );
        return flags.json
          ? jsonOutput({ mode: "live", projects })
          : projects.length === 0
            ? "No active projects."
            : projects
                .map((project) => `${project.id}\t${project.title}\t${project.workspaceRoot}`)
                .join("\n");
      }),
    ),
  ),
);

const projectActionTargetArgument = Argument.String("project").pipe(
  Argument.withDescription("Project id or workspace root."),
);

const projectActionIdArgument = Argument.String("action").pipe(
  Argument.withDescription("Exact project action id."),
);

const projectActionIconFlag = Flag.Literals("icon", ProjectScriptIcon.literals).pipe(
  Flag.withDescription("Action icon."),
);

const clearedSetupActionMessage = (actionIds: ReadonlyArray<string>) =>
  actionIds.length === 0 ? "" : ` Cleared automatic worktree setup from: ${actionIds.join(", ")}.`;

/** Resolves a project and its effective actions from the live server. */
const readProjectActions = Effect.fn("readProjectActions")(function* (
  input: LiveProjectCommandInput,
  identifier: string,
) {
  const projects = input.live.shell.projects;
  const target = yield* findActiveProjectTarget({ projects, identifier });
  const project = projects.find((candidate) => candidate.id === target.id)!;
  const scripts = resolveProjectScripts(yield* input.getSettings, project);
  return { project, scripts };
});

/** Writes the next action list, failing if they changed since they were read. */
const writeProjectActions = (
  input: LiveProjectCommandInput,
  projectId: ProjectId,
  expectedScripts: ReadonlyArray<ProjectScript>,
  scripts: ReadonlyArray<ProjectScript>,
) =>
  input.updateSettings({
    projectScriptUpdate: {
      projectId,
      expectedScripts: Array.from(expectedScripts),
      scripts: Array.from(scripts),
    },
  });

const projectActionListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: projectActionTargetArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List a project's actions."),
  Command.withHandler((flags) =>
    runLiveProjectCommand(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const { project, scripts } = yield* readProjectActions(input, flags.project);
        return flags.json
          ? jsonOutput({
              mode: "live",
              projectId: project.id,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              actions: scripts,
            })
          : scripts.length === 0
            ? `Project ${project.id} has no actions.`
            : scripts
                .map((action) => `${action.id}\t${action.name}\t${action.icon}\t${action.command}`)
                .join("\n");
      }),
    ),
  ),
);

const projectActionAddCommand = Command.make("add", {
  ...projectLocationFlags,
  project: projectActionTargetArgument,
  id: Flag.String("id").pipe(Flag.withDescription("Optional stable action id."), Flag.optional),
  name: Flag.String("name").pipe(Flag.withDescription("Action display name.")),
  command: Flag.String("command").pipe(Flag.withDescription("Shell command to run.")),
  icon: projectActionIconFlag.pipe(Flag.withDefault("play")),
  runOnWorktreeCreate: Flag.Boolean("run-on-worktree-create").pipe(
    Flag.withDescription("Run automatically after creating a worktree."),
    Flag.withDefault(false),
  ),
  async: Flag.Boolean("async").pipe(
    Flag.withDescription("Let a setup action continue while the agent starts."),
    Flag.optional,
  ),
  previewUrl: Flag.String("preview-url").pipe(
    Flag.withDescription("Optional desktop preview URL."),
    Flag.optional,
  ),
  autoOpenPreview: Flag.Boolean("auto-open-preview").pipe(
    Flag.withDescription("Open the configured preview automatically."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Add a project action."),
  Command.withHandler((flags) =>
    runLiveProjectCommand(
      flags,
      flags.json,
      (input) =>
        Effect.gen(function* () {
          const { project, scripts } = yield* readProjectActions(input, flags.project);
          const result = addProjectAction({
            projectId: project.id,
            scripts,
            action: {
              ...(Option.isSome(flags.id) ? { id: flags.id.value } : {}),
              name: flags.name,
              command: flags.command,
              icon: flags.icon,
              runOnWorktreeCreate: flags.runOnWorktreeCreate,
              ...(Option.isSome(flags.async) ? { async: flags.async.value } : {}),
              ...(Option.isSome(flags.previewUrl) ? { previewUrl: flags.previewUrl.value } : {}),
              autoOpenPreview: flags.autoOpenPreview,
            },
          });
          if ("_tag" in result) {
            return yield* result;
          }
          yield* writeProjectActions(input, project.id, scripts, result.scripts);
          return flags.json
            ? jsonOutput({
                projectId: project.id,
                action: "added",
                projectAction: result.action,
                clearedRunOnWorktreeCreate: result.clearedRunOnWorktreeCreate,
              })
            : `Added action ${result.action.id} (${result.action.name}) to project ${project.id}.${clearedSetupActionMessage(result.clearedRunOnWorktreeCreate)}`;
        }),
      { requireConditionalProjectScriptUpdates: true },
    ),
  ),
);

const projectActionUpdateCommand = Command.make("update", {
  ...projectLocationFlags,
  project: projectActionTargetArgument,
  actionId: projectActionIdArgument,
  name: Flag.String("name").pipe(Flag.withDescription("New action display name."), Flag.optional),
  command: Flag.String("command").pipe(Flag.withDescription("New shell command."), Flag.optional),
  icon: projectActionIconFlag.pipe(Flag.optional),
  runOnWorktreeCreate: Flag.Boolean("run-on-worktree-create").pipe(
    Flag.withDescription("Enable or disable automatic worktree setup."),
    Flag.optional,
  ),
  async: Flag.Boolean("async").pipe(
    Flag.withDescription("Enable or disable asynchronous setup."),
    Flag.optional,
  ),
  previewUrl: Flag.String("preview-url").pipe(
    Flag.withDescription("New desktop preview URL."),
    Flag.optional,
  ),
  clearPreviewUrl: Flag.Boolean("clear-preview-url").pipe(
    Flag.withDescription("Remove the preview URL and automatic preview setting."),
    Flag.withDefault(false),
  ),
  autoOpenPreview: Flag.Boolean("auto-open-preview").pipe(
    Flag.withDescription("Enable or disable automatic preview opening."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Update a project action."),
  Command.withHandler((flags) =>
    runLiveProjectCommand(
      flags,
      flags.json,
      (input) =>
        Effect.gen(function* () {
          const { project, scripts } = yield* readProjectActions(input, flags.project);
          if (flags.clearPreviewUrl && Option.isSome(flags.previewUrl)) {
            return yield* new ProjectActionValidationError({
              field: "previewUrl",
              detail: "cannot be set and cleared in the same command",
            });
          }
          const result = updateProjectAction({
            projectId: project.id,
            scripts,
            actionId: flags.actionId,
            updates: {
              ...(Option.isSome(flags.name) ? { name: flags.name.value } : {}),
              ...(Option.isSome(flags.command) ? { command: flags.command.value } : {}),
              ...(Option.isSome(flags.icon) ? { icon: flags.icon.value } : {}),
              ...(Option.isSome(flags.runOnWorktreeCreate)
                ? { runOnWorktreeCreate: flags.runOnWorktreeCreate.value }
                : {}),
              ...(Option.isSome(flags.async) ? { async: flags.async.value } : {}),
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
          const changed = !Equal.equals(result.scripts, scripts);
          yield* writeProjectActions(input, project.id, scripts, result.scripts);
          return flags.json
            ? jsonOutput({
                projectId: project.id,
                action: changed ? "updated" : "unchanged",
                projectAction: result.action,
                clearedRunOnWorktreeCreate: result.clearedRunOnWorktreeCreate,
              })
            : changed
              ? `Updated action ${result.action.id} (${result.action.name}) in project ${project.id}.${clearedSetupActionMessage(result.clearedRunOnWorktreeCreate)}`
              : `Action ${result.action.id} is unchanged.`;
        }),
      { requireConditionalProjectScriptUpdates: true },
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
    runLiveProjectCommand(
      flags,
      flags.json,
      (input) =>
        Effect.gen(function* () {
          const { project, scripts } = yield* readProjectActions(input, flags.project);
          const result = removeProjectAction({
            projectId: project.id,
            scripts,
            actionId: flags.actionId,
          });
          if ("_tag" in result) {
            return yield* result;
          }
          yield* writeProjectActions(input, project.id, scripts, result.scripts);
          return flags.json
            ? jsonOutput({
                projectId: project.id,
                action: "removed",
                projectAction: result.action,
              })
            : `Removed action ${result.action.id} (${result.action.name}) from project ${project.id}.`;
        }),
      { requireConditionalProjectScriptUpdates: true },
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
