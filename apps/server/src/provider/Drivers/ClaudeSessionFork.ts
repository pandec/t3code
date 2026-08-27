import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export class ClaudeSessionForkError extends Schema.TaggedErrorClass<ClaudeSessionForkError>()(
  "ClaudeSessionForkError",
  {
    sessionId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const decodeForkedSession = Schema.decodeUnknownEffect(
  Schema.Struct({ sessionId: Schema.NonEmptyString }),
);

export interface ClaudeSessionForkInput {
  readonly sessionId: string;
  readonly dir?: string;
  readonly configDirPath: string;
}

/**
 * The SDK resolves its config directory from `process.env.CLAUDE_CONFIG_DIR`
 * at call time, so the fork briefly swaps that variable to the instance's
 * config dir and restores it afterwards. The semaphore serializes forks so
 * concurrent instances with different config dirs never observe each other's
 * override; waiting for the permit stays interruptible, while the swap, SDK
 * call, and restore run as one uninterruptible section. The fork runs
 * in-process on the statically imported SDK: the packaged desktop server is a
 * single bundle with no resolvable `@anthropic-ai/claude-agent-sdk` on disk,
 * so spawning a subprocess that imports the SDK by name cannot work there.
 * Serializing every fork is a deliberate tradeoff: forks are rare,
 * user-initiated, and finish in milliseconds even for megabyte transcripts,
 * and the env var is process-global regardless of config dir.
 *
 * Two narrow windows are accepted rather than engineered away: a provider
 * instance constructed during the swap can snapshot the override into its
 * environment (requires a settings reload racing a custom-config-dir fork;
 * the next reload rebinds it), and a shutdown-time interruption can leave a
 * forked transcript on disk with no thread bound to it, where it simply
 * becomes an importable session candidate.
 */
const forkPermit = Semaphore.makeUnsafe(1);

export const forkClaudePersistedSession = Effect.fn("forkClaudePersistedSession")(function* (
  input: ClaudeSessionForkInput,
) {
  const result = yield* forkPermit.withPermits(1)(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = input.configDirPath;
        return previous;
      }),
      () =>
        Effect.uninterruptible(
          Effect.tryPromise({
            try: () => forkSession(input.sessionId, input.dir ? { dir: input.dir } : undefined),
            catch: (cause) =>
              new ClaudeSessionForkError({
                sessionId: input.sessionId,
                detail:
                  cause instanceof Error && cause.message.length > 0
                    ? cause.message
                    : "The Claude SDK failed to fork the session.",
                cause,
              }),
          }),
        ),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
          } else {
            process.env.CLAUDE_CONFIG_DIR = previous;
          }
        }),
    ),
  );
  return yield* decodeForkedSession(result).pipe(
    Effect.mapError(
      (cause) =>
        new ClaudeSessionForkError({
          sessionId: input.sessionId,
          detail: "Claude SDK returned an invalid forked session id.",
          cause,
        }),
    ),
  );
});
