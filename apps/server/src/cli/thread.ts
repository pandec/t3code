import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ClientOrchestrationCommand,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ThreadTurnStartBootstrap,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { withCliJsonErrorOutput } from "./errorOutput.ts";
import {
  CliOrchestrationOutcomeUnknownError,
  CliOrchestrationServerUnavailableError,
  type CliLiveOrchestrationServer,
  type CliLiveServerReadTimeouts,
  dispatchLiveOrchestrationCommand,
  fetchLiveEnvironmentDescriptor,
  fetchLiveOrchestrationShell,
  resolveCliLiveServerReadTimeouts,
  withResolvedLiveOrchestrationServer,
} from "./orchestration.ts";
import { findActiveProjectTarget } from "./projectTarget.ts";
import {
  fetchProviderCatalog,
  resolveCliModelSelection,
  resolveGitCommonDirectory,
  resolveThreadModelInstance,
  runGitCommand,
  SessionCliError,
  SessionCliServerUnsupportedError,
} from "./session.ts";
import { threadCliState, threadHasActiveTurn } from "./threadState.ts";

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const jsonOutput = (value: unknown) => JSON.stringify(value, null, 2);
const isCliOrchestrationOutcomeUnknownError = Schema.is(CliOrchestrationOutcomeUnknownError);

export class ThreadCliNotFoundError extends Schema.TaggedErrorClass<ThreadCliNotFoundError>()(
  "ThreadCliNotFoundError",
  {
    operation: Schema.Literal("resolveThread"),
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `No active thread found for '${this.threadId}'.`;
  }
}

export class ThreadCliMessageEmptyError extends Schema.TaggedErrorClass<ThreadCliMessageEmptyError>()(
  "ThreadCliMessageEmptyError",
  {
    operation: Schema.Literal("validateMessage"),
  },
) {
  override get message(): string {
    return "Thread message cannot be empty.";
  }
}

export class ThreadCliTitleEmptyError extends Schema.TaggedErrorClass<ThreadCliTitleEmptyError>()(
  "ThreadCliTitleEmptyError",
  {
    operation: Schema.Literal("validateTitle"),
  },
) {
  override get message(): string {
    return "Thread title cannot be empty.";
  }
}

export class ThreadCliNoActiveTurnError extends Schema.TaggedErrorClass<ThreadCliNoActiveTurnError>()(
  "ThreadCliNoActiveTurnError",
  {
    operation: Schema.Literal("interruptThread"),
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Thread '${this.threadId}' has no active turn to interrupt.`;
  }
}

export class ThreadCliWorkspaceFlagError extends Schema.TaggedErrorClass<ThreadCliWorkspaceFlagError>()(
  "ThreadCliWorkspaceFlagError",
  {
    operation: Schema.Literal("resolveWorkspaceFlags"),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ThreadCliWorktreePathError extends Schema.TaggedErrorClass<ThreadCliWorktreePathError>()(
  "ThreadCliWorktreePathError",
  {
    operation: Schema.Literal("resolveWorktreePath"),
    worktreePath: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.detail} (${this.worktreePath})`;
  }
}

/** Where `t3 thread new` starts the thread: the project checkout as-is, a
    fresh server-created worktree, or an existing worktree by path. */
export type ThreadCliWorkspaceSelection =
  | { readonly mode: "checkout" }
  | {
      readonly mode: "new-worktree";
      readonly base: string | null;
      readonly branch: string | null;
      readonly startFromOrigin: boolean;
    }
  | {
      readonly mode: "existing-worktree";
      readonly worktreePath: string;
      readonly branch: string | null;
    };

export const resolveThreadCliWorkspaceSelection = (flags: {
  readonly newWorktree: boolean;
  readonly worktree: Option.Option<string>;
  readonly branch: Option.Option<string>;
  readonly base: Option.Option<string>;
  readonly startFromOrigin: boolean;
}): Effect.Effect<ThreadCliWorkspaceSelection, ThreadCliWorkspaceFlagError> => {
  const fail = (detail: string) =>
    Effect.fail(new ThreadCliWorkspaceFlagError({ operation: "resolveWorkspaceFlags", detail }));
  const worktree = flags.worktree.pipe(Option.map((value) => value.trim()));
  const branch = Option.getOrNull(flags.branch)?.trim() ?? null;
  if (branch !== null && branch.length === 0) {
    return fail("--branch cannot be empty.");
  }
  const base = Option.getOrNull(flags.base)?.trim() ?? null;
  if (base !== null && base.length === 0) {
    return fail("--base cannot be empty.");
  }
  if (flags.newWorktree && Option.isSome(worktree)) {
    return fail("--new-worktree and --worktree cannot be combined.");
  }
  if (flags.newWorktree) {
    return Effect.succeed({
      mode: "new-worktree",
      base,
      branch,
      startFromOrigin: flags.startFromOrigin,
    });
  }
  if (base !== null) {
    return fail("--base requires --new-worktree.");
  }
  if (flags.startFromOrigin) {
    return fail("--start-from-origin requires --new-worktree.");
  }
  if (Option.isSome(worktree)) {
    return worktree.value.length === 0
      ? fail("--worktree cannot be empty.")
      : Effect.succeed({ mode: "existing-worktree", worktreePath: worktree.value, branch });
  }
  if (branch !== null) {
    return fail("--branch requires --new-worktree or --worktree.");
  }
  return Effect.succeed({ mode: "checkout" });
};

// The bootstrap payload for --new-worktree: the server creates the thread,
// prepares the worktree (defaulting the base to the project's current branch
// when omitted), runs the setup script, and starts the turn — deleting the
// thread and worktree itself if a later step fails.
export const buildNewWorktreeBootstrap = (input: {
  readonly project: Pick<OrchestrationProjectShell, "id" | "workspaceRoot">;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspace: Extract<ThreadCliWorkspaceSelection, { mode: "new-worktree" }>;
  readonly worktreeBranch: string;
  readonly createdAt: string;
}): ThreadTurnStartBootstrap => ({
  createThread: {
    projectId: input.project.id,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    branch: null,
    worktreePath: null,
    createdAt: input.createdAt,
  },
  prepareWorktree: {
    projectCwd: input.project.workspaceRoot,
    ...(input.workspace.base !== null ? { baseBranch: input.workspace.base } : {}),
    branch: input.worktreeBranch,
    ...(input.workspace.startFromOrigin ? { startFromOrigin: true } : {}),
  },
  runSetupScript: true,
});

// Canonicalize and validate an existing worktree before recording it on the
// thread. Canonicalization matters: consumers compare worktreePath with strict
// equality against git-reported paths (e.g. /tmp vs /private/tmp on macOS),
// the git-common-dir check rejects directories that are not a worktree of the
// selected project's repository, and the checked-out branch is recorded on the
// thread (null for a detached HEAD) — an explicit --branch must match it.
const resolveExistingWorktree = Effect.fn("resolveExistingWorktree")(function* (input: {
  readonly rawPath: string;
  readonly projectWorkspaceRoot: string;
  readonly expectedBranch: string | null;
}) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const resolved = path.resolve(expandHomePath(input.rawPath));
  const invalidWorktree = (detail: string) =>
    new ThreadCliWorktreePathError({
      operation: "resolveWorktreePath",
      worktreePath: resolved,
      detail,
    });
  const info = yield* fileSystem
    .stat(resolved)
    .pipe(
      Effect.mapError(() => invalidWorktree("The worktree path does not exist on this machine.")),
    );
  if (info.type !== "Directory") {
    return yield* invalidWorktree("The worktree path is not a directory.");
  }
  const canonical = yield* fileSystem
    .realPath(resolved)
    .pipe(Effect.mapError(() => invalidWorktree("Failed to canonicalize the worktree path.")));
  const worktreeGitDirectory = yield* resolveGitCommonDirectory(canonical).pipe(
    Effect.mapError(() => invalidWorktree("The worktree path is not inside a git repository.")),
  );
  const projectGitDirectory = yield* resolveGitCommonDirectory(input.projectWorkspaceRoot).pipe(
    Effect.mapError(() =>
      invalidWorktree(
        "The project workspace root is not a git repository, so --worktree cannot be validated.",
      ),
    ),
  );
  if (worktreeGitDirectory !== projectGitDirectory) {
    return yield* invalidWorktree(
      "The worktree path belongs to a different git repository than the project.",
    );
  }
  const head = yield* runGitCommand(canonical, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
    Effect.mapError(() => invalidWorktree("Failed to read the worktree's checked-out branch.")),
  );
  const branch = head.exitCode === 0 && head.stdout.length > 0 ? head.stdout : null;
  if (input.expectedBranch !== null && branch !== input.expectedBranch) {
    return yield* invalidWorktree(
      `The worktree is on ${branch === null ? "a detached HEAD" : `branch '${branch}'`}, not '${input.expectedBranch}'.`,
    );
  }
  return { worktreePath: canonical, branch };
});

const randomUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.orDie,
);

const resolveThread = (
  live: CliLiveOrchestrationServer,
  rawThreadId: string,
): Effect.Effect<OrchestrationThreadShell, ThreadCliNotFoundError> => {
  const threadId = rawThreadId.trim();
  const thread = live.shell.threads.find(
    (candidate) => candidate.id === threadId && candidate.archivedAt === null,
  );
  return thread
    ? Effect.succeed(thread)
    : Effect.fail(
        new ThreadCliNotFoundError({ operation: "resolveThread", threadId: rawThreadId }),
      );
};

const requireTrimmedMessage = (message: string) => {
  const trimmed = message.trim();
  return trimmed.length > 0
    ? Effect.succeed(trimmed)
    : Effect.fail(new ThreadCliMessageEmptyError({ operation: "validateMessage" }));
};

const requireTrimmedTitle = (title: string) => {
  const trimmed = title.trim();
  return trimmed.length > 0
    ? Effect.succeed(trimmed)
    : Effect.fail(new ThreadCliTitleEmptyError({ operation: "validateTitle" }));
};

export const deriveThreadCliTitle = (message: string): string => {
  const compact = message.trim().replace(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
};

export const threadSummary = (thread: OrchestrationThreadShell) => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  state: threadCliState(thread),
  branch: thread.branch ?? null,
  worktreePath: thread.worktreePath ?? null,
  sessionStatus: thread.session?.status ?? null,
  activeTurnId: thread.session?.activeTurnId ?? null,
  snoozedUntil: thread.snoozedUntil ?? null,
  snoozedAt: thread.snoozedAt ?? null,
  hasPendingApprovals: thread.hasPendingApprovals,
  hasPendingUserInput: thread.hasPendingUserInput,
  latestUserMessageAt: thread.latestUserMessageAt,
  updatedAt: thread.updatedAt,
});

const runThreadCli = Effect.fn("runThreadCli")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  json: boolean,
  run: (input: {
    readonly live: CliLiveOrchestrationServer;
    readonly token: string;
    readonly timeouts: CliLiveServerReadTimeouts;
  }) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  return yield* Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = json ? "None" : config.logLevel;
    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const timeouts = yield* resolveCliLiveServerReadTimeouts(flags.timeoutMs ?? Option.none());
      const outcome = yield* withResolvedLiveOrchestrationServer(
        { environmentAuth, config, label: "t3 thread cli", timeouts },
        (live, token) => run({ live, token, timeouts }),
      );
      if (Option.isNone(outcome)) {
        return yield* new CliOrchestrationServerUnavailableError({
          operation: "resolveLiveServer",
          statePath: config.serverRuntimeStatePath,
        });
      }
      return outcome.value;
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

// Bootstrap turn starts include a git worktree creation (and optionally a
// remote fetch) before the server acknowledges, which can far exceed the
// default dispatch acknowledgement timeout on large repositories.
const BOOTSTRAP_DISPATCH_TIMEOUT_MS = 180_000;

const dispatchThreadCommand = (
  input: {
    readonly live: CliLiveOrchestrationServer;
    readonly token: string;
  },
  command: ClientOrchestrationCommand,
  options?: {
    readonly timeoutMilliseconds?: number;
  },
) => dispatchLiveOrchestrationCommand(input.live.origin, input.token, command, options);

export const compensateFailedThreadStart = Effect.fn("compensateFailedThreadStart")(function* <
  OriginalError,
  CleanupError,
  R,
>(originalError: OriginalError, cleanup: Effect.Effect<unknown, CleanupError, R>) {
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const cleanupResult = yield* Effect.result(cleanup);
      if (cleanupResult._tag === "Failure") {
        return yield* new CliOrchestrationOutcomeUnknownError({
          operation: "dispatchLiveServer",
          cause: cleanupResult.failure,
        });
      }
      return yield* Effect.fail(originalError);
    }),
  );
});

const threadListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.string("project").pipe(
    Flag.withDescription("Filter by project id or workspace root."),
    Flag.optional,
  ),
  state: Flag.choice("state", ["idle", "running", "interrupted", "completed", "error"]).pipe(
    Flag.withDescription("Filter by latest turn state."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active threads."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, ({ live }) =>
      Effect.gen(function* () {
        const project = Option.isSome(flags.project)
          ? yield* findActiveProjectTarget({
              projects: live.shell.projects,
              identifier: flags.project.value,
            })
          : null;
        const requestedState = Option.getOrNull(flags.state);
        const threads = live.shell.threads
          .filter((thread) => thread.archivedAt === null)
          .filter((thread) => project === null || thread.projectId === project.id)
          .filter((thread) => requestedState === null || threadCliState(thread) === requestedState)
          .map(threadSummary);
        yield* Console.log(
          flags.json
            ? jsonOutput({ threads })
            : threads.length === 0
              ? "No matching threads."
              : threads
                  .map(
                    (thread) =>
                      `${thread.id}\t${thread.state}\t${thread.title}\t${thread.projectId}`,
                  )
                  .join("\n"),
        );
      }),
    ),
  ),
);

const threadNewCommand = Command.make("new", {
  ...projectLocationFlags,
  project: Flag.string("project").pipe(Flag.withDescription("Project id or workspace root.")),
  message: Flag.string("message").pipe(Flag.withDescription("Initial user message.")),
  title: Flag.string("title").pipe(Flag.withDescription("Optional thread title."), Flag.optional),
  runtimeMode: Flag.choice("runtime-mode", RuntimeMode.literals).pipe(
    Flag.withDefault(DEFAULT_RUNTIME_MODE),
  ),
  interactionMode: Flag.choice("interaction-mode", ProviderInteractionMode.literals).pipe(
    Flag.withDefault(DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  model: Flag.string("model").pipe(Flag.withDescription("Explicit model slug."), Flag.optional),
  effort: Flag.string("effort").pipe(
    Flag.withDescription("Provider effort/reasoning-effort option."),
    Flag.optional,
  ),
  instance: Flag.string("instance").pipe(
    Flag.withDescription("Explicit provider instance id."),
    Flag.optional,
  ),
  newWorktree: Flag.boolean("new-worktree").pipe(
    Flag.withDescription(
      "Start the thread in a fresh worktree created by the server (with the project setup script).",
    ),
    Flag.withDefault(false),
  ),
  worktree: Flag.string("worktree").pipe(
    Flag.withDescription(
      "Start the thread in an existing worktree at this path (see `git worktree list`).",
    ),
    Flag.optional,
  ),
  branch: Flag.string("branch").pipe(
    Flag.withDescription(
      "With --new-worktree: name for the new branch (default: temporary name, auto-renamed from the thread title). With --worktree: assert the worktree's checked-out branch (detected automatically when omitted).",
    ),
    Flag.optional,
  ),
  base: Flag.string("base").pipe(
    Flag.withDescription("Base ref for --new-worktree (default: the project's current branch)."),
    Flag.optional,
  ),
  startFromOrigin: Flag.boolean("start-from-origin").pipe(
    Flag.withDescription("Base the new worktree on origin/<base> instead of the local ref."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a thread and start its first turn."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const message = yield* requireTrimmedMessage(flags.message);
        const workspace = yield* resolveThreadCliWorkspaceSelection(flags);
        const project = yield* findActiveProjectTarget({
          projects: input.live.shell.projects,
          identifier: flags.project,
        });
        const projectShell = input.live.shell.projects.find((item) => item.id === project.id)!;
        // Validate the worktree before any further server round-trips so a
        // mistyped path fails fast.
        const existingWorktree =
          workspace.mode === "existing-worktree"
            ? yield* resolveExistingWorktree({
                rawPath: workspace.worktreePath,
                projectWorkspaceRoot: projectShell.workspaceRoot,
                expectedBranch: workspace.branch,
              })
            : null;
        const hasExplicitTitle = Option.isSome(flags.title);
        const title = hasExplicitTitle
          ? yield* requireTrimmedTitle(flags.title.value)
          : deriveThreadCliTitle(message);
        const hasModelFlags =
          Option.isSome(flags.model) ||
          Option.isSome(flags.effort) ||
          Option.isSome(flags.instance);
        if (Option.isNone(flags.model) && Option.isSome(flags.effort)) {
          return yield* new SessionCliError({
            operation: "resolveModelSelection",
            detail: "--effort requires --model for t3 thread new.",
          });
        }
        if (Option.isNone(flags.model) && Option.isSome(flags.instance)) {
          return yield* new SessionCliError({
            operation: "resolveModelSelection",
            detail: "--instance requires --model for t3 thread new.",
          });
        }
        const descriptor =
          hasModelFlags || workspace.mode === "new-worktree"
            ? yield* fetchLiveEnvironmentDescriptor(input.live.origin, input.timeouts)
            : null;
        if (
          workspace.mode === "new-worktree" &&
          descriptor?.capabilities.turnStartBootstrap !== true
        ) {
          return yield* new SessionCliServerUnsupportedError({
            serverVersion: descriptor?.serverVersion ?? "unknown",
            capability: "turnStartBootstrap",
          });
        }
        const explicitModelSelection = hasModelFlags
          ? yield* Effect.gen(function* () {
              if (descriptor === null || descriptor.capabilities.providerCatalog !== true) {
                return yield* new SessionCliServerUnsupportedError({
                  serverVersion: descriptor?.serverVersion ?? "unknown",
                  capability: "providerCatalog",
                });
              }
              const catalog = yield* fetchProviderCatalog(input.live.origin, input.token);
              const instance = yield* resolveThreadModelInstance({
                catalog,
                model: flags.model.pipe(Option.getOrThrow),
                ...(Option.isSome(flags.instance)
                  ? { explicitInstanceId: flags.instance.value }
                  : {}),
              });
              return yield* resolveCliModelSelection({
                instance,
                explicitModel: flags.model.pipe(Option.getOrThrow),
                ...(Option.isSome(flags.effort) ? { effort: flags.effort.value } : {}),
              });
            })
          : undefined;
        const modelSelection =
          explicitModelSelection ??
          projectShell.defaultModelSelection ??
          ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection();
        const threadId = ThreadId.make(yield* randomUuid);
        const commandId = CommandId.make(yield* randomUuid);
        const messageId = MessageId.make(yield* randomUuid);
        const createdAt = DateTime.formatIso(yield* DateTime.now);

        if (workspace.mode === "new-worktree") {
          const worktreeBranchToken = yield* randomUuid;
          const worktreeBranch =
            workspace.branch ?? buildTemporaryWorktreeBranchName(() => worktreeBranchToken);
          const result = yield* dispatchThreadCommand(
            input,
            {
              type: "thread.turn.start",
              commandId,
              threadId,
              message: { messageId, role: "user", text: message, attachments: [] },
              modelSelection,
              ...(hasExplicitTitle ? { titlePinned: true } : { titleSeed: title }),
              runtimeMode: flags.runtimeMode,
              interactionMode: flags.interactionMode,
              bootstrap: buildNewWorktreeBootstrap({
                project: projectShell,
                title,
                modelSelection,
                runtimeMode: flags.runtimeMode,
                interactionMode: flags.interactionMode,
                workspace,
                worktreeBranch,
                createdAt,
              }),
              createdAt,
            },
            { timeoutMilliseconds: BOOTSTRAP_DISPATCH_TIMEOUT_MS },
          );
          // Resolve the created worktree from a fresh shell snapshot; the
          // thread started either way, so a failed read only degrades output.
          const startedThread = yield* fetchLiveOrchestrationShell(
            input.live.origin,
            input.token,
            input.timeouts,
          ).pipe(
            Effect.map((shell) => shell.threads.find((thread) => thread.id === threadId) ?? null),
            Effect.orElseSucceed(() => null),
          );
          yield* Console.log(
            flags.json
              ? jsonOutput({
                  threadId,
                  projectId: project.id,
                  createCommandId: null,
                  commandId,
                  messageId,
                  sequence: result.sequence,
                  workspace: {
                    mode: "new-worktree",
                    branch: startedThread?.branch ?? null,
                    worktreePath: startedThread?.worktreePath ?? null,
                  },
                })
              : `Created thread ${threadId} (${title}) in a new worktree${
                  startedThread?.worktreePath ? ` at ${startedThread.worktreePath}` : ""
                }${
                  startedThread?.branch ? ` on branch ${startedThread.branch}` : ""
                } and started its first turn.`,
          );
          return;
        }

        const createCommandId = CommandId.make(yield* randomUuid);
        yield* dispatchThreadCommand(input, {
          type: "thread.create",
          commandId: createCommandId,
          threadId,
          projectId: project.id,
          title,
          modelSelection,
          runtimeMode: flags.runtimeMode,
          interactionMode: flags.interactionMode,
          branch: existingWorktree?.branch ?? null,
          worktreePath: existingWorktree?.worktreePath ?? null,
          createdAt,
        });
        const result = yield* dispatchThreadCommand(input, {
          type: "thread.turn.start",
          commandId,
          threadId,
          message: { messageId, role: "user", text: message, attachments: [] },
          modelSelection,
          ...(hasExplicitTitle ? { titlePinned: true } : { titleSeed: title }),
          runtimeMode: flags.runtimeMode,
          interactionMode: flags.interactionMode,
          createdAt,
        }).pipe(
          Effect.catch((error) => {
            if (isCliOrchestrationOutcomeUnknownError(error)) return Effect.fail(error);
            return randomUuid.pipe(
              Effect.map(CommandId.make),
              Effect.flatMap((cleanupCommandId) =>
                compensateFailedThreadStart(
                  error,
                  dispatchThreadCommand(input, {
                    type: "thread.delete",
                    commandId: cleanupCommandId,
                    threadId,
                  }),
                ),
              ),
            );
          }),
        );
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId,
                projectId: project.id,
                createCommandId,
                commandId,
                messageId,
                sequence: result.sequence,
                workspace:
                  existingWorktree !== null
                    ? {
                        mode: "existing-worktree",
                        branch: existingWorktree.branch,
                        worktreePath: existingWorktree.worktreePath,
                      }
                    : { mode: "checkout", branch: null, worktreePath: null },
              })
            : existingWorktree !== null
              ? `Created thread ${threadId} (${title}) in worktree ${existingWorktree.worktreePath}${
                  existingWorktree.branch ? ` on branch ${existingWorktree.branch}` : ""
                } and started its first turn.`
              : `Created thread ${threadId} (${title}) and started its first turn.`,
        );
      }),
    ),
  ),
);

const threadSendCommand = Command.make("send", {
  ...projectLocationFlags,
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id.")),
  message: Flag.string("message").pipe(Flag.withDescription("User message.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Send a message to a thread, steering it when already running."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(input.live, flags.threadId);
        const message = yield* requireTrimmedMessage(flags.message);
        const commandId = CommandId.make(yield* randomUuid);
        const messageId = MessageId.make(yield* randomUuid);
        const result = yield* dispatchThreadCommand(input, {
          type: "thread.turn.start",
          commandId,
          threadId: thread.id,
          message: { messageId, role: "user", text: message, attachments: [] },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId: thread.id,
                commandId,
                messageId,
                sequence: result.sequence,
                action: threadCliState(thread) === "running" ? "steered" : "started",
              })
            : `${threadCliState(thread) === "running" ? "Steered" : "Started"} thread ${thread.id}.`,
        );
      }),
    ),
  ),
);

const threadRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id.")),
  title: Argument.string("title").pipe(Argument.withDescription("New thread title.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Rename a thread."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(input.live, flags.threadId);
        const title = yield* requireTrimmedTitle(flags.title);
        if (title === thread.title) {
          yield* Console.log(
            flags.json
              ? jsonOutput({ threadId: thread.id, title, action: "unchanged" })
              : `Thread ${thread.id} is already named ${title}.`,
          );
          return;
        }
        const commandId = CommandId.make(yield* randomUuid);
        const result = yield* dispatchThreadCommand(input, {
          type: "thread.meta.update",
          commandId,
          threadId: thread.id,
          title,
        });
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId: thread.id,
                title,
                previousTitle: thread.title,
                commandId,
                sequence: result.sequence,
                action: "renamed",
              })
            : `Renamed thread ${thread.id} to ${title}.`,
        );
      }),
    ),
  ),
);

const threadInterruptCommand = Command.make("interrupt", {
  ...projectLocationFlags,
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Interrupt the active turn in a thread."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(input.live, flags.threadId);
        if (!threadHasActiveTurn(thread)) {
          return yield* new ThreadCliNoActiveTurnError({
            operation: "interruptThread",
            threadId: thread.id,
          });
        }
        const commandId = CommandId.make(yield* randomUuid);
        const result = yield* dispatchThreadCommand(input, {
          type: "thread.turn.interrupt",
          commandId,
          threadId: thread.id,
          ...(thread.latestTurn?.state === "running" ? { turnId: thread.latestTurn.turnId } : {}),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId: thread.id,
                commandId,
                sequence: result.sequence,
                action: "interrupt-requested",
              })
            : `Requested interruption for thread ${thread.id}.`,
        );
      }),
    ),
  ),
);

const threadStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show thread status."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, ({ live }) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(live, flags.threadId);
        const summary = threadSummary(thread);
        yield* Console.log(
          flags.json
            ? jsonOutput(summary)
            : [
                `${summary.id}\t${summary.state}\t${summary.title}`,
                `Project: ${summary.projectId}`,
                ...(summary.worktreePath ? [`Worktree: ${summary.worktreePath}`] : []),
                ...(summary.branch ? [`Branch: ${summary.branch}`] : []),
                `Session: ${summary.sessionStatus ?? "not started"}`,
                `Snoozed: ${
                  summary.snoozedUntil
                    ? `until ${summary.snoozedUntil}`
                    : summary.snoozedAt
                      ? "until woken"
                      : "no"
                }`,
                `Pending approval: ${summary.hasPendingApprovals ? "yes" : "no"}`,
                `Pending input: ${summary.hasPendingUserInput ? "yes" : "no"}`,
              ].join("\n"),
        );
      }),
    ),
  ),
);

const threadArchiveCommand = Command.make("archive", {
  ...projectLocationFlags,
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Archive a thread."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(input.live, flags.threadId);
        const commandId = CommandId.make(yield* randomUuid);
        yield* dispatchThreadCommand(input, {
          type: "thread.archive",
          commandId,
          threadId: thread.id,
        });
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId: thread.id,
                action: "archived",
              })
            : `Archived thread ${thread.id}.`,
        );
      }),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Manage threads and agent turns."),
  Command.withSubcommands([
    threadListCommand,
    threadNewCommand,
    threadSendCommand,
    threadRenameCommand,
    threadInterruptCommand,
    threadStatusCommand,
    threadArchiveCommand,
  ]),
);
