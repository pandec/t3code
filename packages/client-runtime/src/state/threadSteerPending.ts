import {
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import type { ThreadStructureTurnItem } from "./models.ts";

/**
 * Tells a steer that was handed over apart from one the model has read: providers only read a
 * mid-turn prompt before their next model request. Run item ordinals follow record order, so any
 * later main-agent output item proves a newer request. Derived from the projection alone, so it
 * survives reloads and shows on every device.
 */

/** The thread state a steer is resolved against. */
export interface SteerPendingThreadSnapshot {
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>;
  readonly turnItems: ReadonlyArray<ThreadStructureTurnItem>;
}

/**
 * How long a steer must stay unread before the marker appears. Providers
 * usually read a steer within a round trip, so this presentation grace period
 * suppresses the common flicker without claiming to prove provider-side queue
 * state.
 */
export const STEER_PENDING_REVEAL_DELAY_MS = 1_500;

const LIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "starting",
  "running",
  "waiting",
]);

/**
 * Items only a new model request produces. Updates keep an item's ordinal, so an earlier tool still
 * reporting progress never counts; subagent work lives in child threads. Known imprecision: a
 * sibling tool call from the same request recorded after the steer clears the marker early.
 */
const AGENT_PROGRESS_ITEM_TYPES: Record<OrchestrationV2TurnItem["type"], boolean> = {
  assistant_message: true,
  reasoning: true,
  proposed_plan: true,
  todo_list: true,
  user_input_request: true,
  secret_request: true,
  link_request: true,
  file_change: true,
  command_execution: true,
  file_search: true,
  web_search: true,
  approval_request: true,
  subagent: true,
  dynamic_tool: true,
  notification: false,
  user_message: false,
  checkpoint: false,
  run_interrupt_request: false,
  run_interrupt_result: false,
  system_notice: false,
  error: false,
  compaction: false,
  handoff: false,
  fork: false,
  thread_created: false,
};

/**
 * The steers on a live run that the agent has not reached yet, in timeline
 * order. Every way the run can end is a way out, since only live runs count.
 */
export function unreadSteerMessageIds(
  snapshot: SteerPendingThreadSnapshot,
): ReadonlyArray<MessageId> {
  const liveRunIds = new Set<RunId>();
  for (const run of snapshot.runs) {
    if (LIVE_RUN_STATUSES.has(run.status)) liveRunIds.add(run.id);
  }
  if (liveRunIds.size === 0) return [];

  const latestProgressOrdinal = new Map<RunId, number>();
  const steers: Array<{ runId: RunId; ordinal: number; messageId: MessageId }> = [];
  for (const item of snapshot.turnItems) {
    if (item.runId === null || item.parentItemId !== null || !liveRunIds.has(item.runId)) {
      continue;
    }
    if (item.type === "user_message") {
      if (item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer") {
        steers.push({ runId: item.runId, ordinal: item.ordinal, messageId: item.messageId });
      }
    } else if (AGENT_PROGRESS_ITEM_TYPES[item.type]) {
      const latest = latestProgressOrdinal.get(item.runId);
      if (latest === undefined || item.ordinal > latest) {
        latestProgressOrdinal.set(item.runId, item.ordinal);
      }
    }
  }
  return (
    steers
      .filter((steer) => steer.ordinal > (latestProgressOrdinal.get(steer.runId) ?? -1))
      // Not .toSorted(): Hermes on mobile lacks the ES2023 change-by-copy methods.
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((steer) => steer.messageId)
  );
}

const NO_STEER_MESSAGE_IDS: ReadonlySet<MessageId> = new Set();
const UNREAD_KEY_SEPARATOR = "\u0000";

/**
 * The unread steers as a content key. Client hooks cache the set on it, so projection updates
 * that leave the unread set unchanged neither restart the reveal timer nor change its identity.
 */
export function unreadSteerKey(snapshot: SteerPendingThreadSnapshot | null): string {
  return snapshot === null ? "" : unreadSteerMessageIds(snapshot).join(UNREAD_KEY_SEPARATOR);
}

export function unreadSteerSet(key: string): ReadonlySet<MessageId> {
  return key === ""
    ? NO_STEER_MESSAGE_IDS
    : new Set(key.split(UNREAD_KEY_SEPARATOR).map((id) => MessageId.make(id)));
}

/**
 * Whether the reveal timer should run: some unread steer is not revealed yet. A steer arriving
 * before the first is revealed delays both; one arriving after does not hide the first.
 */
export function steerRevealPending(
  unread: ReadonlySet<MessageId>,
  revealed: ReadonlySet<MessageId>,
): boolean {
  for (const messageId of unread) {
    if (!revealed.has(messageId)) return true;
  }
  return false;
}

/** The steers that show a marker: still unread and revealed. A resolved steer drops out at once. */
export function revealedSteerMessageIds(
  unread: ReadonlySet<MessageId>,
  revealed: ReadonlySet<MessageId>,
): ReadonlySet<MessageId> {
  if (unread.size === 0 || revealed.size === 0) return NO_STEER_MESSAGE_IDS;
  const visible = new Set<MessageId>();
  for (const messageId of unread) {
    if (revealed.has(messageId)) visible.add(messageId);
  }
  return visible.size === 0 ? NO_STEER_MESSAGE_IDS : visible;
}
