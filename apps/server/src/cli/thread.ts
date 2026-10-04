import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  RuntimeMode,
  RuntimeRequestId,
  ServerSettings,
  T3_PROJECT_FILE_NAME,
  ThreadId,
  type ThreadEnvMode,
} from "@t3tools/contracts";
// Pure presentation and key math shared with the clients; bundled into the CLI
// like every workspace package.
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  pinOrderKeyBetween,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import { backgroundWorkLiveness } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  threadGroupId,
  threadGroupSections,
  visibleThreadGroups,
} from "@t3tools/shared/threadGroups";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag, Param, Primitive } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeOS from "node:os";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  type CliAuthLocationFlags,
  DurationFromString,
  projectLocationFlags,
  resolveCliAuthConfig,
} from "./config.ts";
import { withCliJsonErrorOutput } from "./errorOutput.ts";
import {
  CliOrchestrationOutcomeUnknownError,
  CliOrchestrationServerUnavailableError,
  type CliLiveOrchestrationServer,
  type CliLiveServerReadTimeouts,
  fetchLiveEnvironmentDescriptor,
  fetchLiveOrchestrationShell,
  fetchLiveServerSettings,
  fetchLiveThreadBoundedSnapshot,
  fetchLiveThreadHistoryPage,
  isProcessAlive,
  resolveCliLiveServerReadTimeouts,
  withResolvedLiveOrchestrationServer,
} from "./orchestration.ts";
import {
  awaitLaunchedThread,
  cancelLiveThreadArchive,
  type CliLiveRpcClient,
  dispatchLiveThreadCommand,
  fetchLiveThreadProjection,
  launchLiveThread,
  scheduleLiveThreadArchive,
  subscribeLiveShell,
  withLiveOrchestrationRpc,
} from "./orchestrationRpc.ts";
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
import { resolveThreadGroup } from "./threadGroups.ts";
import {
  collectThreadMessages,
  parseThreadMessagesCursor,
  renderThreadMessagesText,
  stripTerminalControlCharacters,
  THREAD_MESSAGE_ROLES,
  ThreadCliMessageCursorError,
  threadMessagesCursorMayBelongTo,
  threadMessagesReport,
} from "./threadMessages.ts";
import { THREAD_CLI_STATES, threadCliState, threadHasActiveTurn } from "./threadState.ts";
import {
  type ThreadInputResponseMode,
  type ThreadWaitDrainMode,
  type WaitForThreadResult,
  threadWaitExitCode,
  waitForThread,
} from "./threadWait.ts";

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

// One flag that accepts a bare `--drain` and an inline `--drain=agents|all`.
// It keeps the Boolean primitive tag so the parser treats a bare flag as
// "true" and never swallows the next positional as its value (a
// space-separated `--drain agents` stays an unexpected argument). Effect
// rc.112 registers `Flag.orElse` alternates, so a boolean and a choice flag
// sharing the name "drain" would now fail as a duplicate flag. No typeName:
// help then renders the Boolean tag as a bare `--drain`, and the description
// names the inline `=all` form.
const threadWaitDrainPrimitive: Primitive.Primitive<ThreadWaitDrainMode> = Object.assign(
  Object.create(Object.getPrototypeOf(Primitive.Boolean)),
  {
    _tag: "Boolean",
    parse: (value: string) =>
      value === "agents" || value === "all"
        ? Effect.succeed(value)
        : Effect.map(Primitive.Boolean.parse(value), (enabled) => (enabled ? "agents" : null)),
  },
);

export const threadWaitDrainFlag = Param.makeSingle({
  kind: Param.flagKind,
  name: "drain",
  primitiveType: threadWaitDrainPrimitive,
}).pipe(
  Flag.withDefault(null),
  Flag.withDescription(
    "After the turn settles, wait for background agents/workflows (same as --drain=agents); use --drain=all to include monitors.",
  ),
);

const jsonOutput = (value: unknown) => JSON.stringify(value, null, 2);

export class ThreadCliNotFoundError extends Schema.TaggedError<ThreadCliNotFoundError>()(
  "ThreadCliNotFoundError",
  {
    operation: Schema.Literal("resolveThread"),
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return this.threadId === "self" && !process.env.T3CODE_THREAD_ID?.trim()
      ? "self requires T3CODE_THREAD_ID. Pass an explicit thread id outside a provider session."
      : `No active thread found for '${this.threadId}'.`;
  }
}

export class ThreadCliInputRequestNotPendingError extends Schema.TaggedError<ThreadCliInputRequestNotPendingError>()(
  "ThreadCliInputRequestNotPendingError",
  {
    operation: Schema.Literal("respondToInput"),
    threadId: Schema.String,
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Thread '${this.threadId}' has no unanswered question '${this.requestId}'. List them with \`t3 thread input list ${this.threadId}\`.`;
  }
}

export class ThreadCliMessageEmptyError extends Schema.TaggedError<ThreadCliMessageEmptyError>()(
  "ThreadCliMessageEmptyError",
  {
    operation: Schema.Literal("validateMessage"),
  },
) {
  override get message(): string {
    return "Thread message cannot be empty.";
  }
}

export class ThreadCliTitleEmptyError extends Schema.TaggedError<ThreadCliTitleEmptyError>()(
  "ThreadCliTitleEmptyError",
  {
    operation: Schema.Literal("validateTitle"),
  },
) {
  override get message(): string {
    return "Thread title cannot be empty.";
  }
}

export class ThreadCliNoActiveTurnError extends Schema.TaggedError<ThreadCliNoActiveTurnError>()(
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

export class ThreadCliWorkspaceFlagError extends Schema.TaggedError<ThreadCliWorkspaceFlagError>()(
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

export class ThreadCliWorktreePathError extends Schema.TaggedError<ThreadCliWorktreePathError>()(
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

/** Where `t3 thread new` starts the thread: the configured default (no
    explicit workspace flag), the project checkout as-is, a fresh
    server-created worktree, or an existing worktree by path. */
export type ThreadCliWorkspaceSelection =
  | { readonly mode: "default" }
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
  readonly checkout: boolean;
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
  if (flags.checkout && flags.newWorktree) {
    return fail("--checkout and --new-worktree cannot be combined.");
  }
  if (flags.checkout && Option.isSome(worktree)) {
    return fail("--checkout and --worktree cannot be combined.");
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
  return Effect.succeed({ mode: flags.checkout ? "checkout" : "default" });
};

const decodeServerSettingsJsonExit = Schema.decodeUnknownExit(fromLenientJson(ServerSettings));

// Read the settings.json of the selected T3 data directory — the same file
// the target server serves to clients. Missing or malformed files resolve to
// the schema defaults, mirroring the server's own loader.
const readThreadDefaultSettings = Effect.fn("readThreadDefaultSettings")(function* (
  settingsPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => null));
  if (raw === null) return DEFAULT_SERVER_SETTINGS;
  const decoded = decodeServerSettingsJsonExit(raw);
  return Exit.isSuccess(decoded) ? decoded.value : DEFAULT_SERVER_SETTINGS;
});

// Read the project's checked-in t3.json. Missing, unreadable, or invalid
// files resolve to null, like the app clients.
const readT3ProjectFile = Effect.fn("readT3ProjectFile")(function* (workspaceRoot: string) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(path.join(workspaceRoot, T3_PROJECT_FILE_NAME))
    .pipe(Effect.orElseSucceed(() => null));
  if (contents === null) return null;
  return parseT3ProjectFile(contents);
});

/** Resolve where a thread starts when no explicit workspace flag was passed.
    Routes through the shared resolver so the CLI cannot disagree with the
    web/mobile priority order: per-project setting > environment setting >
    checked-in t3.json > built-in default. A worktree default
    also honors the "new worktrees start from origin" server setting, matching
    the app's new-thread flow. */
export const resolveThreadCliDefaultWorkspace = Effect.fn("resolveThreadCliDefaultWorkspace")(
  function* (input: {
    readonly projectSetting: ThreadEnvMode | null | undefined;
    readonly workspaceRoot: string;
    readonly settingsPath: string;
    readonly settings?: ServerSettings;
  }) {
    const settings = input.settings ?? (yield* readThreadDefaultSettings(input.settingsPath));
    const projectFile = yield* readT3ProjectFile(input.workspaceRoot);
    const envMode = resolveProjectSettings(
      input.projectSetting == null
        ? settings
        : { ...settings, defaultThreadEnvMode: input.projectSetting },
      null,
      null,
      projectFile,
    ).settings.defaultThreadEnvMode;
    return envMode === "worktree"
      ? {
          mode: "new-worktree" as const,
          base: null,
          branch: null,
          startFromOrigin: settings.newWorktreesStartFromOrigin,
        }
      : { mode: "checkout" as const };
  },
);

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

export const decodeThreadInputAnswersJson = Schema.decodeUnknownEffect(
  fromLenientJson(ProviderUserInputAnswers),
);

export const deriveThreadCliTitle = (message: string): string => {
  const compact = message.trim().replace(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
};

// A new worktree is created (and optionally fetched from the remote) after the
// launch is acknowledged; `thread new` waits this long for its path, which can
// take minutes on large repositories.
const WORKTREE_PREPARATION_TIMEOUT = Duration.minutes(3);

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

const groupReport = (group: { readonly id: string; readonly name: string } | null) =>
  group === null ? null : { id: group.id, name: group.name };

const threadGroupFlag = Flag.String("group").pipe(
  Flag.withDescription(
    "Group id or name. An exact name wins; otherwise the name may skip emoji and differ in spacing or case when only one group fits.",
  ),
  Flag.optional,
);

export class ThreadCliLaunchError extends Schema.TaggedError<ThreadCliLaunchError>()(
  "ThreadCliLaunchError",
  {
    operation: Schema.Literal("launchThread"),
    threadId: Schema.String,
    reason: Schema.Literals(["preparation-failed", "preparation-pending"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.reason === "preparation-failed"
      ? `Thread '${this.threadId}' was created, but its workspace could not be prepared: ${this.detail}`
      : `Thread '${this.threadId}' was created, but its worktree was not ready within ${this.detail}. Check it with \`t3 thread status ${this.threadId}\`.`;
  }
}

// Presentation helpers want an environment id; the CLI only reads the one
// server it talks to.
const CLI_ENVIRONMENT_ID = EnvironmentId.make("cli");

const requestedThreadId = (rawThreadId: string): string =>
  rawThreadId.trim() === "self" ? (process.env.T3CODE_THREAD_ID?.trim() ?? "") : rawThreadId.trim();

/** Finds `<thread-id|self>`; `self` is the provider session's T3CODE_THREAD_ID. */
export const findThread = (
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  rawThreadId: string,
): OrchestrationV2ThreadShell | undefined => {
  const threadId = requestedThreadId(rawThreadId);
  return threadId.length === 0 ? undefined : threads.find((thread) => thread.id === threadId);
};

const threadNotFound = (rawThreadId: string) =>
  new ThreadCliNotFoundError({ operation: "resolveThread", threadId: rawThreadId });

const resolveThread = (
  live: CliLiveOrchestrationServer,
  rawThreadId: string,
): Effect.Effect<OrchestrationV2ThreadShell, ThreadCliNotFoundError> => {
  const thread = findThread(
    live.shell.threads.filter((candidate) => candidate.archivedAt === null),
    rawThreadId,
  );
  return thread ? Effect.succeed(thread) : Effect.fail(threadNotFound(rawThreadId));
};

type ThreadArchiveTarget = Pick<
  OrchestrationV2ThreadShell,
  "id" | "archivedAt" | "archiveRequest" | "activeRunId" | "status"
>;

/** Like resolveThread, but also finds archived threads (one bounded thread read). */
const resolveThreadIncludingArchived = Effect.fn("resolveThreadIncludingArchived")(function* (
  input: ThreadCliInput,
  rawThreadId: string,
) {
  const active: ThreadArchiveTarget | undefined = findThread(
    input.live.shell.threads.filter((candidate) => candidate.archivedAt === null),
    rawThreadId,
  );
  if (active) return active;
  const threadId = requestedThreadId(rawThreadId);
  if (threadId.length === 0) return yield* threadNotFound(rawThreadId);
  const snapshot = yield* fetchLiveThreadBoundedSnapshot(
    input.live.origin,
    input.token,
    ThreadId.make(threadId),
    input.timeouts,
  ).pipe(
    Effect.catchTag("CliOrchestrationThreadNotFoundError", () =>
      Effect.fail(threadNotFound(rawThreadId)),
    ),
  );
  const thread = snapshot.projection.thread;
  if (thread.deletedAt != null) return yield* threadNotFound(rawThreadId);
  // Only archived threads reach here; they have no active run to steer, and
  // the server resolves the send against its own thread state anyway.
  const target: ThreadArchiveTarget = {
    id: thread.id,
    archivedAt: thread.archivedAt,
    archiveRequest: thread.archiveRequest,
    activeRunId: null,
    status: "idle",
  };
  return target;
});

const isoOrNull = (value: DateTime.Utc | null | undefined): string | null =>
  value == null ? null : DateTime.formatIso(value);

/** The fork's nested archive request JSON: `turnId` names the awaited run and
    `removeWorktree` is always present. */
export const cliArchiveRequest = (request: OrchestrationV2ThreadShell["archiveRequest"]) => {
  if (!request) return null;
  const { runId, removeWorktree, ...rest } = request;
  return { ...rest, turnId: runId, removeWorktree: removeWorktree === true };
};

/** The fork's nested worktree switch JSON, with `turnId` for the awaited run. */
export const cliWorktreeSwitch = (worktreeSwitch: OrchestrationV2ThreadShell["worktreeSwitch"]) => {
  if (!worktreeSwitch) return null;
  const { runId, ...rest } = worktreeSwitch;
  return { ...rest, turnId: runId };
};

/** The fork's thread summary JSON, read from the v2 shell. Run ids fill the
    fields the fork named after turns (`activeTurnId`, `snoozedUntilTurnId`).
    `responseMode` is the pending question's mode when known; an unknown mode
    counts as blocking. */
export const threadSummary = (
  thread: OrchestrationV2ThreadShell,
  responseMode?: ThreadInputResponseMode | null,
) => {
  const presented = presentThreadShell(CLI_ENVIRONMENT_ID, thread);
  return {
    archiveRequest: cliArchiveRequest(thread.archiveRequest),
    worktreeSwitch: cliWorktreeSwitch(thread.worktreeSwitch),
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    state: threadCliState(thread),
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    sessionStatus: presented.runtime?.status ?? null,
    activeTurnId: thread.activeRunId,
    backgroundLiveness: backgroundWorkLiveness(thread.pendingBackgroundTasks ?? []),
    snoozedUntil: presented.snoozedUntil,
    snoozedAt: presented.snoozedAt,
    snoozedUntilTurnId: thread.snoozedUntilRunId ?? null,
    pinnedAt: presented.pinnedAt,
    customGroupId: thread.customGroupId ?? null,
    settled: thread.settledOverride === "settled",
    settledAt: presented.settledAt,
    hasPendingApprovals: presented.hasPendingApprovals,
    hasPendingUserInput: presented.hasPendingUserInput,
    hasPendingBlockingUserInput:
      thread.pendingRuntimeRequest?.kind === "user_input" && responseMode !== "message",
    latestUserMessageAt: presented.latestUserMessageAt,
    updatedAt: presented.updatedAt,
  };
};

/** What the clients show for the snooze: the fields persist after a derived
    wake (timer passed, work finished, a raised hand). */
export const threadSnoozeText = (thread: OrchestrationV2ThreadShell, now: string): string => {
  const presented = presentThreadShell(CLI_ENVIRONMENT_ID, thread);
  if (!effectiveSnoozed(presented, { now })) return "no";
  if (presented.snoozedUntil) return `until ${presented.snoozedUntil}`;
  return thread.snoozedUntilRunId ? "until done" : "until woken";
};

interface ThreadCliInput {
  readonly live: CliLiveOrchestrationServer;
  readonly token: string;
  readonly timeouts: CliLiveServerReadTimeouts;
  readonly settingsPath: string;
  readonly attachmentsDir: string;
}

const runThreadCli = Effect.fn("runThreadCli")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  json: boolean,
  run: (input: ThreadCliInput) => Effect.Effect<A, E, R>,
  // Machine-consumed stdout (`--shell`) must stay free of log lines even when
  // errors keep their human formatting.
  options?: { readonly suppressLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  return yield* Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = json || options?.suppressLogs ? "None" : config.logLevel;
    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const timeouts = yield* resolveCliLiveServerReadTimeouts(flags.timeoutMs ?? Option.none());
      const outcome = yield* withResolvedLiveOrchestrationServer(
        { environmentAuth, config, label: "t3 thread cli", timeouts },
        (live, token) =>
          run({
            live,
            token,
            timeouts,
            settingsPath: config.settingsPath,
            attachmentsDir: config.attachmentsDir,
          }),
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

const withRpc = <A, E, R>(
  input: ThreadCliInput,
  use: (client: CliLiveRpcClient) => Effect.Effect<A, E, R>,
) =>
  withLiveOrchestrationRpc(
    { origin: input.live.origin, token: input.token, timeouts: input.timeouts },
    use,
  );

const newCommandId = randomUuid.pipe(Effect.map(CommandId.make));

/** How a pending question is answered, from its request entity (which every
    projection carries in full, unlike the windowed timeline items); null
    once it is no longer pending. */
export const userInputResponseMode = (
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests">,
  requestId: RuntimeRequestId,
): ThreadInputResponseMode | null => {
  const request = projection.runtimeRequests.find((candidate) => candidate.id === requestId);
  if (request?.kind !== "user_input" || request.status !== "pending") return null;
  return request.responseCapability.type === "message" ? "message" : "blocking";
};

const fetchUserInputResponseMode = (
  client: CliLiveRpcClient,
  input: ThreadCliInput,
  threadId: ThreadId,
  requestId: RuntimeRequestId,
) =>
  fetchLiveThreadProjection(client, threadId, input.timeouts).pipe(
    Effect.map((projection) => userInputResponseMode(projection, requestId)),
  );

/** Response modes of the threads' pending questions, read only for threads
    that have one. A mode that cannot be read stays unknown (blocking). */
const fetchPendingQuestionModes = (
  input: ThreadCliInput,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
) => {
  const asking = threads.flatMap((thread) =>
    thread.pendingRuntimeRequest?.kind === "user_input"
      ? [{ threadId: thread.id, requestId: thread.pendingRuntimeRequest.id }]
      : [],
  );
  if (asking.length === 0) {
    return Effect.succeed(new Map<ThreadId, ThreadInputResponseMode | null>());
  }
  return withRpc(input, (client) =>
    Effect.forEach(
      asking,
      ({ threadId, requestId }) =>
        fetchUserInputResponseMode(client, input, threadId, requestId).pipe(
          Effect.orElseSucceed(() => null),
          Effect.map((mode) => [threadId, mode] as const),
        ),
      { concurrency: 4 },
    ),
  ).pipe(
    Effect.map((entries) => new Map(entries)),
    Effect.orElseSucceed(() => new Map<ThreadId, ThreadInputResponseMode | null>()),
  );
};

type ThreadCliCapability = "threadCustomGroups" | "threadCustomGroupCreation" | "threadPinning";

// Version skew: never send a command to a server that does not advertise it.
const requireServerCapability = Effect.fn("requireServerCapability")(function* (
  input: ThreadCliInput,
  capability: ThreadCliCapability,
) {
  const descriptor = yield* fetchLiveEnvironmentDescriptor(input.live.origin, input.timeouts);
  if (descriptor.capabilities[capability] !== true) {
    return yield* new SessionCliServerUnsupportedError({
      serverVersion: descriptor.serverVersion,
      capability,
    });
  }
  return descriptor;
});

// A server without groups would decode an empty catalog and every lookup
// would read as "no such group", so reads are gated like the mutations.
const fetchThreadGroupCatalog = Effect.fn("fetchThreadGroupCatalog")(function* (
  input: ThreadCliInput,
) {
  yield* requireServerCapability(input, "threadCustomGroups");
  const settings = yield* fetchLiveServerSettings(input.live.origin, input.token, input.timeouts);
  return settings.threadGroups;
});

/** Key that sorts before every arranged pinned thread, so a CLI pin lands at
    the top of the run like every client pin path. Undefined (keyless) when
    key math can't produce one — pinning must never fail on placement. */
export function topOfPinnedRunOrderKey(
  threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "pinnedAt" | "pinOrderKey">>,
): string | undefined {
  let firstKey: string | null = null;
  for (const thread of threads) {
    if (thread.pinnedAt == null || thread.pinOrderKey == null) continue;
    if (firstKey === null || thread.pinOrderKey < firstKey) firstKey = thread.pinOrderKey;
  }
  return pinOrderKeyBetween(null, firstKey) ?? undefined;
}

const sortPinnedThreads = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
  sortPinnedThreadsByOrderKey(
    threads.map((thread) => ({
      id: thread.id,
      createdAt: DateTime.formatIso(thread.createdAt),
      pinOrderKey: thread.pinOrderKey ?? null,
      thread,
    })),
  ).map((entry) => entry.thread);

const threadIdArgument = Argument.String("thread-id").pipe(
  Argument.withDescription("Thread id, or self inside a provider session."),
);

const threadListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Filter by project id or workspace root."),
    Flag.optional,
  ),
  state: Flag.Literals("state", THREAD_CLI_STATES).pipe(
    Flag.withDescription("Filter by latest turn state."),
    Flag.optional,
  ),
  pinned: Flag.Boolean("pinned").pipe(
    Flag.withDescription("Only pinned threads, in their pinned order."),
    Flag.withDefault(false),
  ),
  group: threadGroupFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active threads."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const { live } = input;
        const project = Option.isSome(flags.project)
          ? yield* findActiveProjectTarget({
              projects: live.shell.projects,
              identifier: flags.project.value,
            })
          : null;
        const requestedState = Option.getOrNull(flags.state);
        const groupQuery = Option.getOrNull(flags.group);
        const groupFilter =
          groupQuery === null
            ? null
            : yield* Effect.gen(function* () {
                const catalog = yield* fetchThreadGroupCatalog(input);
                const group = yield* resolveThreadGroup(catalog, groupQuery);
                return { catalog, groupId: group.id };
              });
        const matching = live.shell.threads
          .filter((thread) => thread.archivedAt === null)
          .filter((thread) => project === null || thread.projectId === project.id)
          .filter((thread) => requestedState === null || threadCliState(thread) === requestedState)
          .filter((thread) => !flags.pinned || thread.pinnedAt != null)
          .filter(
            (thread) =>
              groupFilter === null ||
              threadGroupId(thread, groupFilter.catalog) === groupFilter.groupId,
          );
        const ordered = flags.pinned ? sortPinnedThreads(matching) : matching;
        const modes = yield* fetchPendingQuestionModes(input, ordered);
        const threads = ordered.map((thread) => threadSummary(thread, modes.get(thread.id)));
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

// Without an explicit --base, a new worktree branches from the project
// checkout's current branch (HEAD when detached), like the app's default.
const resolveCurrentBranch = Effect.fn("resolveCurrentBranch")(function* (workspaceRoot: string) {
  const head = yield* runGitCommand(workspaceRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return head.exitCode === 0 && head.stdout.length > 0 ? head.stdout : "HEAD";
});

/** Maps the CLI workspace pick to v2's launch strategy. */
export const launchWorkspaceStrategy = (input: {
  readonly workspace: Exclude<
    ThreadCliWorkspaceSelection,
    { mode: "default" | "existing-worktree" }
  >;
  readonly baseRef: string;
}): OrchestrationV2ThreadLaunchWorkspaceStrategy =>
  input.workspace.mode === "checkout"
    ? { type: "root" }
    : {
        type: "worktree",
        baseRef: input.workspace.base ?? input.baseRef,
        ...(input.workspace.branch !== null ? { branch: input.workspace.branch } : {}),
        ...(input.workspace.startFromOrigin ? { startFromOrigin: true } : {}),
      };

/** Where the created thread runs: a Scratch project's root launch gets a
    folder of its own, so a path there is not a worktree. */
export const createdThreadWorkspace = (
  mode: Exclude<ThreadCliWorkspaceSelection["mode"], "default">,
  thread: Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath">,
) => ({
  mode: mode === "checkout" && thread.worktreePath !== null ? ("scratch" as const) : mode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
});

const threadNewCommand = Command.make("new", {
  ...projectLocationFlags,
  project: Flag.String("project").pipe(Flag.withDescription("Project id or workspace root.")),
  message: Flag.String("message").pipe(Flag.withDescription("Initial user message.")),
  title: Flag.String("title").pipe(Flag.withDescription("Optional thread title."), Flag.optional),
  runtimeMode: Flag.Literals("runtime-mode", RuntimeMode.literals).pipe(Flag.optional),
  interactionMode: Flag.Literals("interaction-mode", ProviderInteractionMode.literals).pipe(
    Flag.withDefault(DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  model: Flag.String("model").pipe(Flag.withDescription("Explicit model slug."), Flag.optional),
  effort: Flag.String("effort").pipe(
    Flag.withDescription("Provider effort/reasoning-effort option."),
    Flag.optional,
  ),
  instance: Flag.String("instance").pipe(
    Flag.withDescription("Explicit provider instance id."),
    Flag.optional,
  ),
  checkout: Flag.Boolean("checkout").pipe(
    Flag.withDescription(
      "Start the thread in the project checkout even when the configured default is a worktree.",
    ),
    Flag.withDefault(false),
  ),
  newWorktree: Flag.Boolean("new-worktree").pipe(
    Flag.withDescription(
      "Start the thread in a fresh worktree created by the server (with the project setup script).",
    ),
    Flag.withDefault(false),
  ),
  worktree: Flag.String("worktree").pipe(
    Flag.withDescription(
      "Start the thread in an existing worktree at this path (see `git worktree list`).",
    ),
    Flag.optional,
  ),
  branch: Flag.String("branch").pipe(
    Flag.withDescription(
      "With --new-worktree: name for the new branch (default: temporary name, auto-renamed from the thread title). With --worktree: assert the worktree's checked-out branch (detected automatically when omitted).",
    ),
    Flag.optional,
  ),
  base: Flag.String("base").pipe(
    Flag.withDescription("Base ref for --new-worktree (default: the project's current branch)."),
    Flag.optional,
  ),
  startFromOrigin: Flag.Boolean("start-from-origin").pipe(
    Flag.withDescription("Base the new worktree on origin/<base> instead of the local ref."),
    Flag.withDefault(false),
  ),
  group: threadGroupFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a thread and start its first turn."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const message = yield* requireTrimmedMessage(flags.message);
        const explicitWorkspace = yield* resolveThreadCliWorkspaceSelection(flags);
        const project = yield* findActiveProjectTarget({
          projects: input.live.shell.projects,
          identifier: flags.project,
        });
        const projectShell = input.live.shell.projects.find((item) => item.id === project.id)!;
        const liveSettings = yield* fetchLiveServerSettings(
          input.live.origin,
          input.token,
          input.timeouts,
        );
        const resolved = resolveProjectSettings(liveSettings, project.id, projectShell);
        const runtimeMode = Option.getOrElse(
          flags.runtimeMode,
          () => resolved.settings.defaultRuntimeMode,
        );
        // Without an explicit workspace flag the configured defaults decide,
        // like the app's new-thread flow: project > environment > t3.json >
        // built-in default.
        const workspace =
          explicitWorkspace.mode === "default"
            ? yield* resolveThreadCliDefaultWorkspace({
                projectSetting:
                  resolved.sources.defaultThreadEnvMode === "project"
                    ? resolved.settings.defaultThreadEnvMode
                    : null,
                settings: resolved.settings,
                workspaceRoot: projectShell.workspaceRoot,
                settingsPath: input.settingsPath,
              })
            : explicitWorkspace;
        // Validate the worktree before any further server round-trips so a
        // mistyped path fails fast.
        const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
          workspace.mode === "existing-worktree"
            ? yield* resolveExistingWorktree({
                rawPath: workspace.worktreePath,
                projectWorkspaceRoot: projectShell.workspaceRoot,
                expectedBranch: workspace.branch,
              }).pipe(
                Effect.map((existing) => ({
                  type: "existing_worktree" as const,
                  worktreePath: existing.worktreePath,
                  ...(existing.branch === null ? {} : { branch: existing.branch }),
                })),
              )
            : launchWorkspaceStrategy({
                workspace,
                baseRef:
                  workspace.mode === "new-worktree" && workspace.base === null
                    ? yield* resolveCurrentBranch(projectShell.workspaceRoot)
                    : "HEAD",
              });
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
          hasModelFlags || Option.isSome(flags.group)
            ? yield* fetchLiveEnvironmentDescriptor(input.live.origin, input.timeouts)
            : null;
        // Gate before resolving: a server without groups has an empty catalog,
        // which would misreport the missing capability as an unknown group.
        if (
          Option.isSome(flags.group) &&
          descriptor?.capabilities.threadCustomGroupCreation !== true
        ) {
          return yield* new SessionCliServerUnsupportedError({
            serverVersion: descriptor?.serverVersion ?? "unknown",
            capability: "threadCustomGroupCreation",
          });
        }
        const group = Option.isSome(flags.group)
          ? yield* resolveThreadGroup(liveSettings.threadGroups, flags.group.value)
          : null;
        const explicitModelSelection = hasModelFlags
          ? yield* Effect.gen(function* () {
              if (descriptor === null || descriptor.capabilities.providerCatalog !== true) {
                return yield* new SessionCliServerUnsupportedError({
                  serverVersion: descriptor?.serverVersion ?? "unknown",
                  capability: "providerCatalog",
                });
              }
              const model = Option.getOrThrow(flags.model);
              const catalog = yield* fetchProviderCatalog(input.live.origin, input.token);
              const instance = yield* resolveThreadModelInstance({
                catalog,
                model,
                ...(Option.isSome(flags.instance)
                  ? { explicitInstanceId: flags.instance.value }
                  : {}),
              });
              return yield* resolveCliModelSelection({
                instance,
                explicitModel: model,
                ...(Option.isSome(flags.effort) ? { effort: flags.effort.value } : {}),
              });
            })
          : undefined;
        // Same fallback chain as the app's new thread: project default, then
        // the server-wide default, then the built-in Codex model.
        const modelSelection =
          explicitModelSelection ??
          resolved.settings.defaultModelSelection ??
          ({
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          } satisfies ModelSelection);
        const threadId = ThreadId.make(yield* randomUuid);
        const commandId = yield* newCommandId;
        const messageId = MessageId.make(yield* randomUuid);

        const launched = yield* withRpc(input, (client) =>
          Effect.gen(function* () {
            yield* launchLiveThread(client, {
              commandId,
              threadId,
              projectId: project.id,
              title,
              generateTitle: !hasExplicitTitle,
              modelSelection,
              runtimeMode,
              interactionMode: flags.interactionMode,
              workspaceStrategy,
              ...(group === null ? {} : { customGroupId: group.id }),
              initialMessage: { messageId, text: message, attachments: [] },
            }).pipe(
              // A rejected launch can leave the claimed thread behind; delete
              // it so a rejection means nothing was created.
              Effect.catchTag("CliOrchestrationCommandRejectedError", (error) =>
                Effect.gen(function* () {
                  const shell = yield* fetchLiveOrchestrationShell(
                    input.live.origin,
                    input.token,
                    input.timeouts,
                  ).pipe(
                    Effect.mapError(
                      (cause) =>
                        new CliOrchestrationOutcomeUnknownError({
                          operation: "dispatchLiveServer",
                          cause,
                        }),
                    ),
                  );
                  if (!shell.threads.some((thread) => thread.id === threadId)) {
                    return yield* error;
                  }
                  return yield* compensateFailedThreadStart(
                    error,
                    Effect.flatMap(newCommandId, (cleanupCommandId) =>
                      dispatchLiveThreadCommand(client, {
                        type: "thread.delete",
                        commandId: cleanupCommandId,
                        threadId,
                      }),
                    ),
                  );
                }),
              ),
            );
            return yield* awaitLaunchedThread(client, {
              threadId,
              awaitWorktree: workspace.mode === "new-worktree",
              timeout: WORKTREE_PREPARATION_TIMEOUT,
              afterSequence: input.live.shell.snapshotSequence,
            });
          }),
        );
        if (Option.isNone(launched)) {
          return yield* new ThreadCliLaunchError({
            operation: "launchThread",
            threadId,
            reason: "preparation-pending",
            detail: `${Duration.toSeconds(WORKTREE_PREPARATION_TIMEOUT)}s`,
          });
        }
        const { thread, sequence } = launched.value;
        if (workspace.mode === "new-worktree" && thread.worktreePath === null) {
          return yield* new ThreadCliLaunchError({
            operation: "launchThread",
            threadId,
            reason: "preparation-failed",
            detail: thread.lastError ?? `the run ended as ${thread.status}`,
          });
        }
        const workspaceReport = createdThreadWorkspace(workspace.mode, thread);
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId,
                projectId: project.id,
                createCommandId: commandId,
                commandId: `${commandId}:initial-message`,
                messageId,
                sequence,
                group: groupReport(group),
                workspace: workspaceReport,
              })
            : `Created thread ${threadId} (${title})${
                workspaceReport.mode === "checkout"
                  ? ""
                  : workspaceReport.mode === "scratch"
                    ? ` in folder ${workspaceReport.worktreePath}`
                    : ` in ${workspaceReport.mode === "new-worktree" ? "a new worktree" : "worktree"} ${workspaceReport.worktreePath}`
              }${workspaceReport.branch ? ` on branch ${workspaceReport.branch}` : ""} and started its first turn.`,
        );
      }),
    ),
  ),
);

const threadSendCommand = Command.make("send", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
  message: Flag.String("message").pipe(Flag.withDescription("User message.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Send a message to a thread, steering it when already running. Messaging an archived thread unarchives it.",
  ),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const message = yield* requireTrimmedMessage(flags.message);
        const commandId = yield* newCommandId;
        const messageId = MessageId.make(yield* randomUuid);
        const thread = yield* resolveThreadIncludingArchived(input, flags.threadId);
        // The server resolves "auto" against its serialized thread state
        // (steer, queue, or start) and unarchives an archived thread.
        const result = yield* withRpc(input, (client) =>
          dispatchLiveThreadCommand(client, {
            type: "message.dispatch",
            commandId,
            threadId: thread.id,
            messageId,
            text: message,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            deliveryIntent: "auto",
            dispatchMode: threadHasActiveTurn(thread)
              ? { type: "queue_after_active" }
              : { type: "start_immediately" },
          }),
        );
        const action = threadHasActiveTurn(thread) ? "steered" : "started";
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId: thread.id,
                commandId,
                messageId,
                sequence: result.sequence,
                action,
              })
            : `${action === "steered" ? "Steered" : "Started"} thread ${thread.id}.`,
        );
      }),
    ),
  ),
);

const threadRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
  title: Argument.String("title").pipe(Argument.withDescription("New thread title.")),
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
        const commandId = yield* newCommandId;
        const result = yield* withRpc(input, (client) =>
          dispatchLiveThreadCommand(client, {
            type: "thread.metadata.update",
            commandId,
            threadId: thread.id,
            title,
          }),
        );
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

const threadMoveCommand = Command.make("move", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
  group: threadGroupFlag,
  active: Flag.Boolean("active").pipe(
    Flag.withDescription("Move the thread out of its custom group into Active."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Move a thread to a custom group, or back to Active."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        if (Option.isSome(flags.group) === flags.active) {
          return yield* new SessionCliError({
            operation: "thread.move",
            detail: "Pass exactly one of --group or --active.",
          });
        }
        const thread = yield* resolveThread(input.live, flags.threadId);
        const catalog = yield* fetchThreadGroupCatalog(input);
        const target = Option.isSome(flags.group)
          ? yield* resolveThreadGroup(catalog, flags.group.value)
          : null;
        const currentGroupId = threadGroupId(thread, catalog);
        const previous = catalog.find((group) => group.id === currentGroupId) ?? null;
        if (currentGroupId === (target?.id ?? null)) {
          yield* Console.log(
            flags.json
              ? jsonOutput({ threadId: thread.id, group: groupReport(target), action: "unchanged" })
              : `Thread ${thread.id} is already in ${target?.name ?? "Active"}.`,
          );
          return;
        }
        const commandId = yield* newCommandId;
        const result = yield* withRpc(input, (client) =>
          dispatchLiveThreadCommand(client, {
            type: "thread.custom-group.set",
            commandId,
            threadId: thread.id,
            customGroupId: target?.id ?? null,
          }),
        );
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId: thread.id,
                group: groupReport(target),
                previousGroup: groupReport(previous),
                commandId,
                sequence: result.sequence,
                action: "moved",
              })
            : `Moved thread ${thread.id} to ${target?.name ?? "Active"}.`,
        );
      }),
    ),
  ),
);

const makeThreadPinCommand = (pin: boolean) =>
  Command.make(pin ? "pin" : "unpin", {
    ...projectLocationFlags,
    threadId: threadIdArgument,
    json: jsonFlag,
  }).pipe(
    Command.withDescription(
      pin ? "Pin a thread at the top of the pinned threads." : "Unpin a thread.",
    ),
    Command.withHandler((flags) =>
      runThreadCli(flags, flags.json, (input) =>
        Effect.gen(function* () {
          const thread = yield* resolveThread(input.live, flags.threadId);
          const descriptor = yield* requireServerCapability(input, "threadPinning");
          // Pinning also un-settles and un-snoozes, so an already pinned
          // thread is only unchanged when there is nothing to promote.
          const promotes =
            pin &&
            (thread.settledOverride === "settled" ||
              thread.snoozedUntil != null ||
              thread.snoozedAt != null);
          if ((thread.pinnedAt != null) === pin && !promotes) {
            yield* Console.log(
              flags.json
                ? jsonOutput({ threadId: thread.id, action: "unchanged" })
                : `Thread ${thread.id} is already ${pin ? "pinned" : "unpinned"}.`,
            );
            return;
          }
          const commandId = yield* newCommandId;
          const orderKey =
            pin && descriptor.capabilities.threadPinReorder === true
              ? topOfPinnedRunOrderKey(input.live.shell.threads)
              : undefined;
          const result = yield* withRpc(input, (client) =>
            dispatchLiveThreadCommand(
              client,
              pin
                ? {
                    type: "thread.pin",
                    commandId,
                    threadId: thread.id,
                    ...(orderKey !== undefined ? { orderKey } : {}),
                  }
                : { type: "thread.unpin", commandId, threadId: thread.id },
            ),
          );
          const action = pin ? "pinned" : "unpinned";
          yield* Console.log(
            flags.json
              ? jsonOutput({ threadId: thread.id, commandId, sequence: result.sequence, action })
              : `${pin ? "Pinned" : "Unpinned"} thread ${thread.id}.`,
          );
        }),
      ),
    ),
  );

const threadInterruptCommand = Command.make("interrupt", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Interrupt the active turn in a thread."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(input.live, flags.threadId);
        if (!threadHasActiveTurn(thread) || thread.activeRunId === null) {
          return yield* new ThreadCliNoActiveTurnError({
            operation: "interruptThread",
            threadId: thread.id,
          });
        }
        const runId = thread.activeRunId;
        const commandId = yield* newCommandId;
        const result = yield* withRpc(input, (client) =>
          dispatchLiveThreadCommand(client, {
            type: "run.interrupt",
            commandId,
            threadId: thread.id,
            runId,
            holdQueue: true,
          }),
        );
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
  threadId: threadIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show thread status."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(input.live, flags.threadId);
        const modes = yield* fetchPendingQuestionModes(input, [thread]);
        const summary = threadSummary(thread, modes.get(thread.id));
        const snoozed = threadSnoozeText(thread, DateTime.formatIso(yield* DateTime.now));
        yield* Console.log(
          flags.json
            ? jsonOutput(summary)
            : [
                `${summary.id}\t${summary.state}\t${summary.title}`,
                `Project: ${summary.projectId}`,
                ...(summary.worktreePath ? [`Worktree: ${summary.worktreePath}`] : []),
                ...(summary.branch ? [`Branch: ${summary.branch}`] : []),
                `Session: ${summary.sessionStatus ?? "not started"}`,
                `Snoozed: ${snoozed}`,
                `Pending approval: ${summary.hasPendingApprovals ? "yes" : "no"}`,
                `Pending input: ${summary.hasPendingUserInput ? "yes" : "no"}`,
              ].join("\n"),
        );
      }),
    ),
  ),
);

/** The `thread wait --json` document: the thread summary plus the outcome. */
export const threadWaitSummary = (result: WaitForThreadResult) => {
  const thread = result.thread;
  return {
    ...threadSummary(thread),
    hasPendingBlockingUserInput: result.hasPendingBlockingUserInput,
    outcome: result.outcome,
    waited: result.waited,
    waitedMs: result.waitedMs,
    observedSequence: result.observedSequence,
    ...(thread.latestRunId === null
      ? {}
      : {
          turn: {
            turnId: thread.latestRunId,
            state: threadCliState(thread),
            requestedAt: isoOrNull(thread.latestRunRequestedAt),
            startedAt: isoOrNull(thread.latestRunStartedAt),
            completedAt: isoOrNull(thread.latestRunCompletedAt),
          },
        }),
  };
};

export interface ThreadInputRequestReport {
  readonly id: string;
  readonly responseMode: ThreadInputResponseMode;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly prompt: string;
    readonly options: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly description: string;
    }>;
    readonly allowCustomAnswer: boolean;
    readonly multiSelect: boolean;
  }>;
  readonly createdAt: string;
}

/** Unanswered agent questions, oldest first, as the fork reported them. */
export const pendingThreadInputRequests = (
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): ReadonlyArray<ThreadInputRequestReport> =>
  derivePendingThreadRequests(projection)
    .userInputs.map((request) => ({
      id: request.requestId,
      responseMode: request.responseMode ?? ("blocking" as const),
      questions: request.questions.map((question) => ({
        id: question.id,
        header: question.header,
        prompt: question.question,
        options: question.options.map((option) => ({
          id: option.value ?? option.label,
          label: option.label,
          description: option.description,
        })),
        allowCustomAnswer: question.allowCustomAnswer !== false,
        multiSelect: question.multiSelect,
      })),
      createdAt: request.createdAt,
    }))
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );

/**
 * The thread's request entities plus the timeline item of every pending
 * question. A question asked before the newest timeline window is found by
 * paging older history, so it never silently drops out of the list.
 */
const fetchPendingQuestionTimeline = Effect.fn("fetchPendingQuestionTimeline")(function* (
  input: ThreadCliInput,
  threadId: ThreadId,
) {
  const snapshot = yield* fetchLiveThreadBoundedSnapshot(
    input.live.origin,
    input.token,
    threadId,
    input.timeouts,
  );
  const { runtimeRequests } = snapshot.projection;
  const turnItems = [...snapshot.projection.turnItems];
  const missing = new Set<string>(
    runtimeRequests
      .filter((request) => request.kind === "user_input" && request.status === "pending")
      .map((request) => request.id),
  );
  for (const item of turnItems) {
    if (item.type === "user_input_request") missing.delete(item.requestId);
  }
  const requestedCursors = new Set<string>();
  let cursor = snapshot.hasMoreHistory ? snapshot.historyCursor : null;
  while (missing.size > 0 && cursor !== null && !requestedCursors.has(cursor)) {
    requestedCursors.add(cursor);
    const page = yield* fetchLiveThreadHistoryPage(
      input.live.origin,
      input.token,
      { threadId, cursor },
      input.timeouts,
    );
    for (const row of page.items) {
      if (row.item.type === "user_input_request" && missing.delete(row.item.requestId)) {
        turnItems.push(row.item);
      }
    }
    cursor = page.hasMoreHistory ? page.nextCursor : null;
  }
  return { runtimeRequests, turnItems };
});

const liveThreadWaitDependencies = (input: ThreadCliInput, threadId: ThreadId) => {
  const connection = { origin: input.live.origin, token: input.token, timeouts: input.timeouts };
  return {
    shellStream: (afterSequence: number) => subscribeLiveShell(connection, afterSequence),
    userInputResponseMode: (requestId: RuntimeRequestId) =>
      withLiveOrchestrationRpc(connection, (client) =>
        fetchUserInputResponseMode(client, input, threadId, requestId),
      ),
    serverAlive: isProcessAlive(input.live.pid),
  };
};

const threadWaitCommand = Command.make("wait", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
  afterSequence: Flag.Int("after-sequence").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    Flag.withDescription(
      "Wait only after the shell reaches this sequence, such as the `sequence` from `thread send --json`.",
    ),
    Flag.optional,
  ),
  turn: Flag.String("turn").pipe(
    Flag.withDescription(
      "Wait for this run (a summary's `activeTurnId` or `turn.turnId`); a newer run reports `superseded`.",
    ),
    Flag.optional,
  ),
  timeout: Flag.String("timeout").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("Maximum wait duration, for example `30s`, `5m`, or `1h`."),
    Flag.withDefault(Duration.minutes(30)),
  ),
  drain: threadWaitDrainFlag,
  onBlocked: Flag.Literals("on-blocked", ["wait", "return"] as const).pipe(
    Flag.withDescription("Whether approvals or questions that hold the turn keep waiting."),
    Flag.withDefault("return"),
  ),
  exitZero: Flag.Boolean("exit-zero").pipe(
    Flag.withDescription("Return exit code 0 for every observed terminal outcome."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Wait for a thread's turn to settle."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(input.live, flags.threadId);
        const result = yield* waitForThread(
          {
            thread,
            sequence: input.live.shell.snapshotSequence,
            serverPid: input.live.pid,
            options: {
              afterSequence: Option.getOrNull(flags.afterSequence),
              runId: Option.getOrNull(flags.turn),
              timeoutMs: Duration.toMillis(flags.timeout),
              drain: flags.drain,
              onBlocked: flags.onBlocked,
            },
          },
          liveThreadWaitDependencies(input, thread.id),
        );
        const summary = threadWaitSummary(result);
        yield* Console.log(
          flags.json
            ? jsonOutput(summary)
            : `Thread ${summary.id}: ${summary.outcome} after ${summary.waitedMs}ms (${summary.state}).`,
        );
        yield* Effect.sync(() => {
          process.exitCode = threadWaitExitCode(summary.outcome, flags.exitZero);
        });
      }),
    ),
  ),
);

const threadInputListCommand = Command.make("list", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List a thread's unanswered agent questions."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(input.live, flags.threadId);
        const requests = pendingThreadInputRequests(
          yield* fetchPendingQuestionTimeline(input, thread.id),
        );
        yield* Console.log(
          flags.json
            ? jsonOutput({ threadId: thread.id, requests })
            : requests.length === 0
              ? `Thread ${thread.id} has no unanswered questions.`
              : stripTerminalControlCharacters(
                  requests
                    .map(
                      (request) =>
                        `${request.id}\t${request.responseMode}\t${request.questions.map((question) => question.prompt).join(" / ")}`,
                    )
                    .join("\n"),
                ),
        );
      }),
    ),
  ),
);

const threadInputRespondCommand = Command.make("respond", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
  requestId: Argument.String("request-id").pipe(
    Argument.withSchema(RuntimeRequestId),
    Argument.withDescription("Question request id from `thread input list`."),
  ),
  answersJson: Flag.String("answers-json").pipe(
    Flag.withDescription("Complete JSON answer map keyed by question id."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Answer an unanswered agent question."),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(input.live, flags.threadId);
        const answers = yield* decodeThreadInputAnswersJson(flags.answersJson);
        const commandId = yield* newCommandId;
        const result = yield* withRpc(input, (client) =>
          Effect.gen(function* () {
            // The respond command also resolves approvals, so only answer a
            // request this command lists.
            const projection = yield* fetchLiveThreadProjection(client, thread.id, input.timeouts);
            const request = projection.runtimeRequests.find(
              (candidate) => candidate.id === flags.requestId,
            );
            if (request?.kind !== "user_input" || request.status !== "pending") {
              return yield* new ThreadCliInputRequestNotPendingError({
                operation: "respondToInput",
                threadId: thread.id,
                requestId: flags.requestId,
              });
            }
            return yield* dispatchLiveThreadCommand(client, {
              type: "runtime-request.respond",
              commandId,
              threadId: thread.id,
              requestId: flags.requestId,
              answers,
            });
          }),
        );
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId: thread.id,
                requestId: flags.requestId,
                commandId,
                sequence: result.sequence,
                action: "response-requested",
              })
            : `Submitted answers for question ${flags.requestId} in thread ${thread.id}.`,
        );
      }),
    ),
  ),
);

const threadInputCommand = Command.make("input").pipe(
  Command.withDescription("List and answer a thread's agent questions."),
  Command.withSubcommands([threadInputListCommand, threadInputRespondCommand]),
);

export function threadContextEnvironment(
  thread: Pick<OrchestrationV2ThreadShell, "id" | "activeRunId" | "worktreePath">,
  workspaceRoot: string,
) {
  return {
    T3CODE_THREAD_ID: thread.id,
    // v2 identifies a turn by its run; empty while idle.
    T3CODE_TURN_ID: thread.activeRunId ?? "",
    T3CODE_WORKTREE_PATH: thread.worktreePath ?? workspaceRoot,
  };
}

export function threadContextShell(environment: ReturnType<typeof threadContextEnvironment>) {
  return Object.entries(environment)
    .map(([name, value]) => `export ${name}='${value.replaceAll("'", "'\\''")}'`)
    .join("\n");
}

export const threadContextCommand = Command.make("context", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
  shell: Flag.Boolean("shell").pipe(
    Flag.withDescription("Print POSIX shell exports, including the current turn id."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Read the target thread's current execution context."),
  Command.withHandler((flags) =>
    runThreadCli(
      flags,
      flags.json,
      (input) =>
        Effect.gen(function* () {
          if (flags.shell && flags.json)
            return yield* new SessionCliError({
              operation: "thread.context",
              detail: "Choose either --shell or --json.",
            });
          const thread = yield* resolveThread(input.live, flags.threadId);
          const project = input.live.shell.projects.find((entry) => entry.id === thread.projectId);
          if (!project)
            return yield* new SessionCliError({
              operation: "thread.context",
              detail: `Project '${thread.projectId}' for thread '${thread.id}' was not found.`,
            });
          const environment = threadContextEnvironment(thread, project.workspaceRoot);
          yield* Console.log(
            flags.shell ? threadContextShell(environment) : jsonOutput(environment),
          );
        }),
      { suppressLogs: flags.shell },
    ),
  ),
);

export function archiveStatusText(
  threadId: string,
  archivedAt: string | null,
  archiveRequest: ReturnType<typeof cliArchiveRequest>,
): string {
  const lines = [
    `thread: ${threadId}`,
    `archived: ${archivedAt ?? "no"}`,
    `request: ${archiveRequest ? archiveRequest.status : "none"}`,
  ];
  if (archiveRequest?.detail) lines.push(`detail: ${archiveRequest.detail}`);
  return lines.join("\n");
}

export const threadArchiveCommand = Command.make("archive", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
  afterTurn: Flag.Boolean("after-turn").pipe(
    Flag.withDescription(
      "Archive after the target thread's current turn succeeds; archive idle threads immediately.",
    ),
    Flag.withDefault(false),
  ),
  removeWorktree: Flag.Boolean("remove-worktree").pipe(
    Flag.withDescription("Remove the clean worktree after archiving, preserving its branch."),
    Flag.withDefault(false),
  ),
  status: Flag.Boolean("status").pipe(
    Flag.withDescription("Inspect archive progress, including archived threads."),
    Flag.withDefault(false),
  ),
  cancel: Flag.Boolean("cancel").pipe(
    Flag.withDescription("Cancel a pending archive request."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Archive a thread, or schedule or cancel archive after its current turn.",
  ),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        if (flags.status) {
          if (flags.cancel || flags.afterTurn || flags.removeWorktree)
            return yield* new SessionCliError({
              operation: "thread.archive",
              detail: "--status cannot be combined with archive actions.",
            });
          const thread = yield* resolveThreadIncludingArchived(input, flags.threadId);
          const archivedAt = isoOrNull(thread.archivedAt);
          const archiveRequest = cliArchiveRequest(thread.archiveRequest);
          yield* Console.log(
            flags.json
              ? jsonOutput({ threadId: thread.id, archivedAt, archiveRequest })
              : archiveStatusText(thread.id, archivedAt, archiveRequest),
          );
          return;
        }
        if (flags.cancel && (flags.afterTurn || flags.removeWorktree)) {
          return yield* new SessionCliError({
            operation: "thread.archive",
            detail: "--cancel cannot be combined with --after-turn or --remove-worktree.",
          });
        }
        const thread = yield* resolveThread(input.live, flags.threadId);
        const commandId = yield* newCommandId;
        const scheduled = flags.afterTurn || flags.removeWorktree;
        // Scheduling and cancelling go through the server's archive scheduler,
        // like the agent tools, so an unqualified worktree removal is refused
        // up front instead of only being recorded on the request.
        const status = yield* withRpc(input, (client) =>
          flags.cancel
            ? cancelLiveThreadArchive(client, { threadId: thread.id, commandId })
            : scheduled
              ? scheduleLiveThreadArchive(client, {
                  threadId: thread.id,
                  afterTurn: flags.afterTurn,
                  ...(flags.removeWorktree ? { removeWorktree: true } : {}),
                  commandId,
                })
              : dispatchLiveThreadCommand(client, {
                  type: "thread.archive",
                  commandId,
                  threadId: thread.id,
                }).pipe(Effect.as(null)),
        );
        const action = flags.cancel
          ? "archive-cancelled"
          : scheduled && status?.archivedAt == null
            ? "archive-requested"
            : "archived";
        const requestId = scheduled ? (status?.request?.requestId ?? commandId) : null;
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId: thread.id,
                action,
                ...(requestId === null ? {} : { requestId }),
              })
            : `${action}: ${thread.id}.`,
        );
      }),
    ),
  ),
);

const liveThreadMessagesFetchDeps = (input: ThreadCliInput) => ({
  fetchLatest: (threadId: ThreadId) =>
    fetchLiveThreadBoundedSnapshot(input.live.origin, input.token, threadId, input.timeouts).pipe(
      Effect.map((snapshot) => ({
        rows: snapshot.projection.visibleTurnItems,
        snapshotSequence: snapshot.snapshotSequence,
        olderCursor: snapshot.hasMoreHistory ? snapshot.historyCursor : null,
      })),
    ),
  fetchOlder: (threadId: ThreadId, cursor: string) =>
    fetchLiveThreadHistoryPage(
      input.live.origin,
      input.token,
      { threadId, cursor },
      input.timeouts,
    ).pipe(
      Effect.map((page) => ({
        rows: page.items,
        snapshotSequence: page.snapshotSequence,
        olderCursor: page.hasMoreHistory ? page.nextCursor : null,
      })),
    ),
});

const threadMessagesCommand = Command.make("messages", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
  limit: Flag.Int("limit").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThan(0))),
    Flag.withDescription("Only the newest N messages (counted before role filtering)."),
    Flag.optional,
  ),
  before: Flag.String("before").pipe(
    Flag.withDescription("Only messages older than this cursor (nextBefore of an earlier call)."),
    Flag.optional,
  ),
  role: Flag.Literals("role", THREAD_MESSAGE_ROLES).pipe(
    Flag.withDescription(
      "Only messages with this role; reasoning is the agent's thinking. Default: user and assistant.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Print a thread's conversation messages, without tool calls. Includes archived threads.",
  ),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const rawThreadId = requestedThreadId(flags.threadId);
        if (rawThreadId.length === 0) return yield* threadNotFound(flags.threadId);
        const threadId = ThreadId.make(rawThreadId);
        const before = Option.isSome(flags.before)
          ? yield* parseThreadMessagesCursor(rawThreadId, flags.before.value)
          : null;
        // Another thread's cursor would page an unrelated window. Archived
        // threads are not in the shell, so their lineage cannot be checked.
        const activeThread = input.live.shell.threads.some(
          (candidate) => candidate.id === threadId && candidate.archivedAt === null,
        );
        if (
          before !== null &&
          activeThread &&
          !threadMessagesCursorMayBelongTo(before, threadId, input.live.shell.threads)
        ) {
          return yield* new ThreadCliMessageCursorError({
            operation: "fetchThreadMessages",
            threadId: rawThreadId,
            cursor: before,
            reason: "not-found",
          });
        }
        // Best effort: the transcript does not depend on environment identity.
        const descriptor = yield* Effect.option(
          fetchLiveEnvironmentDescriptor(input.live.origin, input.timeouts),
        );
        const window = yield* collectThreadMessages(
          { threadId, before, limit: Option.getOrNull(flags.limit) },
          liveThreadMessagesFetchDeps(input),
        );
        const thread =
          input.live.shell.threads.find(
            (candidate) => candidate.id === threadId && candidate.archivedAt === null,
          ) ?? null;
        const fileSystem = yield* FileSystem.FileSystem;
        const existingAttachmentPaths = new Set<string>();
        for (const message of window.messages) {
          for (const attachment of message.attachments) {
            const path = resolveAttachmentPath({
              attachmentsDir: input.attachmentsDir,
              attachment,
            });
            if (path === null || existingAttachmentPaths.has(path)) continue;
            const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
            if (exists) existingAttachmentPaths.add(path);
          }
        }
        const report = threadMessagesReport({
          threadId,
          thread,
          window,
          role: Option.getOrNull(flags.role),
          machine: {
            hostname: NodeOS.hostname(),
            environmentId: Option.isSome(descriptor) ? descriptor.value.environmentId : null,
            environmentLabel: Option.isSome(descriptor) ? descriptor.value.label : null,
            platform: Option.isSome(descriptor) ? descriptor.value.platform.os : null,
          },
          attachmentsDir: input.attachmentsDir,
          attachmentFileExists: (path) => existingAttachmentPaths.has(path),
        });
        yield* Console.log(flags.json ? jsonOutput(report) : renderThreadMessagesText(report));
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
    threadMoveCommand,
    makeThreadPinCommand(true),
    makeThreadPinCommand(false),
    threadInterruptCommand,
    threadStatusCommand,
    threadMessagesCommand,
    threadWaitCommand,
    threadInputCommand,
    threadArchiveCommand,
    threadContextCommand,
  ]),
);

const groupListCommand = Command.make("list", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List thread groups in sidebar order, including where Active sits, with active thread counts.",
  ),
  Command.withHandler((flags) =>
    runThreadCli(flags, flags.json, (input) =>
      Effect.gen(function* () {
        const catalog = yield* fetchThreadGroupCatalog(input);
        const counts = new Map<string | null, number>();
        for (const thread of input.live.shell.threads) {
          if (thread.archivedAt !== null) continue;
          const groupId = threadGroupId(thread, catalog);
          counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
        }
        // Active is the null section: it has no id and holds every thread
        // without a live custom group.
        const groups = threadGroupSections(visibleThreadGroups(catalog)).map((group) => ({
          id: group?.id ?? null,
          name: group?.name ?? "Active",
          threadCount: counts.get(group?.id ?? null) ?? 0,
        }));
        yield* Console.log(
          flags.json
            ? jsonOutput({ groups })
            : groups
                .map((group) => `${group.id ?? "-"}\t${group.name}\t${group.threadCount}`)
                .join("\n"),
        );
      }),
    ),
  ),
);

export const groupCommand = Command.make("group").pipe(
  Command.withDescription("Inspect thread groups."),
  Command.withSubcommands([groupListCommand]),
);
