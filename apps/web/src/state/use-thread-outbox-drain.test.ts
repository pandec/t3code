import {
  threadOutboxFlushBatchIds,
  type ThreadOutboxDispatchResult,
} from "@t3tools/client-runtime/state/thread-outbox-delivery";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadOutboxDeliveryAction,
  selectNextQueuedThreadDispatch,
  type QueuedThreadMessage,
} from "@t3tools/client-runtime/state/thread-outbox-model";

function queuedMessage(messageId: string): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make(messageId),
    commandId: CommandId.make(`command-${messageId}`),
    text: messageId,
    attachments: [],
    createdAt: "2026-09-04T10:00:00.000Z",
  };
}

describe("web thread outbox flush batches", () => {
  it("keeps later rows behind a leader deferred after confirmation", () => {
    const leader = queuedMessage("web-race-leader");
    const follower = queuedMessage("web-race-follower");
    const queue = [leader, follower];
    const resolveAction = (threadStatus: "idle" | "running") =>
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadStatus,
        deliveryIntent: "queue",
      });
    const selected = selectNextQueuedThreadDispatch(queue, {
      isHeld: () => false,
      resolveAction: () => resolveAction("idle"),
    });
    expect(selected).toEqual({ message: leader, action: "send" });

    // Another client starts a turn while confirmQueued is pending.
    const freshAction = resolveAction("running");
    const result: ThreadOutboxDispatchResult =
      freshAction === selected?.action
        ? {
            outcome: "delivered",
            context: {
              sessionBaselineKnown: true,
              sessionStatus: "running",
              sessionUpdatedAt: null,
              latestTurnId: null,
            },
          }
        : { outcome: "deferred" };

    expect(result).toEqual({ outcome: "deferred" });
    expect(threadOutboxFlushBatchIds(queue, leader, { result, action: "send" }).size).toBe(0);
    expect(
      selectNextQueuedThreadDispatch(queue, {
        isHeld: () => false,
        resolveAction: () => freshAction,
      }),
    ).toBeNull();
  });
});
