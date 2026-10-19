import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function latestRootProviderFailure(
  run: OrchestrationV2Run | null,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ProviderFailure | null {
  if (run?.status !== "failed") return null;
  let latest: Extract<OrchestrationV2TurnItem, { type: "error" }> | null = null;
  for (const item of turnItems) {
    if (
      item.type !== "error" ||
      item.status !== "failed" ||
      item.runId !== run.id ||
      item.nodeId !== run.rootNodeId
    )
      continue;
    if (
      latest === null ||
      DateTime.toEpochMillis(item.updatedAt) > DateTime.toEpochMillis(latest.updatedAt) ||
      (DateTime.toEpochMillis(item.updatedAt) === DateTime.toEpochMillis(latest.updatedAt) &&
        (item.ordinal > latest.ordinal || (item.ordinal === latest.ordinal && item.id > latest.id)))
    ) {
      latest = item;
    }
  }
  return latest?.failure ?? null;
}

export function threadErrorSummary(
  failure: OrchestrationV2ProviderFailure | null,
  sessionError: string | null,
) {
  const currentFailure =
    sessionError !== null && sessionError !== failure?.message ? null : failure;
  return {
    usageLimitResetAt:
      currentFailure?.class === "usage_limit" ? (currentFailure.resetAt ?? null) : null,
    lastError: sessionError ?? failure?.message ?? null,
    lastErrorClass:
      sessionError !== null && sessionError !== failure?.message ? null : (failure?.class ?? null),
  };
}

export function latestExecutedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued") continue;
    if (run.status === "cancelled" && run.startedAt === null) continue;
    if (latest === null || runRanAfter(run, latest)) latest = run;
  }
  return latest;
}

/**
 * Ordinals follow submission, but a run can start ahead of a held queue (a
 * restart continuation, or a message sent while the queue is held), so a queued
 * run resumed later can have a lower ordinal than one that already ended. An
 * unfinished run is the latest.
 */
export function runRanAfter(
  run: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
  other: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
): boolean {
  const end = (candidate: typeof run) =>
    !candidate.completedAt
      ? Number.POSITIVE_INFINITY
      : DateTime.toEpochMillis(candidate.completedAt);
  return end(run) === end(other) ? run.ordinal > other.ordinal : end(run) > end(other);
}

export function usageLimitBlockedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const executed = latestExecutedRun(runs);
  if (executed?.status !== "failed") return null;
  const summary = threadErrorSummary(latestRootProviderFailure(executed, turnItems), sessionError);
  return summary.lastErrorClass === "usage_limit" ? executed : null;
}

/**
 * That limited run, when queued runs would otherwise stand for the thread
 * outcome (latestUnheldRun) and hide the limit.
 */
export function usageLimitRunPresentedAsLatest(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const blocked = usageLimitBlockedRun(runs, turnItems, sessionError);
  if (blocked === null) return null;
  const presented = latestUnheldRun(runs);
  return presented !== null && presented !== blocked ? blocked : null;
}

/**
 * The newest run that is not waiting on the user, or null when only such runs
 * exist. A held queue and a queued message open for editing wait for the user,
 * so they never stand for the thread's outcome. Fork: an unheld queued message
 * outranks other runs, since it still runs after them even when a reorder
 * left it with an older ordinal, and a message cancelled before it started
 * (removed from the queue or batched into another turn) only stands for the
 * outcome when no other run does. The SQL thread shell selects the same run.
 */
export function latestUnheldRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  const rank = (run: OrchestrationV2Run) =>
    run.status === "queued" ? 2 : run.status === "cancelled" && run.startedAt === null ? 0 : 1;
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued" && (run.queueHeld === true || run.editHeldUntil !== undefined)) {
      continue;
    }
    if (
      latest === null ||
      rank(run) > rank(latest) ||
      (rank(run) === rank(latest) && run.ordinal > latest.ordinal)
    ) {
      latest = run;
    }
  }
  return latest;
}
