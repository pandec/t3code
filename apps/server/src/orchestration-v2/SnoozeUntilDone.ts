import type {
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import {
  derivePendingBackgroundWork,
  snoozeUntilDoneWorkContinues,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { latestUnheldRun } from "@t3tools/shared/orchestrationV2ThreadError";

type SnoozeFields = Pick<
  OrchestrationV2AppThread,
  "snoozedUntil" | "snoozedAt" | "snoozedUntilRunId"
>;

type UntilDoneProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "providerThreads" | "turnItems" | "runtimeRequests"
>;

/**
 * Fork: the "until it's done" snooze: no wake time, and the run whose work
 * it waits on. It wakes when that work ends (see snoozeUntilDoneWorkContinues).
 */
export function isSnoozedUntilDone(thread: SnoozeFields): boolean {
  return (
    thread.snoozedUntil == null && thread.snoozedAt != null && thread.snoozedUntilRunId != null
  );
}

/** Spread that drops a stale awaited run without adding the key to rows that never had one. */
export function clearedSnoozeUntilDone(
  thread: Pick<OrchestrationV2AppThread, "snoozedUntilRunId">,
): Pick<OrchestrationV2AppThread, "snoozedUntilRunId"> {
  return thread.snoozedUntilRunId == null ? {} : { snoozedUntilRunId: null };
}

/**
 * The run an "until it's done" snooze would wait on now: the latest run,
 * while it is live or its agent background work runs on. Null when nothing
 * is working, so there is nothing to wait for.
 */
export function snoozeUntilDoneAwaitedRunId(projection: UntilDoneProjection): RunId | null {
  const latestRun = latestUnheldRun(projection.runs);
  if (latestRun === null) return null;
  const continues = snoozeUntilDoneWorkContinues({
    snoozedUntilRunId: latestRun.id,
    latestRunId: latestRun.id,
    latestRunStatus: latestRun.status,
    pendingBackgroundTasks: derivePendingBackgroundWork({
      latestRun,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      runs: projection.runs,
    }),
  });
  return continues ? latestRun.id : null;
}

/**
 * Whether the thread's "until it's done" snooze still holds: its work goes
 * on and nothing waits on the user. Clients additionally wake it on a fresh
 * failure, which also ends the work here.
 */
export function snoozeUntilDoneHolds(projection: UntilDoneProjection): boolean {
  return (
    isSnoozedUntilDone(projection.thread) &&
    !projection.runtimeRequests.some((request) => request.status === "pending") &&
    snoozeUntilDoneAwaitedRunId(projection) === projection.thread.snoozedUntilRunId
  );
}

/**
 * A delegated-completion wake reporting to the awaited run carries its work
 * on, even after the last child's turn item went terminal and the reserved
 * delivery is all that remains of it.
 */
export function delegatedCompletionContinuesUntilDone(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "runtimeRequests">,
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
): boolean {
  const parentRunId = command.delegatedCompletion?.parentRunId;
  if (parentRunId === undefined || !isSnoozedUntilDone(projection.thread)) return false;
  if (projection.thread.snoozedUntilRunId !== parentRunId) return false;
  if (projection.runtimeRequests.some((request) => request.status === "pending")) return false;
  const latestRun = latestUnheldRun(projection.runs);
  return latestRun?.id === parentRunId && latestRun.status !== "failed";
}

/**
 * A wake: an automatic message that carries on existing work (background
 * notification, delegated task result, restart continuation) rather than
 * starting new work. Mirrors the Orchestrator's wakeWorkStartedAt triggers.
 */
export function isWakeMessageDispatch(
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
): boolean {
  return (
    command.createdBy !== "user" &&
    (command.notification !== undefined ||
      command.delegatedCompletion !== undefined ||
      command.restartContinuationOfRunId !== undefined)
  );
}

/**
 * After a wake kept an "until it's done" snooze, the run it should wait on
 * next: the wake's run when it started a new one. Null when nothing moves
 * (a steer into the awaited run, or a no-op delivery).
 */
export function snoozeUntilDoneWakeRunId(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
): RunId | null {
  if (!isSnoozedUntilDone(projection.thread)) return null;
  const latestRun = latestUnheldRun(projection.runs);
  return latestRun === null || latestRun.id === projection.thread.snoozedUntilRunId
    ? null
    : latestRun.id;
}
