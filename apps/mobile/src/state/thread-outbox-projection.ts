import type {
  EnvironmentShellStatus,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";

export interface ThreadOutboxProjectionHold {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly previousTurnId: TurnId | null;
}

export function threadOutboxProjectionCaughtUp(
  hold: ThreadOutboxProjectionHold,
  thread: EnvironmentThreadShell | undefined,
  shellStatus: EnvironmentShellStatus,
): boolean {
  if (shellStatus !== "live") return false;
  if (thread === undefined) return true;
  const sessionStatus = thread.session?.status ?? null;
  return (
    sessionStatus === "starting" ||
    sessionStatus === "running" ||
    (thread.latestTurn?.turnId ?? null) !== hold.previousTurnId
  );
}
