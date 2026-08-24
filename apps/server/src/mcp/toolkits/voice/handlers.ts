import * as Effect from "effect/Effect";

import { AgentVoiceReply } from "../../../voice/AgentVoiceReply.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VoiceToolkit } from "./tools.ts";

export const VoiceToolkitHandlersLive = VoiceToolkit.toLayer({
  voice_reply: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("voice");
      const agentVoiceReply = yield* AgentVoiceReply;
      const staged = yield* agentVoiceReply.stage({
        threadId: scope.threadId,
        script: input.script,
      });
      return {
        status: "staged" as const,
        transcriptChars: staged.transcript.length,
        audioSizeBytes: staged.sizeBytes,
      };
    }),
});
