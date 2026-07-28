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

/**
 * Browsers signal a full localStorage as a DOMException, but not consistently:
 * Firefox reports `NS_ERROR_DOM_QUOTA_REACHED`, and older engines set only the
 * legacy numeric code. Match all three so the actionable message below is not
 * decided by which engine the desktop shell happens to embed.
 */
function isQuotaExceededError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return (
      error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      error.code === 22
    );
  }
  return error instanceof Error && error.name === "QuotaExceededError";
}

/**
 * The outbox writes a message to storage before queueing it, so a rejection
 * means nothing was queued and the composer still holds the content. Callers
 * surface this as the thread error, so a full-storage rejection has to say what
 * to clear — `ThreadOutboxManagerError.message` only names opaque ids, which
 * leaves a repeatable failure looking like an internal fault.
 */
export function describeThreadOutboxEnqueueFailure(error: unknown): string {
  // The manager wraps the storage rejection, so the quota signal is one level
  // down in `cause`; check the wrapper too in case a caller passes it raw.
  const cause = error instanceof Error ? (error.cause as unknown) : undefined;
  if (isQuotaExceededError(error) || isQuotaExceededError(cause)) {
    // Deliberately "full or unavailable": the spec throws the same
    // QuotaExceededError when storage is disabled or has zero quota, where
    // clearing anything would not help. Naming both keeps the remedy honest.
    return "Could not queue the message: this app's local storage is full or unavailable. If it is full, clear stashed prompts (⌘S badge) or queued messages, then send again. Your message is still in the composer.";
  }
  return error instanceof Error ? error.message : "Failed to queue message.";
}

/** Rewrite a queued message; no-op (false) if it was removed in the meantime. */
export function updateThreadOutboxMessage(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.update(message);
}

/** Removes an extant message and reports whether this caller owned the removal. */
export function removeThreadOutboxMessage(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.remove(message);
}

/** The queued message the drain is currently delivering, if any. */
export const dispatchingQueuedMessageAtom = Atom.make<QueuedThreadMessage | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web:thread-outbox:dispatching-message"),
);

/**
 * A composer send must join the outbox while its thread already has pending
 * work. The live registry read closes the completion-to-next-turn race where
 * React still renders an idle shell while the drain owns the previous row.
 */
export function hasPendingThreadOutboxWork(threadRef: ScopedThreadRef): boolean {
  const dispatching = appAtomRegistry.get(dispatchingQueuedMessageAtom);
  if (
    dispatching?.environmentId === threadRef.environmentId &&
    dispatching.threadId === threadRef.threadId
  ) {
    return true;
  }
  const threadKey = outboxScopedThreadKey(threadRef.environmentId, threadRef.threadId);
  return (
    (appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom)[threadKey]?.length ??
      0) > 0
  );
}

/**
 * Whether the row is still queued. Actions reached from a stale render or from
 * a toast that outlived its message must not re-open one that is already gone:
 * the composer would gain a second copy of content it already holds.
 */
export function isThreadOutboxMessageQueued(message: QueuedThreadMessage): boolean {
  const threadKey = outboxScopedThreadKey(message.environmentId, message.threadId);
  const queuedMessages = appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom);
  return (
    queuedMessages[threadKey]?.some((candidate) => candidate.messageId === message.messageId) ??
    false
  );
}

/**
 * Queued messages the outbox drain must not deliver right now because an
 * editing session is moving them back into the composer; delivering mid-edit
 * would send content the user is about to change.
 */
export const editingQueuedMessageIdsAtom = Atom.make<Readonly<Record<MessageId, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("web:thread-outbox:editing-message-ids"),
);

/** Acquires the edit hold and reports whether this caller owns it. */
/**
 * Steers the user asked to send now, skipping the rest of their grace window.
 * In memory only: after a reload the window has elapsed anyway.
 */
export const expeditedQueuedMessageIdsAtom = Atom.make<Readonly<Record<MessageId, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("web:thread-outbox:expedited-message-ids"),
);

export function expediteQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(expeditedQueuedMessageIdsAtom);
  if (current[messageId]) {
    return;
  }
  appAtomRegistry.set(expeditedQueuedMessageIdsAtom, { ...current, [messageId]: true });
}

export function holdEditingQueuedMessage(messageId: MessageId): boolean {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (current[messageId]) {
    return false;
  }
  appAtomRegistry.set(editingQueuedMessageIdsAtom, { ...current, [messageId]: true });
  return true;
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
