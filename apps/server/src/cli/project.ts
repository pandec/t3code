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
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import * as ServerConfig from "../config.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { latestMigrationId } from "../persistence/Migrations.ts";
import {
  layerConfig as SqlitePersistenceLayerLive,
  layerReadOnlyConfig as SqliteReadOnlyPersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { withCliJsonErrorOutput } from "./errorOutput.ts";
import {
  CliOrchestrationConflictError,
  CliOrchestrationDeclaredResponseError,
  CliOrchestrationOutcomeUnknownError,
  CliOrchestrationReadTimeoutError,
  CliOrchestrationRequestError,
  CliOrchestrationServerUnavailableError,
  CliOrchestrationUndeclaredStatusError,
  cliOrchestrationErrorFromRequest,
  dispatchLiveOrchestrationCommand,
  fetchLiveEnvironmentDescriptor,
  causeChainHasSqliteBusy,
  fetchLiveOrchestrationSnapshot,
  isCliOrchestrationReadTimeoutError,
  resolveCliLiveServerReadTimeouts,
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

export class ProjectActionServerUnsupportedError extends Schema.TaggedErrorClass<ProjectActionServerUnsupportedError>()(
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

const ProjectCliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

// Full offline stack for when no live server owns the database: may run
// migrations and dispatch through the local orchestration engine.
const offlineEngineRuntimeLayer = (
  config: ServerConfig.ServerConfig["Service"],
  minimumLogLevel: ServerConfig.ServerConfig["Service"]["logLevel"],
) =>
  ProjectCliRuntimeLive.pipe(
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
  );

// Snapshot-only stack for when a live server still owns the database: opens it
// strictly read-only — no migrations, no projection bootstrap, no writes.
const offlineReadOnlySnapshotLayer = (
  config: ServerConfig.ServerConfig["Service"],
  minimumLogLevel: ServerConfig.ServerConfig["Service"]["logLevel"],
) =>
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqliteReadOnlyPersistenceLive),
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
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

export const addProjectToOrchestration = Effect.fn("addProjectToOrchestration")(function* (input: {
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly deletedAt?: string | null;
  }>;
  readonly workspaceRoot: string;
  readonly title?: string;
  readonly dispatch: (
    command: Extract<ClientOrchestrationCommand, { type: "project.create" }>,
  ) => Effect.Effect<unknown, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
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
    defaultModelSelection: ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
    createdAt: DateTime.formatIso(yield* DateTime.now),
  });
  return { projectId, title, workspaceRoot };
});

const getOfflineSnapshot = Effect.fn("getOfflineSnapshot")(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  return yield* projectionSnapshotQuery.getSnapshot();
});

/**
 * The read-only fallback must not read through a schema older than this CLI
 * expects (a newer CLI next to a not-yet-restarted older server). When the
 * migration ledger is missing or behind, surface the original live-read
 * failure instead of a possibly-misdecoded snapshot.
 */
export const requireCurrentOfflineSchema = Effect.fn("requireCurrentOfflineSchema")(function* (
  fallbackError: Error,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly latestApplied: number | bigint | null;
  }>`SELECT MAX(migration_id) AS latestApplied FROM effect_sql_migrations`.pipe(
    Effect.orElseSucceed(() => []),
  );
  const latestApplied = rows[0]?.latestApplied;
  const appliedId = typeof latestApplied === "bigint" ? Number(latestApplied) : latestApplied;
  if (typeof appliedId !== "number" || appliedId < latestMigrationId) {
    return yield* Effect.fail(fallbackError);
  }
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
  options?: {
    readonly requireLive?: boolean;
    readonly requireConditionalProjectScriptUpdates?: boolean;
    readonly readOnly?: boolean;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;

  return yield* Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = json ? "None" : config.logLevel;

    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const timeouts = yield* resolveCliLiveServerReadTimeouts(flags.timeoutMs ?? Option.none());

      const liveAttempt = yield* Effect.result(
        withResolvedLiveOrchestrationServer(
          { environmentAuth, config, label: "t3 project cli", timeouts },
          (live, token) =>
            Effect.gen(function* () {
              if (options?.requireConditionalProjectScriptUpdates) {
                const descriptor = yield* fetchLiveEnvironmentDescriptor(live.origin, timeouts);
                if (descriptor.capabilities.conditionalProjectScriptUpdates !== true) {
                  return yield* new ProjectActionServerUnsupportedError({
                    operation: "validateProjectActionServerCapability",
                    serverVersion: descriptor.serverVersion,
                  });
                }
              }
              const snapshot = yield* fetchLiveOrchestrationSnapshot(live.origin, token, timeouts);
              const output = yield* run({
                snapshot,
                dispatch: (command) =>
                  dispatchLiveOrchestrationCommand(live.origin, token, command).pipe(Effect.asVoid),
                mode: "live",
              });
              yield* Console.log(output);
            }),
        ),
      );

      if (liveAttempt._tag === "Success" && Option.isSome(liveAttempt.success)) {
        return;
      }

      // A live-but-unresponsive server (slow reads, or a locked auth database
      // during session issuance) only degrades to the local snapshot for
      // read-only commands; mutations must never bypass the live server.
      const liveFallbackError =
        liveAttempt._tag === "Failure" &&
        options?.readOnly === true &&
        (isCliOrchestrationReadTimeoutError(liveAttempt.failure) ||
          causeChainHasSqliteBusy(liveAttempt.failure))
          ? liveAttempt.failure
          : undefined;

      if (liveAttempt._tag === "Failure") {
        if (liveFallbackError === undefined) {
          return yield* Effect.fail(liveAttempt.failure);
        }
        yield* Console.error(
          `${liveFallbackError.message} Reading local state instead; it may lag behind the running server.`,
        );
      } else if (options?.requireLive) {
        return yield* new CliOrchestrationServerUnavailableError({
          operation: "resolveLiveServer",
          statePath: config.serverRuntimeStatePath,
        });
      }

      if (liveFallbackError === undefined) {
        return yield* Effect.gen(function* () {
          const snapshot = yield* getOfflineSnapshot();
          const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
          const output = yield* run({
            snapshot,
            dispatch: (command) => orchestrationEngine.dispatch(command),
            mode: "offline",
          });
          yield* Console.log(output);
        }).pipe(Effect.provide(offlineEngineRuntimeLayer(config, minimumLogLevel)));
      }

      return yield* Effect.gen(function* () {
        yield* requireCurrentOfflineSchema(liveFallbackError);
        const snapshot = yield* getOfflineSnapshot();
        const output = yield* run({
          snapshot,
          dispatch: () => Effect.fail(liveFallbackError),
          mode: "offline",
        });
        yield* Console.log(output);
      }).pipe(Effect.provide(offlineReadOnlySnapshotLayer(config, minimumLogLevel)));
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
        const { projectId, title, workspaceRoot } = yield* addProjectToOrchestration({
          projects: snapshot.projects,
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

const runProjectList = Effect.fn("runProjectList")(function* (
  flags: CliAuthLocationFlags,
  json: boolean,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = json ? "None" : config.logLevel;

  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const timeouts = yield* resolveCliLiveServerReadTimeouts(flags.timeoutMs ?? Option.none());
    const liveAttempt = yield* Effect.result(
      withResolvedLiveOrchestrationServer(
        { environmentAuth, config, label: "t3 project cli", timeouts },
        (live) => Effect.succeed(live.shell.projects),
      ),
    );
    if (liveAttempt._tag === "Success" && Option.isSome(liveAttempt.success)) {
      return {
        mode: "live" as const,
        projects: liveAttempt.success.value,
      };
    }

    const liveFallbackError =
      liveAttempt._tag === "Failure" &&
      (isCliOrchestrationReadTimeoutError(liveAttempt.failure) ||
        causeChainHasSqliteBusy(liveAttempt.failure))
        ? liveAttempt.failure
        : undefined;
    if (liveAttempt._tag === "Failure") {
      if (liveFallbackError === undefined) {
        return yield* Effect.fail(liveAttempt.failure);
      }
      yield* Console.error(
        `${liveFallbackError.message} Reading local state instead; it may lag behind the running server.`,
      );
    }

    const snapshot =
      liveFallbackError === undefined
        ? yield* getOfflineSnapshot().pipe(
            Effect.provide(offlineEngineRuntimeLayer(config, minimumLogLevel)),
          )
        : yield* Effect.gen(function* () {
            yield* requireCurrentOfflineSchema(liveFallbackError);
            return yield* getOfflineSnapshot();
          }).pipe(Effect.provide(offlineReadOnlySnapshotLayer(config, minimumLogLevel)));
    return {
      mode: "offline" as const,
      projects: snapshot.projects.filter((project) => project.deletedAt === null),
    };
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

const projectListCommand = Command.make("list", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active projects."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { mode, projects: projectShells } = yield* runProjectList(flags, flags.json);
      const projects = projectShells.map((project) => ({
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        defaultModelSelection: project.defaultModelSelection,
      }));
      yield* Console.log(
        flags.json
          ? jsonOutput({ mode, projects })
          : projects.length === 0
            ? "No active projects."
            : projects
                .map((project) => `${project.id}\t${project.title}\t${project.workspaceRoot}`)
                .join("\n"),
      );
    }).pipe(withCliJsonErrorOutput(flags.json)),
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

const clearedSetupActionMessage = (actionIds: ReadonlyArray<string>) =>
  actionIds.length === 0 ? "" : ` Cleared automatic worktree setup from: ${actionIds.join(", ")}.`;

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
    runProjectMutation(
      flags,
      flags.json,
      ({ snapshot, mode }) =>
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
                  .map(
                    (action) => `${action.id}\t${action.name}\t${action.icon}\t${action.command}`,
                  )
                  .join("\n");
        }),
      { readOnly: true },
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
          expectedScripts: Array.from(project.scripts),
          scripts: Array.from(result.scripts),
        });
        return flags.json
          ? jsonOutput({
              projectId: project.id,
              action: "added",
              projectAction: result.action,
              clearedRunOnWorktreeCreate: result.clearedRunOnWorktreeCreate,
            })
          : `Added action ${result.action.id} (${result.action.name}) to project ${project.id}.${clearedSetupActionMessage(result.clearedRunOnWorktreeCreate)}`;
      }),
      { requireLive: true, requireConditionalProjectScriptUpdates: true },
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
        yield* dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          expectedScripts: Array.from(project.scripts),
          scripts: Array.from(result.scripts),
        });
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
      { requireLive: true, requireConditionalProjectScriptUpdates: true },
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
          expectedScripts: Array.from(project.scripts),
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
      { requireLive: true, requireConditionalProjectScriptUpdates: true },
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
