import type { OrchestrationV2AppThread, OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Fork: the indefinite snooze ("until I wake it") carries no wake time, so
 * `snoozedAt` alone marks it. It ends when the user wakes, pins, settles, or
 * messages the thread; clients also treat it as awake once the thread needs
 * attention (see client-runtime's effectiveSnoozed).
 */
export function isIndefinitelySnoozed(
  thread: Pick<OrchestrationV2AppThread, "snoozedUntil" | "snoozedAt" | "snoozedUntilRunId">,
): boolean {
  // An awaited run makes it the "until it's done" snooze instead.
  return (
    thread.snoozedUntil == null && thread.snoozedAt != null && thread.snoozedUntilRunId == null
  );
}

/**
 * Whether an indefinite snooze holds over the latest run: none ended after it
 * was set. Usage-limit auto-resume defers on it, as on a pending wake time.
 */
export function indefiniteSnoozeHoldsOverLatestRun(
  thread: Pick<OrchestrationV2AppThread, "snoozedUntil" | "snoozedAt" | "snoozedUntilRunId"> & {
    readonly latestRunCompletedAt?: DateTime.Utc | null | undefined;
  },
): boolean {
  return (
    isIndefinitelySnoozed(thread) &&
    thread.snoozedAt != null &&
    (thread.latestRunCompletedAt == null ||
      DateTime.toEpochMillis(thread.latestRunCompletedAt) <=
        DateTime.toEpochMillis(thread.snoozedAt))
  );
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

/**
 * Whether an indefinite snooze has woken by the rules clients derive: a run
 * ended after it, or the latest run failed and the thread changed since.
 * Mirrors client-runtime's threadRaisedHandWhileSnoozed, which reads a failed
 * runtime stamped with `thread.updatedAt` newer than `snoozedAt` as a fresh
 * failure.
 */
export function indefiniteSnoozeWoke(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "completedAt">>,
  thread: Pick<OrchestrationV2AppThread, "updatedAt"> & { readonly snoozedAt: DateTime.Utc },
): boolean {
  return (
    indefiniteSnoozeWokeByRun(runs, thread.snoozedAt) ||
    (runs.at(-1)?.status === "failed" &&
      DateTime.toEpochMillis(thread.updatedAt) > DateTime.toEpochMillis(thread.snoozedAt))
  );
}
