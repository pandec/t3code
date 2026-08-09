import { useAtomValue } from "@effect/atom-react";
import type { ThreadOutboxDeliveryContext } from "@t3tools/client-runtime/state/thread-outbox-delivery";
import {
  createThreadSteerPendingStore,
  latestParentAgentProgressAt,
  nextSteerPendingRevealDelayMs,
  revealedSteerPendingMessageIds,
  shouldTrackSteerDispatch,
  unreadSteerDispatches,
  type SteerPendingThreadSnapshot,
} from "@t3tools/client-runtime/state/thread-steer-pending";
import type { MessageId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { appAtomRegistry } from "./atom-registry";
import {
  queuedThreadMessageIntent,
  scopedThreadKey,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { environmentThreadDetails } from "./threads";

const EMPTY_PENDING: ReadonlyArray<never> = [];
const NO_PENDING_MESSAGE_IDS: ReadonlySet<MessageId> = new Set();

export const threadSteerPendingStore = createThreadSteerPendingStore({
  registry: appAtomRegistry,
  atomLabel: "mobile:thread-steer-pending",
});

/**
 * Records a delivered message that steered into a turn already in flight, so
 * its bubble can say the agent has not read it yet. Called from the outbox
 * drain; non-steers and steers that started their own turn are ignored.
 */
export function noteThreadSteerDispatch(
  message: QueuedThreadMessage,
  context: ThreadOutboxDeliveryContext,
): void {
  if (
    !shouldTrackSteerDispatch({
      deliveryIntent: queuedThreadMessageIntent(message),
      sessionStatus: context.sessionStatus,
    })
  ) {
    return;
  }
  const detail = appAtomRegistry.get(
    environmentThreadDetails.detailAtom({
      environmentId: message.environmentId,
      threadId: message.threadId,
    }),
  );
  threadSteerPendingStore.track(scopedThreadKey(message.environmentId, message.threadId), {
    messageId: message.messageId,
    dispatchedAt: new Date().toISOString(),
    progressWatermarkAt: detail === null ? null : latestParentAgentProgressAt(detail),
    turnId: context.latestTurnId,
  });
}

/**
 * The user messages whose steer is still sitting in the provider's prompt
 * queue. Resolved records are pruned as they clear, and leaving the thread
 * forgets them — the marker describes what this client is waiting for right
 * now, not durable thread state.
 */
export function useSteerPendingMessageIds(
  threadKey: string | null,
  snapshot: SteerPendingThreadSnapshot,
): ReadonlySet<MessageId> {
  const pendingByThreadKey = useAtomValue(threadSteerPendingStore.pendingByThreadKeyAtom);
  const [revealTick, setRevealTick] = useState(0);
  const tracked = (threadKey === null ? undefined : pendingByThreadKey[threadKey]) ?? EMPTY_PENDING;
  const pending = unreadSteerDispatches(tracked, snapshot);

  useEffect(() => {
    threadSteerPendingStore.retain(threadKey);
    return () => {
      threadSteerPendingStore.release(threadKey);
    };
  }, [threadKey]);

  useEffect(() => {
    if (threadKey !== null && pending !== tracked) {
      threadSteerPendingStore.setThread(threadKey, pending);
    }
  }, [pending, threadKey, tracked]);

  // Nothing else re-renders when a steer outlives the reveal delay.
  useEffect(() => {
    const revealDelayMs = nextSteerPendingRevealDelayMs(pending, Date.now());
    if (revealDelayMs === null) {
      return;
    }
    const timer = setTimeout(() => {
      setRevealTick((current) => current + 1);
    }, revealDelayMs);
    return () => clearTimeout(timer);
  }, [pending, revealTick]);

  return useMemo(
    () =>
      pending.length === 0
        ? NO_PENDING_MESSAGE_IDS
        : revealedSteerPendingMessageIds(pending, Date.now()),
    // `revealTick` is the clock: it fires exactly when the next steer is due.
    [pending, revealTick],
  );
}
