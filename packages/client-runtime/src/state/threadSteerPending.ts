import type {
  MessageId,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";

/**
 * Steering is not the same as being heard. Claude Code, Codex and OpenCode
 * hold a mid-turn prompt and only read it before the next model request, so a
 * steer sent behind a long subagent or shell call can sit unread for minutes
 * while the timeline keeps moving. This module tells the two apart from the
 * thread projection alone so the message bubble can say which one it is.
 *
 * A steer is a `user_message` item with a steer input intent on a live run.
 * The server allocates item ordinals per run in the order it first records
 * them, so any main-agent output item with a higher ordinal was produced by a
 * model request made after the steer was handed over. Nothing is client-local:
 * the marker survives reloads and shows on every device.
 */

/** The thread state a steer is resolved against. */
export interface SteerPendingThreadSnapshot {
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
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
 * Items only a new model request produces. Updates to an item keep its
 * ordinal, so a tool that started before the steer and is still reporting
 * progress never counts. Subagent work lives in child threads, so it never
 * shows up here. Known imprecision: a sibling tool call from the same model
 * request that the server records after the steer clears the marker early.
 */
const AGENT_PROGRESS_ITEM_TYPES: Record<OrchestrationV2TurnItem["type"], boolean> = {
  assistant_message: true,
  reasoning: true,
  proposed_plan: true,
  todo_list: true,
  user_input_request: true,
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
