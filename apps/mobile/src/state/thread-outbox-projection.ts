import type {
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";

// Projection normally lands immediately. The bounded fallback prevents a lost
// shell event from permanently parking lifecycle and same-thread message queues.
export const THREAD_OUTBOX_PROJECTION_HOLD_TIMEOUT_MS = 60_000;

export interface ThreadOutboxProjectionHold {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly previousTurnId: TurnId | null;
  readonly threadWasArchived: boolean;
  readonly expiresAt: number;
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
  return (
    sessionStatus === "starting" ||
    sessionStatus === "running" ||
    sessionStatus === "interrupted" ||
    sessionStatus === "stopped" ||
    sessionStatus === "error" ||
    (thread.latestTurn?.turnId ?? null) !== hold.previousTurnId
  );
}
