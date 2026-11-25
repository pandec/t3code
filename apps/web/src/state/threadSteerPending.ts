import {
  revealedSteerMessageIds,
  STEER_PENDING_REVEAL_DELAY_MS,
  steerRevealPending,
  unreadSteerKey,
  unreadSteerSet,
  type SteerPendingThreadSnapshot,
} from "@t3tools/client-runtime/state/thread-steer-pending";
import type { MessageId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

const NO_REVEALED_MESSAGE_IDS: ReadonlySet<MessageId> = new Set();

/**
 * Derived from the thread projection so it holds after reload, on other devices, and
 * after navigating back. The only local state is the reveal delay: a marker shows once a
 * steer stays unread for `STEER_PENDING_REVEAL_DELAY_MS`, hiding ones read within a round trip.
 */
export function useSteerPendingMessageIds(
  snapshot: SteerPendingThreadSnapshot | null,
): ReadonlySet<MessageId> {
  return useRevealedSteerMessageIds(unreadSteerKey(snapshot));
}

// Takes the string key so the compiler caches the set on content, not on each projection
// update; a new set identity would restart the reveal timer while a turn streams.
function useRevealedSteerMessageIds(unreadKey: string): ReadonlySet<MessageId> {
  const unread = unreadSteerSet(unreadKey);
  const [revealed, setRevealed] = useState<ReadonlySet<MessageId>>(NO_REVEALED_MESSAGE_IDS);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals held steers after the delay
  useEffect(() => {
    if (!steerRevealPending(unread, revealed)) return;
    const timer = setTimeout(() => setRevealed(unread), STEER_PENDING_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [revealed, unread]);

  return revealedSteerMessageIds(unread, revealed);
}
