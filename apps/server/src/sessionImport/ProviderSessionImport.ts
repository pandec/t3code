/**
 * ProviderSessionImport — per-instance access to sessions a provider CLI
 * persisted outside T3 Code, for explicit session import and handover.
 *
 * Built by the Claude and Codex drivers over the instance's own home and
 * environment, so a listing, read or fork always targets the same transcripts
 * that instance resumes. `cwd` is always a canonical (realpath) directory.
 */
import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { runClaudeHistoryProcess } from "../claudeHistoryProcess.ts";
import {
  makeClaudeHistoryEnvironment,
  resolveClaudeConfigDirPath,
} from "../provider/Drivers/ClaudeHome.ts";
import {
  type ClaudeSessionImportIoError,
  type ClaudeTranscriptParseError,
  listClaudeSessionTranscripts,
  readClaudeSessionTranscript,
} from "../provider/Drivers/ClaudeSessionImport.ts";
import {
  type CodexImportReaderOptions,
  forkCodexImportableThread,
  listCodexImportableSessions,
  readCodexImportableThread,
} from "../provider/Drivers/CodexImportReader.ts";

export class ProviderSessionImportError extends Schema.TaggedError<ProviderSessionImportError>()(
  "ProviderSessionImportError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ProviderImportableSession {
  readonly nativeSessionId: string;
  /** Provider-derived session title, preferring an explicit user-assigned name. */
  readonly name: string | null;
  readonly preview: string;
  readonly messageCount: number | null;
  readonly updatedAt: string;
}

export interface ProviderImportedMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface ProviderImportedSession {
  readonly nativeSessionId: string;
  readonly name: string | null;
  readonly messages: ReadonlyArray<ProviderImportedMessage>;
  /** Last model the session used, when the transcript records one. */
  readonly model: string | null;
}

export interface ProviderSessionImport {
  readonly listSessions: (input: {
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<ProviderImportableSession>, ProviderSessionImportError>;
  readonly readSession: (input: {
    readonly nativeSessionId: string;
    readonly cwd: string;
  }) => Effect.Effect<ProviderImportedSession, ProviderSessionImportError>;
  /** Copies a session into a new native session and returns its id. */
  readonly forkSession?: (input: {
    readonly nativeSessionId: string;
    readonly cwd: string;
  }) => Effect.Effect<string, ProviderSessionImportError>;
}

const describeCause = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "detail" in cause
    ? String((cause as { readonly detail: unknown }).detail)
    : String(cause);

const importError = (prefix: string) => (cause: unknown) =>
  new ProviderSessionImportError({ detail: `${prefix}: ${describeCause(cause)}`, cause });

const describeClaudeImportError = (
  cause: ClaudeTranscriptParseError | ClaudeSessionImportIoError,
) =>
  new ProviderSessionImportError({
    detail:
      cause._tag === "ClaudeTranscriptParseError"
        ? `Claude session '${cause.sessionId}' line ${cause.line}: ${cause.detail}`
        : cause.detail,
    cause,
  });

const decodeClaudeForkResult = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ sessionId: Schema.String.check(Schema.isUUID()) })),
);

/** Claude sessions live under the instance's config directory, keyed by cwd. */
export const makeClaudeSessionImport = Effect.fn("makeClaudeSessionImport")(function* (input: {
  readonly config: Pick<ClaudeSettings, "homePath">;
  /** The instance's Claude environment (`makeClaudeEnvironment`). */
  readonly environment: NodeJS.ProcessEnv;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const provide = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  const configDirPath = (cwd: string) =>
    resolveClaudeConfigDirPath(input.config, input.environment, cwd);

  return {
    listSessions: ({ cwd }) =>
      provide(
        Effect.gen(function* () {
          const summaries = yield* listClaudeSessionTranscripts({
            configDirPath: yield* configDirPath(cwd),
            canonicalCwd: cwd,
          }).pipe(Effect.mapError(describeClaudeImportError));
          return summaries.map((summary) => ({
            nativeSessionId: summary.sessionId,
            name: summary.name,
            preview: summary.preview,
            messageCount: summary.messageCount,
            updatedAt: summary.updatedAt,
          }));
        }),
      ),
    readSession: ({ nativeSessionId, cwd }) =>
      provide(
        Effect.gen(function* () {
          const transcript = yield* readClaudeSessionTranscript({
            configDirPath: yield* configDirPath(cwd),
            canonicalCwd: cwd,
            sessionId: nativeSessionId,
          }).pipe(Effect.mapError(describeClaudeImportError));
          return {
            nativeSessionId,
            name: transcript.name,
            messages: transcript.messages,
            model: transcript.model,
          };
        }),
      ),
    // The SDK copies the transcript under a new session id. It runs in the
    // history worker so it reads this instance's config directory.
    forkSession: ({ nativeSessionId, cwd }) =>
      provide(
        Effect.gen(function* () {
          const environment = yield* makeClaudeHistoryEnvironment(
            input.config,
            input.environment,
            cwd,
          );
          const output = yield* runClaudeHistoryProcess({
            method: "forkSession",
            sessionId: nativeSessionId,
            options: { dir: cwd },
            environment,
          });
          return (yield* decodeClaudeForkResult(output)).sessionId;
        }).pipe(Effect.mapError(importError(`Forking Claude session '${nativeSessionId}' failed`))),
      ),
  } satisfies ProviderSessionImport;
});

/** Codex sessions are read and forked through an ephemeral `codex app-server`. */
export const makeCodexSessionImport = Effect.fn("makeCodexSessionImport")(function* (
  options: Omit<CodexImportReaderOptions, "cwd">,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const provide = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
    effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

  return {
    listSessions: ({ cwd }) =>
      provide(listCodexImportableSessions({ ...options, cwd })).pipe(
        Effect.map((summaries) =>
          summaries.map((summary) => ({
            nativeSessionId: summary.threadId,
            name: summary.name,
            preview: summary.preview,
            messageCount: null,
            updatedAt: summary.updatedAt,
          })),
        ),
        Effect.mapError(importError("Listing Codex sessions failed")),
      ),
    readSession: ({ nativeSessionId, cwd }) =>
      Effect.gen(function* () {
        const imported = yield* provide(
          readCodexImportableThread({ ...options, cwd, threadId: nativeSessionId }),
        ).pipe(Effect.mapError(importError(`Reading Codex thread '${nativeSessionId}' failed`)));
        // Codex validates a thread's recorded cwd against the workspace it
        // resumes in, so a thread from another directory cannot continue here.
        // A recorded cwd that no longer resolves is reported as a mismatch.
        const nativeCwd = yield* fileSystem
          .realPath(imported.cwd)
          .pipe(Effect.orElseSucceed(() => imported.cwd));
        if (nativeCwd !== cwd) {
          return yield* new ProviderSessionImportError({
            detail: `Codex thread '${nativeSessionId}' belongs to '${nativeCwd}', not the selected workspace '${cwd}'.`,
          });
        }
        return {
          nativeSessionId: imported.threadId,
          name: imported.name,
          messages: imported.messages,
          model: null,
        };
      }),
    forkSession: ({ nativeSessionId, cwd }) =>
      provide(forkCodexImportableThread({ ...options, cwd, threadId: nativeSessionId })).pipe(
        Effect.mapError(importError(`Forking Codex thread '${nativeSessionId}' failed`)),
      ),
  } satisfies ProviderSessionImport;
});
