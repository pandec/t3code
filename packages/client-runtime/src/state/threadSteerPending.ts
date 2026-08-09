import type {
  MessageId,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { isAgentAttributedToolActivity, isTimelineBypassActivity } from "./subagentRuntime.ts";
import type { ThreadOutboxDeliveryIntent } from "./threadOutboxModel.ts";

/**
 * Steering is not the same as being heard. Claude Code holds a mid-turn prompt
 * in its own queue and only reads it between a tool result and the next model
 * request, so a steer sent behind a long `Agent` or `Bash` call can sit unread
 * for minutes while the timeline keeps scrolling. This module tracks the gap
 * between "dispatched" and "read" so the message bubble can say which one it is.
 *
 * The state is deliberately in-memory and client-local: it describes what this
 * client is waiting for, not a fact about the thread. It does not survive a
 * reload and a second device does not see it.
 */

/** One steer that reached the server while its thread's turn was already running. */
export interface PendingSteerDispatch {
  readonly messageId: MessageId;
  /**
   * Client clock at dispatch. Only ever compared with other client-clock
   * readings (the reveal delay below) — never with a server timestamp.
   */
  readonly dispatchedAt: string;
  /**
   * Newest main-agent progress timestamp this client had for the thread when
   * the steer went out, or null when it had none. Resolution compares server
   * timestamps against this watermark instead of against the client clock, so a
   * remote client whose wall clock differs from the environment's still clears
   * the marker at the right moment.
   */
  readonly progressWatermarkAt: string | null;
  /** The turn the steer joined. A different turn means its queue point passed. */
  readonly turnId: TurnId | null;
}

/** The thread state a pending steer is resolved against. */
export interface SteerPendingThreadSnapshot {
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state"> | null;
  readonly messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "createdAt">>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

/**
 * How long a steer must stay unread before the marker appears. Adapters that
 * hand a mid-turn prompt straight to the provider resolve it within a round
 * trip — Codex opens a fresh turn for it, and a Claude steer that happens to
 * land on a drain point is read immediately — so without this delay the common
 * case would be a flicker. Waiting also keeps the marker meaning what it says:
 * it appears only once the message really is sitting in a queue.
 */
export const STEER_PENDING_REVEAL_DELAY_MS = 1_500;

/** Most recent steers kept per thread; a queue deeper than this is not a UI problem. */
const MAX_PENDING_STEERS_PER_THREAD = 8;

/**
 * The one activity kind that proves the main agent issued a new model request,
 * and therefore drained its prompt queue on the way there.
 *
 * Everything else a blocked parent emits keeps arriving while the queue is
 * still unread: a subagent's `task.*` rows carry no `agentId` (that field marks
 * a task launched from *inside* an agent, not one that launched it),
 * `tool.progress` heartbeats tick for the running tool, and
 * `context-window.updated` fires on every token total the subagent moves.
 * Treating any of those as "read" would clear the marker within a second of
 * every steer and make it useless.
 *
 * Known imprecision: when the parent issues several tool calls in one request,
 * a short one finishing does not drain the queue, yet the tool it starts is
 * indistinguishable from a post-drain call. That clears the marker early, which
 * degrades to today's behaviour rather than to a lie.
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
 * The newest main-agent progress timestamp in a thread, used as the watermark a
 * later steer is measured against. Assistant messages count alongside tool
 * starts: a turn that answers in prose never starts another tool.
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

function hasParentAgentProgressSince(
  snapshot: Pick<SteerPendingThreadSnapshot, "messages" | "activities">,
  watermarkAt: string | null,
): boolean {
  const watermarkMs = parsedTimestamp(watermarkAt);
  for (const message of snapshot.messages) {
    if (message.role === "assistant" && parsedTimestamp(message.createdAt) > watermarkMs) {
      return true;
    }
  }
  for (const activity of snapshot.activities) {
    if (
      parsedTimestamp(activity.createdAt) > watermarkMs &&
      isParentAgentProgressActivity(activity)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a delivery is worth tracking. Only a steer that landed on a turn that
 * was already running can queue behind a tool call; anything delivered to an
 * idle thread starts its own turn and is read straight away.
 */
export function shouldTrackSteerDispatch(input: {
  readonly deliveryIntent: ThreadOutboxDeliveryIntent;
  readonly sessionStatus: OrchestrationSessionStatus | null;
}): boolean {
  return input.deliveryIntent === "steer" && input.sessionStatus === "running";
}

/**
 * Whether the agent still has not reached the drain point for this steer. Every
 * way the turn can end is a way out: completion, interruption, an error, a lost
 * session, and a provider that answered the steer by opening its own turn.
 */
export function isSteerStillUnread(
  pending: PendingSteerDispatch,
  snapshot: SteerPendingThreadSnapshot,
): boolean {
  if (snapshot.sessionStatus !== "running") {
    return false;
  }
  const latestTurn = snapshot.latestTurn;
  if (latestTurn === null || latestTurn.state !== "running") {
    return false;
  }
  if (latestTurn.turnId !== pending.turnId) {
    return false;
  }
  return !hasParentAgentProgressSince(snapshot, pending.progressWatermarkAt);
}

/**
 * Drops the steers the agent has since read. Returns the input array unchanged
 * when nothing resolved, so callers can use identity to skip a write.
 */
export function unreadSteerDispatches(
  pending: ReadonlyArray<PendingSteerDispatch>,
  snapshot: SteerPendingThreadSnapshot,
): ReadonlyArray<PendingSteerDispatch> {
  if (pending.length === 0) {
    return pending;
  }
  const unread = pending.filter((entry) => isSteerStillUnread(entry, snapshot));
  return unread.length === pending.length ? pending : unread;
}

/** The pending steers old enough to show a marker for. */
export function revealedSteerPendingMessageIds(
  pending: ReadonlyArray<PendingSteerDispatch>,
  nowMs: number,
): ReadonlySet<MessageId> {
  const revealed = new Set<MessageId>();
  for (const entry of pending) {
    if (parsedTimestamp(entry.dispatchedAt) + STEER_PENDING_REVEAL_DELAY_MS <= nowMs) {
      revealed.add(entry.messageId);
    }
  }
  return revealed;
}

/**
 * Milliseconds until the next still-hidden steer would be revealed, or null
 * when none is waiting. Nothing else re-renders at that moment.
 */
export function nextSteerPendingRevealDelayMs(
  pending: ReadonlyArray<PendingSteerDispatch>,
  nowMs: number,
): number | null {
  let soonest: number | null = null;
  for (const entry of pending) {
    const remainingMs = parsedTimestamp(entry.dispatchedAt) + STEER_PENDING_REVEAL_DELAY_MS - nowMs;
    if (remainingMs > 0 && (soonest === null || remainingMs < soonest)) {
      soonest = remainingMs;
    }
  }
  return soonest;
}

export interface ThreadSteerPendingStoreOptions {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly atomLabel?: string;
}

export type ThreadSteerPendingStore = ReturnType<typeof createThreadSteerPendingStore>;

/**
 * The ephemeral per-thread record of dispatched-but-unread steers. Web and
 * mobile each instantiate one against their own atom registry; the behaviour
 * they share lives in the pure helpers above.
 */
export function createThreadSteerPendingStore(options: ThreadSteerPendingStoreOptions) {
  const pendingByThreadKeyAtom = Atom.make<Record<string, ReadonlyArray<PendingSteerDispatch>>>(
    {},
  ).pipe(Atom.keepAlive, Atom.withLabel(options.atomLabel ?? "thread-steer-pending"));
  let retainedThreadKey: string | null = null;

  const read = (): Record<string, ReadonlyArray<PendingSteerDispatch>> =>
    options.registry.get(pendingByThreadKeyAtom);

  const track = (threadKey: string, dispatch: PendingSteerDispatch): void => {
    // The outbox drains every thread. A delivery that finishes after navigation
    // must not recreate state for a thread whose marker can no longer be shown.
    if (threadKey !== retainedThreadKey) {
      return;
    }
    const current = read();
    const existing = current[threadKey] ?? [];
    const next = [
      ...existing.filter((entry) => entry.messageId !== dispatch.messageId),
      dispatch,
    ].slice(-MAX_PENDING_STEERS_PER_THREAD);
    options.registry.set(pendingByThreadKeyAtom, { ...current, [threadKey]: next });
  };

  const setThread = (threadKey: string, pending: ReadonlyArray<PendingSteerDispatch>): void => {
    const current = read();
    if (current[threadKey] === pending) {
      return;
    }
    if (pending.length === 0) {
      if (current[threadKey] === undefined) {
        return;
      }
      const { [threadKey]: _dropped, ...rest } = current;
      options.registry.set(pendingByThreadKeyAtom, rest);
      return;
    }
    options.registry.set(pendingByThreadKeyAtom, { ...current, [threadKey]: pending });
  };

  /**
   * Forgets every thread but the one on screen. A marker only means anything
   * while its thread is open, and this keeps a steer dispatched into a thread
   * the user has since left from lingering in memory.
   */
  const retainOnly = (threadKey: string | null): void => {
    retainedThreadKey = threadKey;
    const current = read();
    const keys = Object.keys(current);
    if (keys.length === 0 || (keys.length === 1 && keys[0] === threadKey)) {
      return;
    }
    const retained = threadKey === null ? undefined : current[threadKey];
    options.registry.set(
      pendingByThreadKeyAtom,
      retained === undefined ? {} : { [threadKey as string]: retained },
    );
  };

  /** Stops accepting late deliveries for a thread after its view unmounts. */
  const release = (threadKey: string | null): void => {
    if (retainedThreadKey !== threadKey) {
      return;
    }
    retainOnly(null);
  };

  return { pendingByThreadKeyAtom, track, setThread, retainOnly, release };
}
