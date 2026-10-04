/**
 * Fork: deferred archive decisions. A request waits on the run that was active
 * when it was scheduled (a v2 run only reaches `completed` after its final
 * checkpoint lands) and on background work that holds completion, then
 * archives through the ordinary `thread.archive` path. New work, a failed or
 * stopped run, or a workspace change cancels it. Pure: the orchestrator and
 * `ThreadArchiveScheduler` share these rules.
 */
import type {
  CommandId,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Run,
  OrchestrationV2ThreadArchiveRequest,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

type ArchiveRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "requestedAt">;

/** Statuses of a run that is still working toward completion (waiting = capturing its checkpoint). */
const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);
/** Statuses Stop can interrupt; a waiting run's provider turn already finished. */
const RUNNING_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
]);
const STOPPED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export const ARCHIVE_CANCEL_DETAIL = {
  user: "Cancelled by user.",
  newWork: "The thread started new work.",
  stopped: "The turn was stopped.",
  failed: "The turn failed or was interrupted.",
  workspace: "The thread changed workspace.",
  manual: "The thread was archived manually.",
} as const;

export function pendingArchiveRequest(
  thread: Pick<OrchestrationV2AppThread, "archiveRequest" | "archivedAt" | "deletedAt">,
): OrchestrationV2ThreadArchiveRequest | null {
  const request = thread.archiveRequest;
  return request?.status === "pending" && thread.archivedAt === null && thread.deletedAt === null
    ? request
    : null;
}

export function cancelledArchiveRequest(
  request: OrchestrationV2ThreadArchiveRequest,
  detail: string,
): OrchestrationV2ThreadArchiveRequest {
  return { ...request, status: "cancelled", detail };
}

export function completedArchiveRequest(
  request: OrchestrationV2ThreadArchiveRequest,
): OrchestrationV2ThreadArchiveRequest {
  const { detail: _detail, ...rest } = request;
  return { ...rest, status: "completed" };
}

function activeRun(runs: ReadonlyArray<ArchiveRun>): ArchiveRun | null {
  return (
    runs
      .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null
  );
}

export type ArchiveSchedulePlan =
  | { readonly type: "reject"; readonly detail: string }
  | { readonly type: "archive"; readonly request: OrchestrationV2ThreadArchiveRequest }
  | { readonly type: "pending"; readonly request: OrchestrationV2ThreadArchiveRequest };

/** Decide a `thread.archive.schedule`: reject, archive now, or record a pending request. */
export function planArchiveSchedule(input: {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    "archiveRequest" | "archivedAt" | "deletedAt" | "worktreePath"
  >;
  readonly runs: ReadonlyArray<ArchiveRun>;
  readonly pendingBackgroundTasks: ReadonlyArray<
    Pick<OrchestrationV2PendingBackgroundTask, "kind">
  >;
  readonly afterTurn: boolean;
  readonly requestId: CommandId;
  readonly now: DateTime.Utc;
}): ArchiveSchedulePlan {
  if (input.thread.archivedAt !== null)
    return { type: "reject", detail: "Thread is already archived." };
  if (pendingArchiveRequest(input.thread) !== null) {
    return {
      type: "reject",
      detail: "An archive is already pending. Cancel it before replacing it.",
    };
  }
  if (input.runs.some((run) => run.status === "queued")) {
    return {
      type: "reject",
      detail: "Queued messages are waiting to run. Archive after they finish or remove them.",
    };
  }
  const run = activeRun(input.runs);
  if (run !== null && !input.afterTurn) {
    return { type: "reject", detail: "The thread is running. Archive it after the turn instead." };
  }
  const request: OrchestrationV2ThreadArchiveRequest = {
    requestId: input.requestId,
    runId: run?.id ?? null,
    worktreePath: input.thread.worktreePath,
    requestedAt: DateTime.formatIso(input.now),
    status: "pending",
  };
  return run === null && !backgroundWorkHoldsCompletion(input.pendingBackgroundTasks)
    ? { type: "archive", request: completedArchiveRequest(request) }
    : { type: "pending", request };
}

export type DeferredArchiveDecision =
  | { readonly type: "wait"; readonly detail: string }
  | { readonly type: "archive" }
  | { readonly type: "cancel"; readonly detail: string };

/** Whether a pending request can archive now, must keep waiting, or is void. */
export function evaluateDeferredArchive(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "worktreePath">;
  readonly request: OrchestrationV2ThreadArchiveRequest;
  readonly runs: ReadonlyArray<ArchiveRun>;
  readonly pendingBackgroundTasks: ReadonlyArray<
    Pick<OrchestrationV2PendingBackgroundTask, "kind">
  >;
}): DeferredArchiveDecision {
  const { request } = input;
  if (input.thread.worktreePath !== request.worktreePath) {
    return { type: "cancel", detail: ARCHIVE_CANCEL_DETAIL.workspace };
  }
  if (request.runId !== null) {
    const target = input.runs.find((run) => run.id === request.runId);
    if (target === undefined || input.runs.some((run) => run.ordinal > target.ordinal)) {
      return { type: "cancel", detail: ARCHIVE_CANCEL_DETAIL.newWork };
    }
    if (STOPPED_RUN_STATUSES.has(target.status)) {
      return { type: "cancel", detail: ARCHIVE_CANCEL_DETAIL.failed };
    }
    if (target.status !== "completed") {
      return { type: "wait", detail: "The turn has not finished." };
    }
  } else {
    const requestedAtMs = Date.parse(request.requestedAt);
    if (input.runs.some((run) => DateTime.toEpochMillis(run.requestedAt) > requestedAtMs)) {
      return { type: "cancel", detail: ARCHIVE_CANCEL_DETAIL.newWork };
    }
  }
  if (backgroundWorkHoldsCompletion(input.pendingBackgroundTasks)) {
    return { type: "wait", detail: "Background work is still running." };
  }
  return { type: "archive" };
}

/** Stop cancels a pending archive only while the run it waits on is still running. */
export function stopCancelsArchive(
  request: OrchestrationV2ThreadArchiveRequest,
  runs: ReadonlyArray<ArchiveRun>,
  stoppedRunId: RunId,
): boolean {
  if (request.runId === null || request.runId !== stoppedRunId) return false;
  const run = runs.find((candidate) => candidate.id === stoppedRunId);
  return run !== undefined && RUNNING_RUN_STATUSES.has(run.status);
}

type ThreadPayloadEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>;

export function isThreadPayloadEvent(
  event: OrchestrationV2DomainEvent,
): event is ThreadPayloadEvent {
  return event.type.startsWith("thread.");
}

/** The thread as of the last thread event already decided in this command, else `fallback`. */
export function latestThreadState(
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  threadId: ThreadId,
  fallback: OrchestrationV2AppThread,
): OrchestrationV2AppThread {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.threadId === threadId && isThreadPayloadEvent(event)) return event.payload;
  }
  return fallback;
}
