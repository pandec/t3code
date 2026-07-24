import { useAtomValue } from "@effect/atom-react";
import { createThreadOutboxManager } from "@t3tools/client-runtime/state/thread-outbox-manager";
import {
  scopedThreadKey as outboxScopedThreadKey,
  type QueuedThreadMessage,
} from "@t3tools/client-runtime/state/thread-outbox-model";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { localThreadOutboxStorage } from "./threadOutboxStorage";

export const threadOutboxManager = createThreadOutboxManager({
  registry: appAtomRegistry,
  storage: localThreadOutboxStorage,
  atomLabel: "web:thread-outbox:queued-messages",
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

export function removeThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.remove(message);
}

/** The queued message the drain is currently delivering, if any. */
export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web:thread-outbox:dispatching-message-id"),
);

/**
 * Queued messages the outbox drain must not deliver right now because an
 * editing session is moving them back into the composer; delivering mid-edit
 * would send content the user is about to change.
 */
export const editingQueuedMessageIdsAtom = Atom.make<Readonly<Record<MessageId, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("web:thread-outbox:editing-message-ids"),
);

export function holdEditingQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (current[messageId]) {
    return;
  }
  appAtomRegistry.set(editingQueuedMessageIdsAtom, { ...current, [messageId]: true });
}

export function releaseEditingQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (!current[messageId]) {
    return;
  }
  const next = { ...current };
  delete next[messageId];
  appAtomRegistry.set(editingQueuedMessageIdsAtom, next);
}

export function useThreadOutboxMessages(): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  return useAtomValue(threadOutboxManager.queuedMessagesByThreadKeyAtom);
}

const EMPTY_QUEUE: ReadonlyArray<QueuedThreadMessage> = [];

export function useQueuedThreadMessages(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<QueuedThreadMessage> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  if (threadRef === null) {
    return EMPTY_QUEUE;
  }
  return (
    queuedMessagesByThreadKey[outboxScopedThreadKey(threadRef.environmentId, threadRef.threadId)] ??
    EMPTY_QUEUE
  );
}
