import {
  STEER_PENDING_REVEAL_DELAY_MS,
  unreadSteerMessageIds,
  type SteerPendingThreadSnapshot,
} from "@t3tools/client-runtime/state/thread-steer-pending";
import { MessageId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

// Mirror of apps/mobile/src/state/thread-steer-pending.ts. Keep in sync.
const NO_PENDING_MESSAGE_IDS: ReadonlySet<MessageId> = new Set();
const UNREAD_KEY_SEPARATOR = "\u0000";

/**
 * The user messages whose steer is still sitting in the provider's prompt
 * queue, derived from thread state so the answer is the same after a reload,
 * on another device, and after navigating away and back. The only local
 * memory is the reveal delay: a steer shows its marker once it has stayed
 * unread for `STEER_PENDING_REVEAL_DELAY_MS` on this client, which hides the
 * ones a provider reads within a round trip.
 */
export function useSteerPendingMessageIds(
  snapshot: SteerPendingThreadSnapshot,
): ReadonlySet<MessageId> {
  // Keyed by content, and the Set rebuilt from the key rather than the array,
  // so subagent chatter that leaves the unread set unchanged neither restarts
  // the reveal timer nor needs a ref to keep Set identity stable.
  const unreadKey = useMemo(
    () => unreadSteerMessageIds(snapshot).join(UNREAD_KEY_SEPARATOR),
    [snapshot],
  );
  const unread = useMemo(
    () =>
      unreadKey === ""
        ? NO_PENDING_MESSAGE_IDS
        : new Set(unreadKey.split(UNREAD_KEY_SEPARATOR).map((id) => MessageId.make(id))),
    [unreadKey],
  );
  const [revealed, setRevealed] = useState<ReadonlySet<MessageId>>(NO_PENDING_MESSAGE_IDS);

  // A steer that resolves drops out of `unread` at once; one that stays is
  // revealed once the delay passes. A second steer arriving before the first
  // is revealed delays both; one arriving after does not hide the first.
  useEffect(() => {
    let allRevealed = true;
    for (const messageId of unread) {
      if (!revealed.has(messageId)) {
        allRevealed = false;
        break;
      }
    }
    if (allRevealed) {
      return;
    }
    const timer = setTimeout(() => {
      setRevealed(unread);
    }, STEER_PENDING_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [revealed, unread]);

  return useMemo(() => {
    if (unread.size === 0 || revealed.size === 0) {
      return NO_PENDING_MESSAGE_IDS;
    }
    const visible = new Set<MessageId>();
    for (const messageId of unread) {
      if (revealed.has(messageId)) {
        visible.add(messageId);
      }
    }
    return visible.size === 0 ? NO_PENDING_MESSAGE_IDS : visible;
  }, [revealed, unread]);
}
