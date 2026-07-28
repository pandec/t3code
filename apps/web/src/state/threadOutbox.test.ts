import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  createThreadOutboxManager,
  ThreadOutboxManagerError,
} from "@t3tools/client-runtime/state/thread-outbox-manager";
import {
  type QueuedThreadMessage,
  scopedThreadKey,
} from "@t3tools/client-runtime/state/thread-outbox-model";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  describeThreadOutboxEnqueueFailure,
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

describe("describeThreadOutboxEnqueueFailure", () => {
  const quotaError = () => new DOMException("exceeded", "QuotaExceededError");

  it("explains what to clear when storage is full", () => {
    const described = describeThreadOutboxEnqueueFailure(quotaError());
    expect(described).toContain("local storage is full or unavailable");
    expect(described).toContain("still in the composer");
  });

  it("finds the quota rejection the manager wrapped in cause", () => {
    // The real path never throws the DOMException directly: the manager catches
    // the storage rejection and rethrows its own error carrying the cause.
    const wrapped = new ThreadOutboxManagerError({
      operation: "enqueue",
      environmentId: null,
      threadId: null,
      messageId: null,
      cause: quotaError(),
    });
    expect(describeThreadOutboxEnqueueFailure(wrapped)).toContain(
      "local storage is full or unavailable",
    );
  });

  it("recognises the Firefox spelling of the same condition", () => {
    const firefoxQuota = new DOMException("exceeded", "NS_ERROR_DOM_QUOTA_REACHED");
    expect(describeThreadOutboxEnqueueFailure(firefoxQuota)).toContain(
      "local storage is full or unavailable",
    );
  });

  it("passes an unrelated failure through unchanged", () => {
    expect(describeThreadOutboxEnqueueFailure(new Error("disk on fire"))).toBe("disk on fire");
  });

  it("falls back to a generic message for a non-Error rejection", () => {
    expect(describeThreadOutboxEnqueueFailure("nope")).toBe("Failed to queue message.");
  });
});

describe("thread outbox enqueue durability", () => {
  const environmentId = EnvironmentId.make("environment");
  const threadId = ThreadId.make("thread");
  const message: QueuedThreadMessage = {
    environmentId,
    threadId,
    messageId: MessageId.make("quota-rejected-message"),
    commandId: CommandId.make("command"),
    text: "message the composer must keep",
    attachments: [],
    createdAt: new Date(0).toISOString(),
  };

  const managerRejectingWriteWith = (cause: unknown) =>
    createThreadOutboxManager({
      registry: appAtomRegistry,
      storage: {
        load: () => Promise.resolve([]),
        write: () => Promise.reject(cause),
        remove: () => Promise.resolve(),
      },
      atomLabel: "test:thread-outbox:quota",
      warn: () => {},
    });

  it("queues nothing when the durable write is rejected", async () => {
    // ChatView only clears the composer after enqueue resolves, so this
    // rejection is what keeps the user's content on screen. A message that
    // reached the in-memory queue anyway would look sent and never deliver.
    const manager = managerRejectingWriteWith(new DOMException("exceeded", "QuotaExceededError"));

    await expect(manager.enqueue(message)).rejects.toThrow();
    expect(appAtomRegistry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
  });

  it("describes the rejection the real manager produces", async () => {
    // The seam this fix depends on: the manager must keep the storage
    // rejection reachable as `cause`. Asserting against a hand-built wrapper
    // would keep passing if the manager stopped carrying it, while production
    // silently fell back to the opaque id-only message.
    const manager = managerRejectingWriteWith(new DOMException("exceeded", "QuotaExceededError"));

    const rejection = await manager.enqueue(message).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).not.toBe(null);
    expect(describeThreadOutboxEnqueueFailure(rejection)).toContain(
      "local storage is full or unavailable",
    );
  });
});
