import { appAtomRegistry } from "./atom-registry";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import { queuedThreadMessageIntent, type QueuedThreadMessage } from "./thread-outbox-model";
import { expoThreadOutboxStorage, flushThreadOutboxWrites } from "./thread-outbox-storage";

export * from "./thread-outbox-model";

/**
 * Holds a steer until device preferences have loaded. The grace window is one
 * of them, so dispatching before they arrive would deliver with the default
 * window — including for a device that set the window longer, or to zero.
 * Queued messages are unaffected: their hold is the running turn.
 */
export function isThreadOutboxMessageWaitingForPreferences(
  message: Pick<QueuedThreadMessage, "deliveryIntent">,
  preferencesHydrated: boolean,
  expedited: boolean,
): boolean {
  return !preferencesHydrated && !expedited && queuedThreadMessageIntent(message) === "steer";
}

export const threadOutboxManager = createThreadOutboxManager({
  registry: appAtomRegistry,
  storage: expoThreadOutboxStorage,
  atomLabel: "mobile:thread-outbox:queued-messages",
  warn: (message, error) => {
    console.warn(message, error);
  },
});

/**
 * Lands queued outbox mutations before the JS runtime is torn down (app update
 * restart). An enqueued message is published to the atom immediately but its
 * durable write waits behind the mutation queue, so draining only the writes
 * already mid-file would miss it.
 */
export async function flushThreadOutbox(): Promise<void> {
  await threadOutboxManager.serialize(async () => {});
  await flushThreadOutboxWrites();
}

export async function ensureThreadOutboxLoaded(): Promise<void> {
  await threadOutboxManager.load();
}

export function enqueueThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.enqueue(message);
}

/** Waits for pending writes to settle; false if the message was rolled back. */
export function confirmThreadOutboxMessageQueued(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.confirmQueued(message);
}

/**
 * Rewrite a queued message; no-op (false) if it was removed in the meantime,
 * or (with `expectedRevision` from `threadOutboxRevision`) if any other write
 * was accepted since the revision was read.
 */
export function updateThreadOutboxMessage(
  message: QueuedThreadMessage,
  expectedRevision?: number,
): Promise<boolean> {
  return threadOutboxManager.update(message, expectedRevision);
}

/** Snapshot of a queued message's write revision, for update's CAS. */
export function threadOutboxRevision(messageId: QueuedThreadMessage["messageId"]): number {
  return threadOutboxManager.revisionOf(messageId);
}

// Removal lives in `thread-outbox-removal.ts`: taking a message out of the
// outbox must also release its local attachment files, and that owner needs
// the composer draft state this module must not depend on.
