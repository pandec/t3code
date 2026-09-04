import type {
  MessageId,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

import { isAgentAttributedToolActivity, isTimelineBypassActivity } from "./subagentRuntime.ts";

/**
 * Steering is not the same as being heard. Claude Code holds a mid-turn prompt
 * in its own queue and only reads it between a tool result and the next model
 * request, so a steer sent behind a long `Agent` or `Bash` call can sit unread
 * for minutes while the timeline keeps scrolling. This module tells the two
 * apart from thread state alone so the message bubble can say which one it is.
 *
 * A steer is a user message that joined a turn already running: the server
 * records it with a null turn id and a `createdAt` later than the running
 * turn's `requestedAt`. Both timestamps are server-stamped (the server replaces
 * the client's `createdAt` on receipt, and adapters stamp activities with the
 * server clock), so every comparison here is between server readings. Nothing
 * is client-local: the marker survives reloads and shows on every device.
 */

/** The thread state a steer is resolved against. */
export interface SteerPendingThreadSnapshot {
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state" | "requestedAt"> | null;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationMessage, "id" | "role" | "turnId" | "createdAt">
  >;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

/**
 * How long a steer must stay unresolved before the marker appears. Adapters
 * that hand a mid-turn prompt straight to the provider usually resolve it
 * within a round trip — Codex opens a fresh turn for it, and a Claude steer can
 * land on a drain point — so this presentation grace period suppresses the
 * common flicker without claiming to prove provider-side queue state.
 */
export const STEER_PENDING_REVEAL_DELAY_MS = 1_500;

/**
 * The only activity kind useful as evidence that the main agent issued a new
 * model request and drained its prompt queue on the way there.
 *
 * Everything else a blocked parent emits keeps arriving while the queue is
 * still unread: a subagent's `task.*` rows carry no `agentId` (that field marks
 * a task launched from *inside* an agent, not one that launched it),
 * `tool.progress` heartbeats tick for the running tool, and
 * `context-window.updated` can fire when subagent task progress reports a
 * larger token total. Treating any of those as "read" would clear the marker
 * almost immediately and make it useless.
 *
 * Known imprecision: when the parent issues several tool calls in one request,
 * a sibling `tool.started` can arrive after the steer without a new model
 * request. It is indistinguishable from a post-drain call and clears the marker
 * early, falling back to the previous unmarked presentation.
 */
const PARENT_AGENT_PROGRESS_ACTIVITY_KIND = "tool.started";

/** Whether an activity is the main agent starting a tool, not a subagent's. */
export function isParentAgentProgressActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === PARENT_AGENT_PROGRESS_ACTIVITY_KIND &&
    !isAgentAttributedToolActivity(activity) &&
    !isTimelineBypassActivity(activity)
  );
}

function parsedTimestamp(value: string | null | undefined): number {
  if (value == null) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * The newest main-agent progress timestamp in a thread. Assistant messages
 * count alongside tool starts: a turn that answers in prose never starts
 * another tool.
 */
export function latestParentAgentProgressAt(
  snapshot: Pick<SteerPendingThreadSnapshot, "messages" | "activities">,
): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  const consider = (candidate: string): void => {
    const candidateMs = parsedTimestamp(candidate);
    if (candidateMs > latestMs) {
      latest = candidate;
      latestMs = candidateMs;
    }
  };
  for (const message of snapshot.messages) {
    if (message.role === "assistant") {
      consider(message.createdAt);
    }
  }
  for (const activity of snapshot.activities) {
    if (isParentAgentProgressActivity(activity)) {
      consider(activity.createdAt);
    }
  }
  return latest;
}

/**
 * The user messages steered into the running turn that the agent has not
 * reached yet, in timeline order. Every way the turn can end is a way out:
 * completion, interruption, an error, a lost session, and a provider that
 * answered the steer by opening its own turn (the steer's message then carries
 * no evidence it queued behind anything, and the turn it joined is no longer
 * current). Within a live turn, the first main-agent tool start or assistant
 * message after a steer proves the queue drained past it.
 */
export function unreadSteerMessageIds(
  snapshot: SteerPendingThreadSnapshot,
): ReadonlyArray<MessageId> {
  if (snapshot.sessionStatus !== "running") {
    return [];
  }
  const latestTurn = snapshot.latestTurn;
  if (latestTurn === null || latestTurn.state !== "running") {
    return [];
  }
  const turnRequestedAtMs = parsedTimestamp(latestTurn.requestedAt);
  const progressMs = parsedTimestamp(latestParentAgentProgressAt(snapshot));
  const unread: Array<MessageId> = [];
  for (const message of snapshot.messages) {
    if (message.role !== "user" || message.turnId !== null) {
      continue;
    }
    const createdAtMs = parsedTimestamp(message.createdAt);
    // The turn's own opening message shares its requestedAt; only later ones steered.
    if (createdAtMs <= turnRequestedAtMs || createdAtMs <= progressMs) {
      continue;
    }
    unread.push(message.id);
  }
  return unread;
}
