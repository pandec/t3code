import { McpCapabilityUnavailableError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { AgentVoiceReply } from "../../../voice/AgentVoiceReply.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { VoiceToolkit } from "./tools.ts";

export const VoiceToolkitHandlersLive = McpToolAccess.toLayer(VoiceToolkit, {
  voice_reply: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("voice");
      // Voice replies attach to the calling thread's run, so only thread callers get them.
      if (scope.thread === undefined) {
        return yield* new McpCapabilityUnavailableError({
          capability: "voice",
          environmentId: scope.environmentId,
        });
      }
      const agentVoiceReply = yield* AgentVoiceReply;
      return yield* agentVoiceReply.stage({
        threadId: scope.thread.threadId,
        script: input.script,
      });
    }),
  ),
});
