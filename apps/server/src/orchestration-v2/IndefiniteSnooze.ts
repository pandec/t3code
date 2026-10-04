import type { OrchestrationV2AppThread, OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Fork: the indefinite snooze ("until I wake it") carries no wake time, so
 * `snoozedAt` alone marks it. It ends when the user wakes, pins, settles, or
 * messages the thread; clients also treat it as awake once the thread needs
 * attention (see client-runtime's effectiveSnoozed).
 */
export function isIndefinitelySnoozed(
  thread: Pick<OrchestrationV2AppThread, "snoozedUntil" | "snoozedAt">,
): boolean {
  return thread.snoozedUntil == null && thread.snoozedAt != null;
}

/**
 * Whether a run ended after the indefinite snooze was set: the derived wake
 * clients show for it. Unlike timed snoozes, an interrupted or failed run
 * counts as well as a completed one, since the agent stopped either way.
 */
export function indefiniteSnoozeWokeByRun(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "completedAt">>,
  snoozedAt: DateTime.Utc,
): boolean {
  const snoozedAtMs = DateTime.toEpochMillis(snoozedAt);
  return runs.some(
    (run) =>
      (run.status === "completed" || run.status === "interrupted" || run.status === "failed") &&
      run.completedAt !== null &&
      DateTime.toEpochMillis(run.completedAt) > snoozedAtMs,
  );
}
