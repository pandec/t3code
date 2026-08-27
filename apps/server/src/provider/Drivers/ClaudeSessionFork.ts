import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
 * config dir and restores it afterwards. The queue serializes forks so
 * concurrent instances with different config dirs never observe each other's
 * override. The fork runs in-process on the statically imported SDK: the
 * packaged desktop server is a single bundle with no resolvable
 * `@anthropic-ai/claude-agent-sdk` on disk, so spawning a subprocess that
 * imports the SDK by name cannot work there. Serializing every fork is a
 * deliberate tradeoff: forks are rare, user-initiated, and finish in
 * milliseconds even for megabyte transcripts, and the env var is
 * process-global regardless of config dir.
 */
let forkQueue = Promise.resolve();

const runWithClaudeConfigDir = <A>(configDirPath: string, run: () => Promise<A>) => {
  const task = forkQueue.then(async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDirPath;
    try {
      return await run();
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous;
      }
    }
  });
  forkQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
};

export const forkClaudePersistedSession = Effect.fn("forkClaudePersistedSession")(
  function* (input: {
    readonly sessionId: string;
    readonly dir?: string;
    readonly configDirPath: string;
  }) {
    const result = yield* Effect.tryPromise({
      try: () =>
        runWithClaudeConfigDir(input.configDirPath, () =>
          forkSession(input.sessionId, input.dir ? { dir: input.dir } : undefined),
        ),
      catch: (cause) =>
        new ClaudeSessionForkError({
          sessionId: input.sessionId,
          detail:
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : "The Claude SDK failed to fork the session.",
          cause,
        }),
    });
    if (result.sessionId.length === 0) {
      return yield* new ClaudeSessionForkError({
        sessionId: input.sessionId,
        detail: "Claude SDK returned an empty forked session id.",
      });
    }
    return result;
  },
);
