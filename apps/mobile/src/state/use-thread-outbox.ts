import { useAtomValue } from "@effect/atom-react";
import type { ThreadOutboxDeliveryContext } from "@t3tools/client-runtime/state/thread-outbox-delivery";
import type { QueuedThreadMessage } from "@t3tools/client-runtime/state/thread-outbox-model";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, MessageId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { environmentShell } from "./shell";
import { threadOutboxManager } from "./thread-outbox";
import type { ThreadOutboxProjectionHold } from "./thread-outbox-projection";

export {
  threadOutboxProjectionCaughtUp,
  type ThreadOutboxProjectionHold,
} from "./thread-outbox-projection";

const threadOutboxShellStatusesAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, EnvironmentShellStatus> => {
    const statuses = new Map<EnvironmentId, EnvironmentShellStatus>();
    for (const queue of Object.values(get(threadOutboxManager.queuedMessagesByThreadKeyAtom))) {
      const environmentId = queue[0]?.environmentId;
      if (environmentId !== undefined && !statuses.has(environmentId)) {
        statuses.set(environmentId, get(environmentShell.stateValueAtom(environmentId)).status);
      }
    }
    return statuses;
  },
).pipe(Atom.withLabel("mobile:thread-outbox:shell-statuses"));

export const threadOutboxProjectionHoldsAtom = Atom.make<
  Readonly<Record<string, ThreadOutboxProjectionHold>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-outbox:projection-holds"));

export function noteThreadOutboxStartAccepted(
  message: QueuedThreadMessage,
  context: ThreadOutboxDeliveryContext,
): void {
  if (context.sessionStatus === "running") return;
  const key = scopedThreadKey(message.environmentId, message.threadId);
  appAtomRegistry.set(threadOutboxProjectionHoldsAtom, {
    ...appAtomRegistry.get(threadOutboxProjectionHoldsAtom),
    [key]: {
      environmentId: message.environmentId,
      threadId: message.threadId,
      previousTurnId: context.latestTurnId,
    },
  });
}

/**
 * Queued pending tasks the outbox drain must not deliver right now: the one
 * open in the new-task editor, plus any whose latest edits could not be saved
 * back yet (delivering those would send stale content). Editing sessions hold
 * their message id here and release it once the queued payload is current.
 */
export const editingQueuedMessageIdsAtom = Atom.make<Readonly<Record<MessageId, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:editing-message-ids"),
);

/**
 * Steers the user asked to send now, skipping the rest of their grace window.
 * In memory only: after a reload the window has elapsed anyway.
 */
export const expeditedQueuedMessageIdsAtom = Atom.make<Readonly<Record<MessageId, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:expedited-message-ids"),
);

export function expediteQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(expeditedQueuedMessageIdsAtom);
  if (current[messageId]) {
    return;
  }
  appAtomRegistry.set(expeditedQueuedMessageIdsAtom, { ...current, [messageId]: true });
}

export function unexpediteQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(expeditedQueuedMessageIdsAtom);
  if (!current[messageId]) {
    return;
  }
  const next = { ...current };
  delete next[messageId];
  appAtomRegistry.set(expeditedQueuedMessageIdsAtom, next);
}

/** Acquires the edit hold and reports whether this caller owns it. */
export function holdEditingQueuedMessage(messageId: MessageId): boolean {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (current[messageId]) {
    return false;
  }
  appAtomRegistry.set(editingQueuedMessageIdsAtom, { ...current, [messageId]: true });
  return true;
}

/** Ensures a retained drain latch exists when ownership may be adopted later. */
export function ensureEditingQueuedMessageHeld(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (!current[messageId]) {
    appAtomRegistry.set(editingQueuedMessageIdsAtom, { ...current, [messageId]: true });
  }
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

export function useThreadOutboxMessages() {
  return useAtomValue(threadOutboxManager.queuedMessagesByThreadKeyAtom);
}

export function useThreadOutboxLoadState() {
  return useAtomValue(threadOutboxManager.loadStateAtom);
}

export function useThreadOutboxProjectionHolds() {
  return useAtomValue(threadOutboxProjectionHoldsAtom);
}

export function useThreadOutboxShellStatuses() {
  return useAtomValue(threadOutboxShellStatusesAtom);
}
