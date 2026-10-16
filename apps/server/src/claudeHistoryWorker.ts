import {
  forkSession,
  getSessionMessages,
  getSubagentMessages,
} from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// Nothing here may run on import: inside the executable `import.meta.main` is
// true for the whole bundle.
const decodeHistoryOptions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      upToMessageId: Schema.optionalKey(Schema.String),
      agentId: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Number),
    }),
  ),
);

export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  const { agentId, ...options } = decodeHistoryOptions(rawOptions ?? "{}");
  if (!sessionId) throw new Error("Claude history session id is required.");
  const result =
    method === "getSessionMessages"
      ? await getSessionMessages(sessionId, options)
      : method === "forkSession"
        ? await forkSession(sessionId, options)
        : method === "getSubagentMessages" && agentId
          ? await getSubagentMessages(sessionId, agentId, options)
          : (() => {
              throw new Error("Unknown Claude history operation.");
            })();
  process.stdout.write(JSON.stringify(result));
}
