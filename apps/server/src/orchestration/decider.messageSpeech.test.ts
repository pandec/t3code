import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MessageSpeechAttachment,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const speech: MessageSpeechAttachment = {
  speechId: "thread-1:speech-1",
  transcript: "Spoken reply",
  mimeType: "audio/mpeg",
  sizeBytes: 123,
  sourceTextHash: "source-hash",
  scriptRecipeHash: "recipe-hash",
  voiceId: "voice-1",
  ttsModel: "model-1",
  origin: "user",
  createdAt: NOW,
};

function readModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        completedTurnAssistantMessageIds: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("message speech decider", (it) => {
  it.effect("emits a request when the command read model omits messages", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.speech.request",
          commandId: CommandId.make("cmd-request"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
        },
        readModel: readModel(),
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.message-speech-requested");
      if (event.type === "thread.message-speech-requested") {
        expect(event.payload.requestId).toBe(CommandId.make("cmd-request"));
        expect(event.payload.messageId).toBe(MessageId.make("message-1"));
      }
    }),
  );

  it.effect("carries completion speech for the projectors to guard by request id", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.speech.complete",
          commandId: CommandId.make("cmd-complete"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          requestId: CommandId.make("cmd-current"),
          speech,
        },
        readModel: readModel(),
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.message-speech-completed");
      if (event.type === "thread.message-speech-completed") {
        expect(event.payload.speech).toEqual(speech);
      }
    }),
  );

  it.effect("carries typed completion failures when messages are omitted", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.speech.complete",
          commandId: CommandId.make("cmd-complete-failed"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          requestId: CommandId.make("cmd-request"),
          failureReason: "script_failed",
        },
        readModel: readModel(),
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.message-speech-completed");
      if (event.type === "thread.message-speech-completed") {
        expect(event.payload.failureReason).toBe("script_failed");
      }
    }),
  );
});
