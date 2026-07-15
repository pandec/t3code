import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";

export class ClaudeSessionForkError extends Schema.TaggedErrorClass<ClaudeSessionForkError>()(
  "ClaudeSessionForkError",
  {
    sessionId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const decodeClaudeForkProcessResult = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ sessionId: Schema.String })),
);

export const forkClaudePersistedSession = Effect.fn("forkClaudePersistedSession")(function (input: {
  readonly sessionId: string;
  readonly dir?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  return Effect.gen(function* () {
    const script = `
const { forkSession } = await import(process.argv[1]);
const result = await forkSession(process.argv[2], process.argv[3] ? { dir: process.argv[3] } : undefined);
process.stdout.write(JSON.stringify(result));
`;
    const sdkModuleUrl = yield* Effect.try({
      try: () =>
        NodeURL.pathToFileURL(
          NodeModule.createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"),
        ).href,
      catch: (cause) =>
        new ClaudeSessionForkError({
          sessionId: input.sessionId,
          detail: "Unable to resolve the installed Claude Agent SDK module.",
          cause,
        }),
    });
    const child = yield* input.spawner
      .spawn(
        ChildProcess.make(
          process.execPath,
          ["--input-type=module", "--eval", script, sdkModuleUrl, input.sessionId, input.dir ?? ""],
          { env: input.environment, extendEnv: false },
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ClaudeSessionForkError({
              sessionId: input.sessionId,
              detail: "Unable to start the Claude SDK fork process.",
              cause,
            }),
        ),
      );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout }),
        collectUint8StreamText({ stream: child.stderr }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeSessionForkError({
            sessionId: input.sessionId,
            detail: "Unable to read the Claude SDK fork process result.",
            cause,
          }),
      ),
    );
    if (exitCode !== 0) {
      return yield* new ClaudeSessionForkError({
        sessionId: input.sessionId,
        detail: stderr.text.trim() || `Claude SDK fork process exited with code ${exitCode}.`,
      });
    }
    const result = yield* decodeClaudeForkProcessResult(stdout.text).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeSessionForkError({
            sessionId: input.sessionId,
            detail: "Claude SDK fork process returned an invalid result.",
            cause,
          }),
      ),
    );
    if (result.sessionId.length === 0) {
      return yield* new ClaudeSessionForkError({
        sessionId: input.sessionId,
        detail: "Claude SDK returned an empty forked session id.",
      });
    }
    return result;
  }).pipe(Effect.scoped);
});
