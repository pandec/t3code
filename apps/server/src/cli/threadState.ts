import type { OrchestrationThreadShell } from "@t3tools/contracts";

export const threadCliState = (thread: OrchestrationThreadShell) => {
  if (thread.session?.status === "error") return "error";
  if (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running"
  ) {
    return "running";
  }
  return thread.latestTurn?.state ?? "idle";
};

export const threadHasActiveTurn = (thread: OrchestrationThreadShell): boolean => {
  if (thread.session?.status === "starting" || thread.session?.status === "error") {
    return false;
  }
  return (
    thread.latestTurn?.state === "running" ||
    (thread.session?.status === "running" && thread.session.activeTurnId !== null)
  );
};

export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

type QueuedTurnStartShell = Pick<
  OrchestrationThreadShell,
  "latestUserMessageAt" | "latestTurn" | "session"
>;

const hasUnadoptedTurnStart = (thread: QueuedTurnStartShell): boolean => {
  if (thread.latestUserMessageAt === null || thread.session?.status === "error") return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  const turn = thread.latestTurn;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate === null || Date.parse(candidate) < messageAt,
  );
};

export const hasQueuedTurnStart = (
  thread: QueuedTurnStartShell,
  options: { readonly now: string },
): boolean => {
  if (!hasUnadoptedTurnStart(thread) || thread.latestUserMessageAt === null) return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  const now = Date.parse(options.now);
  if (Number.isNaN(now)) return false;
  return Math.abs(now - messageAt) <= QUEUED_TURN_START_GRACE_MS;
};

export interface ThreadQuiescence {
  readonly quiescent: boolean;
  readonly adoptionTimedOut: boolean;
}

export const threadIsQuiescent = (
  thread: OrchestrationThreadShell,
  options: { readonly now: string },
): ThreadQuiescence => {
  if (thread.session?.status === "starting" || thread.session?.status === "running") {
    return { quiescent: false, adoptionTimedOut: false };
  }
  if (thread.latestTurn?.state === "running") {
    return { quiescent: false, adoptionTimedOut: false };
  }
  if (hasQueuedTurnStart(thread, options)) {
    return { quiescent: false, adoptionTimedOut: false };
  }
  return {
    quiescent: true,
    adoptionTimedOut: hasUnadoptedTurnStart(thread),
  };
};
