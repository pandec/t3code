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

/**
 * The SDK resolves its config directory from `process.env.CLAUDE_CONFIG_DIR`
 * at call time, so the fork briefly swaps that variable to the instance's
 * config dir and restores it afterwards; when the variable already matches,
 * nothing is mutated at all, which is the common single-instance case. The
 * semaphore serializes forks so concurrent instances with different config
 * dirs never observe each other's override; waiting for the permit stays
 * interruptible, while the swap, SDK call, and restore run as one
 * uninterruptible section. The fork runs in-process on the statically
 * imported SDK: the packaged desktop server is a single bundle with no
 * resolvable `@anthropic-ai/claude-agent-sdk` on disk, so spawning a
 * subprocess that imports the SDK by name cannot work there. Serializing
 * every fork is a deliberate tradeoff: forks are rare, user-initiated, and
 * finish in milliseconds even for megabyte transcripts, and the env var is
 * process-global regardless of config dir.
 */
const forkPermit = Semaphore.makeUnsafe(1);

export const forkClaudePersistedSession = Effect.fn("forkClaudePersistedSession")(
  function* (input: {
    readonly sessionId: string;
    readonly dir?: string;
    readonly configDirPath: string;
  }) {
    const result = yield* forkPermit.withPermits(1)(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          if (process.env.CLAUDE_CONFIG_DIR === input.configDirPath) {
            return { swapped: false as const, previous: undefined };
          }
          const previous = process.env.CLAUDE_CONFIG_DIR;
          process.env.CLAUDE_CONFIG_DIR = input.configDirPath;
          return { swapped: true as const, previous };
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
        (swap) =>
          Effect.sync(() => {
            if (!swap.swapped) return;
            if (swap.previous === undefined) {
              delete process.env.CLAUDE_CONFIG_DIR;
            } else {
              process.env.CLAUDE_CONFIG_DIR = swap.previous;
            }
          }),
      ),
    );
    const forkedSessionId: unknown = (result as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof forkedSessionId !== "string" || forkedSessionId.length === 0) {
      return yield* new ClaudeSessionForkError({
        sessionId: input.sessionId,
        detail: "Claude SDK returned an invalid forked session id.",
      });
    }
    return { sessionId: forkedSessionId };
  },
);
