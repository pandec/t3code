import type {
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  OrchestrationSessionStatus,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

// Projection normally lands immediately. Five minutes is a conservative escape
// hatch for a lost shell event; a genuinely backlogged projection beyond this
// window can still trade ordering correctness for queue availability.
export const THREAD_OUTBOX_PROJECTION_HOLD_TIMEOUT_MS = 5 * 60_000;

export interface ThreadOutboxProjectionHold {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly previousTurnId: TurnId | null;
  readonly sessionBaselineKnown: boolean;
  readonly previousSessionStatus: OrchestrationSessionStatus | null;
  readonly previousSessionUpdatedAt: string | null;
  readonly threadWasArchived: boolean;
  readonly expiresAt: number;
}

export function threadOutboxProjectionWakeDelayMs(
  holds: ReadonlyArray<ThreadOutboxProjectionHold>,
  nowMs = Date.now(),
): number | null {
  const nextExpiry = holds.reduce<number | null>(
    (soonest, hold) =>
      hold.expiresAt <= nowMs
        ? soonest
        : soonest === null
          ? hold.expiresAt
          : Math.min(soonest, hold.expiresAt),
    null,
  );
  return nextExpiry === null ? null : nextExpiry - nowMs;
}

export function threadOutboxProjectionCaughtUp(
  hold: ThreadOutboxProjectionHold,
  thread: EnvironmentThreadShell | undefined,
  shellStatus: EnvironmentShellStatus,
  nowMs = Date.now(),
): boolean {
  if (shellStatus !== "live") return false;
  if (nowMs >= hold.expiresAt) return true;
  if (thread === undefined) return false;
  if (hold.threadWasArchived && thread.archivedAt != null) return false;

  const sessionStatus = thread.session?.status ?? null;
  if (
    sessionStatus === "starting" ||
    sessionStatus === "running" ||
    (thread.latestTurn?.turnId ?? null) !== hold.previousTurnId
  ) {
    return true;
  }
  if (
    hold.sessionBaselineKnown &&
    (sessionStatus === "interrupted" || sessionStatus === "stopped" || sessionStatus === "error")
  ) {
    return (
      sessionStatus !== hold.previousSessionStatus ||
      (thread.session?.updatedAt ?? null) !== hold.previousSessionUpdatedAt
    );
  }
  return false;
}
