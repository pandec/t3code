import {
  DEFAULT_SERVER_SETTINGS,
  ProviderUserInputAnswers,
  ServerSettings,
  T3_PROJECT_FILE_NAME,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Flag, Param, Primitive } from "effect/unstable/cli";

import { expandHomePath } from "../pathExpansion.ts";
import { CliOrchestrationOutcomeUnknownError } from "./orchestration.ts";
import { resolveGitCommonDirectory, runGitCommand } from "./session.ts";

// The `t3 thread` and `t3 group` command handlers are rebuilt on orchestration
// v2; until then this module only carries their transport-independent helpers.

type ThreadWaitDrainMode = "agents" | "all" | null;

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

// One flag that accepts a bare `--drain` and an inline `--drain=agents|all`.
// It keeps the Boolean primitive tag so the parser treats a bare flag as
// "true" and never swallows the next positional as its value (a
// space-separated `--drain agents` stays an unexpected argument). Effect
// rc.112 registers `Flag.orElse` alternates, so a boolean and a choice flag
// sharing the name "drain" would now fail as a duplicate flag.
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
  typeName: "agents | all",
}).pipe(
  Flag.withDefault(null),
  Flag.withDescription(
    "After the turn settles, wait for background agents/workflows; use --drain=all to include monitors.",
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

export class ThreadCliMessageCursorError extends Schema.TaggedError<ThreadCliMessageCursorError>()(
  "ThreadCliMessageCursorError",
  {
    operation: Schema.Literal("fetchThreadMessages"),
    threadId: Schema.String,
    cursor: Schema.String,
    reason: Schema.Literals(["empty", "not-found", "changed"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "empty":
        return "The --before cursor must not be empty.";
      case "not-found":
        return `No message '${this.cursor}' exists in thread '${this.threadId}' to page from. The cursor may be stale; rerun without --before.`;
      case "changed":
        return `The history of thread '${this.threadId}' changed while reading it. Rerun the command.`;
    }
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

/** How `t3 thread new` reconciles the requested workspace with the running
    server's capabilities. */
export type ThreadCliWorkspaceDecision =
  | {
      readonly kind: "proceed";
      readonly workspace: Exclude<ThreadCliWorkspaceSelection, { mode: "default" }>;
    }
  /** Defaults-derived worktree on a server without bootstrap support: start
      in the checkout instead (with a stderr warning; the JSON `workspace`
      object remains the authoritative record of what actually happened). */
  | { readonly kind: "fallback-checkout" }
  /** Explicit --new-worktree on a server without bootstrap support: fail. */
  | { readonly kind: "unsupported" };

export const decideThreadCliWorkspace = (input: {
  readonly requested: Exclude<ThreadCliWorkspaceSelection, { mode: "default" }>;
  readonly fromDefaults: boolean;
  readonly bootstrapSupported: boolean;
}): ThreadCliWorkspaceDecision => {
  if (input.requested.mode !== "new-worktree" || input.bootstrapSupported) {
    return { kind: "proceed", workspace: input.requested };
  }
  return input.fromDefaults ? { kind: "fallback-checkout" } : { kind: "unsupported" };
};

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

// Bootstrap turn starts include a git worktree creation (and optionally a
// remote fetch) before the server acknowledges, which can far exceed the
// default dispatch acknowledgement timeout on large repositories.
const BOOTSTRAP_DISPATCH_TIMEOUT_MS = 180_000;

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

// One server request returns at most 500 messages; older history pages via
// the `before` cursor.
const THREAD_MESSAGES_PAGE_LIMIT = 500;

export interface ThreadMessagesMachine {
  readonly hostname: string;
  readonly environmentId: string | null;
  readonly environmentLabel: string | null;
  readonly platform: string | null;
}

// Transcript text carries untrusted content (assistant output, titles,
// attachment names) straight to a terminal, so strip control characters that
// could smuggle escape sequences; newlines and tabs stay. JSON mode needs no
// such pass because JSON.stringify escapes them.
const stripTerminalControlCharacters = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
