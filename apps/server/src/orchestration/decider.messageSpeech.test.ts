import {
  CommandId,
  MESSAGE_SPEECH_MAX_SOURCE_CHARS,
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

function readModel(
  speechRequest?: { requestId: CommandId; startedAt: string },
  text = "Assistant reply",
): OrchestrationReadModel {
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
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "assistant",
            text,
            ...(speechRequest !== undefined ? { speechRequest } : {}),
            turnId: null,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
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
  it.effect("persists a validated request with the command id as its correlation id", () =>
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

  it.effect("rejects a duplicate pending request", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.message.speech.request",
            commandId: CommandId.make("cmd-new-request"),
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("message-1"),
          },
          readModel: readModel({ requestId: CommandId.make("cmd-current"), startedAt: NOW }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("rejects source text above the synthesis limit", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.message.speech.request",
            commandId: CommandId.make("cmd-long-request"),
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("message-1"),
          },
          readModel: readModel(undefined, "x".repeat(MESSAGE_SPEECH_MAX_SOURCE_CHARS + 1)),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("attaches speech only to the current request", () =>
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
        readModel: readModel({ requestId: CommandId.make("cmd-current"), startedAt: NOW }),
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.message-speech-completed");
      if (event.type === "thread.message-speech-completed") {
        expect(event.payload.speech).toEqual(speech);
      }
    }),
  );

  it.effect("strips speech from a stale completion", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.speech.complete",
          commandId: CommandId.make("cmd-complete"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          requestId: CommandId.make("cmd-stale"),
          speech,
        },
        readModel: readModel({ requestId: CommandId.make("cmd-current"), startedAt: NOW }),
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.message-speech-completed");
      if (event.type === "thread.message-speech-completed") {
        expect(event.payload.speech).toBeUndefined();
      }
    }),
  );
});
