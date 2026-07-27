import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  type QueuedThreadMessage,
  scopedThreadKey,
} from "@t3tools/client-runtime/state/thread-outbox-model";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  editingQueuedMessageIdsAtom,
  holdEditingQueuedMessage,
  isThreadOutboxMessageQueued,
  releaseEditingQueuedMessage,
  threadOutboxManager,
} from "./threadOutbox";

afterEach(() => {
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
  appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
});

describe("web queued-message edit holds", () => {
  it("grants one exclusive owner until release", () => {
    const messageId = MessageId.make("queued-message");
    expect(holdEditingQueuedMessage(messageId)).toBe(true);
    expect(holdEditingQueuedMessage(messageId)).toBe(false);
    releaseEditingQueuedMessage(messageId);
    expect(holdEditingQueuedMessage(messageId)).toBe(true);
  });
});

describe("isThreadOutboxMessageQueued", () => {
  const environmentId = EnvironmentId.make("environment");
  const threadId = ThreadId.make("thread");
  const message: QueuedThreadMessage = {
    environmentId,
    threadId,
    messageId: MessageId.make("queued-message"),
    commandId: CommandId.make("command"),
    text: "queued text",
    attachments: [],
    createdAt: new Date(0).toISOString(),
  };

  it("recognises a row that is still queued", () => {
    appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
      [scopedThreadKey(environmentId, threadId)]: [message],
    });
    expect(isThreadOutboxMessageQueued(message)).toBe(true);
  });

  it("rejects a row that has already left the queue", () => {
    appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
      [scopedThreadKey(environmentId, threadId)]: [],
    });
    expect(isThreadOutboxMessageQueued(message)).toBe(false);
  });

  it("rejects a row whose thread has no queue at all", () => {
    expect(isThreadOutboxMessageQueued(message)).toBe(false);
  });
});
