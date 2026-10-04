import {
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ConversationMessage,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";

/** Projects a thread with one message through the v2 store, as the orchestrator would. */
export const seedMessage = Effect.fn("seedMessage")(function* (input: {
  readonly suffix: string;
  readonly text: string;
  readonly threadModelSelection: ModelSelection;
  /** The producing run's model; null projects a runless (imported) message. */
  readonly runModelSelection: ModelSelection | null;
  readonly worktreePath: string | null;
  readonly role?: OrchestrationV2ConversationMessage["role"];
  readonly streaming?: boolean;
}) {
  const store = yield* ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${input.suffix}`);
  const runId = RunId.make(`run:${input.suffix}`);
  const nodeId = NodeId.make(`node:${input.suffix}`);
  const providerInstanceId = input.threadModelSelection.instanceId;

  yield* store.apply({
    id: EventId.make(`event:${input.suffix}:thread`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${input.suffix}`),
      title: "Message artifacts",
      providerInstanceId,
      modelSelection: input.threadModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: input.worktreePath,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  if (input.runModelSelection !== null) {
    yield* store.apply({
      id: EventId.make(`event:${input.suffix}:run`),
      type: "run.created",
      threadId,
      runId,
      nodeId,
      providerInstanceId: input.runModelSelection.instanceId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: input.runModelSelection.instanceId,
        modelSelection: input.runModelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`user-message:${input.suffix}`),
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
  }
  const message: OrchestrationV2ConversationMessage = {
    createdBy: "agent",
    creationSource: "provider",
    id: MessageId.make(`message:${input.suffix}`),
    threadId,
    runId: input.runModelSelection === null ? null : runId,
    nodeId: input.runModelSelection === null ? null : nodeId,
    role: input.role ?? "assistant",
    text: input.text,
    attachments: [],
    streaming: input.streaming ?? false,
    createdAt: now,
    updatedAt: now,
  };
  yield* setMessageText(message, input.text);
  return message;
});

let revision = 0;

/** Re-projects the message with new text, like a provider editing it in place. */
export const setMessageText = Effect.fn("setMessageText")(function* (
  message: OrchestrationV2ConversationMessage,
  text: string,
) {
  const store = yield* ProjectionStoreV2;
  revision += 1;
  yield* store.apply({
    id: EventId.make(`event:${message.id}:text:${revision}`),
    type: "message.updated",
    threadId: message.threadId,
    ...(message.runId === null ? {} : { runId: message.runId }),
    occurredAt: yield* DateTime.now,
    payload: { ...message, text },
  });
});
