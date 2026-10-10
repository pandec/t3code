import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";

import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";

export type ClaudeHistoryMethod = "getSessionMessages" | "getSubagentMessages" | "forkSession";

export class ClaudeHistoryProcessError extends Schema.TaggedError<ClaudeHistoryProcessError>()(
  "ClaudeHistoryProcessError",
  {
    method: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Claude history ${this.method} failed: ${this.detail}`;
  }
}

const encodeHistoryOptions = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Run a Claude Agent SDK history helper in a worker process under `environment`.
 * The SDK resolves session storage from `CLAUDE_CONFIG_DIR`, so callers pin it to
 * the provider instance's config directory (configured home, shadow overlay or
 * inherited environment) instead of letting the helper read the server's own
 * environment. Node and Electron run the bundled sibling worker; the
 * single-executable hosts it as its `__claude-history` subcommand. Returns the
 * worker's JSON stdout for the caller to decode.
 */
export const runClaudeHistoryProcess = Effect.fn("runClaudeHistoryProcess")(function* (input: {
  readonly method: ClaudeHistoryMethod;
  readonly sessionId: string;
  readonly options: object;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const executablePath = yield* HostProcess.ExecutablePath;
  const workerArguments = (yield* HostProcess.IsExecutable)
    ? ["__claude-history"]
    : [
        yield* (yield* Path.Path)
          .fromFileUrl(
            new URL(
              import.meta.url.endsWith(".ts")
                ? "./claude-history-worker.ts"
                : "./claude-history-worker.mjs",
              import.meta.url,
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ClaudeHistoryProcessError({
                  method: input.method,
                  detail: "The history worker path is unavailable.",
                  cause,
                }),
            ),
          ),
      ];
  const result = yield* spawnAndCollect(
    executablePath,
    ChildProcess.make(
      executablePath,
      [...workerArguments, input.method, input.sessionId, encodeHistoryOptions(input.options)],
      { env: { ...input.environment, ELECTRON_RUN_AS_NODE: "1" } },
    ),
  ).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError(
      (cause) =>
        new ClaudeHistoryProcessError({
          method: input.method,
          detail: "The history worker could not run.",
          cause,
        }),
    ),
  );
  if (result.code !== 0) {
    return yield* new ClaudeHistoryProcessError({
      method: input.method,
      detail: result.stderr.trim() || `The history worker exited with code ${result.code}.`,
    });
  }
  return result.stdout;
});
