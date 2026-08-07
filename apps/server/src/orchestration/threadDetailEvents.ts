import type { OrchestrationEvent } from "@t3tools/contracts";

/**
 * The event types a thread-detail subscription delivers.
 *
 * This list has two consumers that MUST agree:
 *
 * 1. `ws.ts`'s `isThreadDetailEvent`, which filters both the live stream and
 *    the catch-up replay.
 * 2. The `threadSequence` watermark query in
 *    `Layers/ProjectionSnapshotQuery.ts`, which reports the highest thread
 *    event sequence a windowed page reflects.
 *
 * If the watermark counted an event type the subscription never delivers, a
 * client waiting to reach that sequence before merging an older page would
 * park forever. If the subscription delivered a type the watermark ignored,
 * the page could be merged before the client caught up. Hence one constant.
 *
 * `thread.history-imported` is fork-only (session import); it is a genuine
 * detail event and belongs in both lists.
 */
export const THREAD_DETAIL_EVENT_TYPES = [
  "thread.message-sent",
  "thread.history-imported",
  "thread.proposed-plan-upserted",
  "thread.activity-appended",
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.session-set",
] as const satisfies ReadonlyArray<OrchestrationEvent["type"]>;

export type ThreadDetailEventType = (typeof THREAD_DETAIL_EVENT_TYPES)[number];

const THREAD_DETAIL_EVENT_TYPE_SET: ReadonlySet<string> = new Set(THREAD_DETAIL_EVENT_TYPES);

export function isThreadDetailEvent(
  event: OrchestrationEvent,
): event is Extract<OrchestrationEvent, { type: ThreadDetailEventType }> {
  return THREAD_DETAIL_EVENT_TYPE_SET.has(event.type);
}
