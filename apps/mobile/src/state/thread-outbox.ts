import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import { queuedThreadMessageIntent, type QueuedThreadMessage } from "./thread-outbox-model";
import { expoThreadOutboxStorage } from "./thread-outbox-storage";

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

export function ensureThreadOutboxLoaded(): void {
  void threadOutboxManager.load();
}

export function enqueueThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.enqueue(message);
}

/** Rewrite a queued message; no-op (false) if it was removed in the meantime. */
export function updateThreadOutboxMessage(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.update(message);
}

/** Removes an extant message and reports whether this caller owned the removal. */
export function removeThreadOutboxMessage(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.remove(message);
}

export function clearThreadOutboxEnvironment(environmentId: EnvironmentId): Promise<void> {
  return threadOutboxManager.clearEnvironment(environmentId);
}
