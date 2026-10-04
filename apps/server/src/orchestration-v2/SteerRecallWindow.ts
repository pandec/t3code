import {
  MAX_STEER_GRACE_WINDOW_MS,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Fork steer recall window. A user steer is held as a queued run carrying
 * `steerDeadlineAt` so it can still be edited, removed or sent early through
 * the ordinary queued-run commands. When the deadline passes the orchestrator
 * steers it into the running turn.
 */

/** When a steer submitted now may leave its recall window, or undefined to steer at once. */
export function steerRecallDeadline(
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
  now: DateTime.Utc,
  isMaintenanceCommand: boolean,
): DateTime.Utc | undefined {
  const windowMs = Math.min(command.steerGraceWindowMs ?? 0, MAX_STEER_GRACE_WINDOW_MS);
  if (
    windowMs <= 0 ||
    isMaintenanceCommand ||
    command.createdBy !== "user" ||
    command.notification !== undefined ||
    command.delegatedCompletion !== undefined ||
    command.scheduledTaskId !== undefined ||
    command.senderThreadId !== undefined ||
    command.sourcePlanRef !== undefined ||
    command.restartContinuationOfRunId !== undefined
  ) {
    return undefined;
  }
  return DateTime.add(now, { milliseconds: windowMs });
}

/** A queued steer still inside its recall window; it neither starts nor joins a batch. */
export function isSteerInRecallWindow(run: OrchestrationV2Run, now: DateTime.Utc): boolean {
  return (
    run.status === "queued" &&
    run.steerDeadlineAt !== undefined &&
    DateTime.isGreaterThan(run.steerDeadlineAt, now)
  );
}

/** A queued steer whose recall window has passed and that is waiting for a turn to take it. */
export function isSteerDue(run: OrchestrationV2Run, now: DateTime.Utc): boolean {
  return (
    run.status === "queued" &&
    run.steerDeadlineAt !== undefined &&
    !DateTime.isGreaterThan(run.steerDeadlineAt, now)
  );
}

/** The run as an ordinary queued message, without its steer deadline. */
export function withoutSteerDeadline(run: OrchestrationV2Run): OrchestrationV2Run {
  const { steerDeadlineAt: _steerDeadlineAt, ...ordinary } = run;
  return ordinary;
}
