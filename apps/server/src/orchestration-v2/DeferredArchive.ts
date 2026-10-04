/**
 * Fork: deferred archive decisions. A request waits on the run that was active
 * when it was scheduled (a v2 run reaches `completed` after its final
 * checkpoint capture, even a failed one) and on background work that holds
 * completion, then archives through the ordinary `thread.archive` path. A wake
 * (delegated task result, background notification, restart continuation)
 * carries on that work, so the request moves to the run the wake starts. New
 * work, a stop or failure anywhere in the awaited chain, or a workspace change
 * cancels it; a failed final checkpoint of any awaited run records an error
 * and leaves the thread unarchived. A delegated result reserved for a wake
 * that has not dispatched yet, or whose wake finished but has not been
 * reconciled yet, holds the archive like background work, and so does a
 * restart continuation still waiting to resume the agent. A request with
 * `removeWorktree` stays pending after the archive until the scheduler's
 * guarded removal records its outcome. Pure apart from the outbox read in
 * `restartContinuationPending`: the orchestrator and `ThreadArchiveScheduler`
 * share these rules.
 */
import type {
  CommandId,
  MessageId,
  OrchestrationV2AppThread,
  OrchestrationV2Checkpoint,
  OrchestrationV2DomainEvent,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Run,
  OrchestrationV2ThreadArchiveRequest,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { EffectOutboxV2Shape } from "./EffectOutbox.ts";

export type ArchiveRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "status" | "requestedAt" | "checkpointId"
> &
  Partial<
    Pick<
      OrchestrationV2Run,
      | "startedAt"
      | "completedAt"
      | "userMessageId"
      | "delegatedCompletion"
      | "restartContinuationOfRunId"
    >
  >;
export type ArchiveCheckpoint = Pick<OrchestrationV2Checkpoint, "id" | "status">;

/** Whether `run`'s final checkpoint capture failed; `missing` (no Git) still counts as captured. */
export function finalCheckpointFailed(
  run: ArchiveRun,
  checkpoints: ReadonlyArray<ArchiveCheckpoint>,
): boolean {
  return (
    run.checkpointId !== null &&
    checkpoints.some(
      (checkpoint) => checkpoint.id === run.checkpointId && checkpoint.status === "error",
    )
  );
}

/**
 * A delegated result is reserved for a wake whose run does not exist yet (the
 * continuation worker will dispatch it), or whose run already finished before
 * the terminal-run listener rewrote the delivery (it may reserve a follow-up
 * for results that arrived meanwhile). Archiving now would drop it.
 */
function undeliveredCompletionPending(runs: ReadonlyArray<ArchiveRun>): boolean {
  return runs.some((run) => {
    const cohort = run.delegatedCompletion;
    const delivery = cohort?.delivery;
    return (
      cohort?.disposition === "open" &&
      delivery != null &&
      delivery.taskIds.length > 0 &&
      !runs.some(
        (candidate) =>
          candidate.userMessageId === delivery.messageId &&
          (candidate.status === "queued" || ACTIVE_RUN_STATUSES.has(candidate.status)),
      )
    );
  });
}

/**
 * Whether restart recovery's continuation of the latest run (the outbox id
 * `ProviderRuntimeRecoveryService` enqueues) has not settled yet.
 */
export function restartContinuationPending(
  outbox: Pick<EffectOutboxV2Shape, "get">,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal">>,
) {
  const latest = runs.reduce<Pick<OrchestrationV2Run, "id" | "ordinal"> | null>(
    (current, run) => (current === null || run.ordinal > current.ordinal ? run : current),
    null,
  );
  if (latest === null) return Effect.succeed(false);
  return outbox
    .get(`effect:restart-continuation:${latest.id}`)
    .pipe(
      Effect.map(
        Option.exists((effect) => effect.status === "pending" || effect.status === "running"),
      ),
    );
}

/** Statuses of a run that is still working toward completion (waiting = capturing its checkpoint). */
export const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);
/** Statuses Stop can interrupt; a waiting run's provider turn already finished. */
export const RUNNING_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
]);
export const STOPPED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
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
  checkpointFailed: "The final checkpoint failed. The thread was left unarchived.",
  workspace: "The thread changed workspace.",
  manual: "The thread was archived manually.",
  unarchived: "The thread was unarchived before its worktree was removed.",
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

/** The request as recorded when its thread archives: still pending while a worktree removal follows. */
export function archivedArchiveRequest(
  request: OrchestrationV2ThreadArchiveRequest,
): OrchestrationV2ThreadArchiveRequest {
  return request.removeWorktree === true && request.worktreePath !== null
    ? request
    : completedArchiveRequest(request);
}

/** An archived thread's request still waiting for its worktree removal. */
export function worktreeRemovalRequest(
  thread: Pick<OrchestrationV2AppThread, "archiveRequest" | "archivedAt" | "deletedAt">,
): OrchestrationV2ThreadArchiveRequest | null {
  const request = thread.archiveRequest;
  return request?.status === "pending" &&
    request.removeWorktree === true &&
    request.worktreePath !== null &&
    thread.archivedAt !== null &&
    thread.deletedAt === null
    ? request
    : null;
}

/** Records the removal outcome: completed, or an error carrying why the worktree was kept. */
export function finishedWorktreeRemoval(
  request: OrchestrationV2ThreadArchiveRequest,
  error: string | undefined,
): OrchestrationV2ThreadArchiveRequest {
  return error === undefined
    ? completedArchiveRequest(request)
    : { ...request, status: "error", detail: error };
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
  readonly removeWorktree?: boolean;
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
  if (input.removeWorktree === true && input.thread.worktreePath === null) {
    return { type: "reject", detail: "This thread has no worktree to remove." };
  }
  const run = activeRun(input.runs);
  if (run !== null && !input.afterTurn) {
    return { type: "reject", detail: "The thread is running. Archive it after the turn instead." };
  }
  const request: OrchestrationV2ThreadArchiveRequest = {
    requestId: input.requestId,
    runId: run?.id ?? null,
    worktreePath: input.thread.worktreePath,
    ...(input.removeWorktree === true ? { removeWorktree: true } : {}),
    requestedAt: DateTime.formatIso(input.now),
    status: "pending",
  };
  return run === null &&
    !backgroundWorkHoldsCompletion(input.pendingBackgroundTasks) &&
    !undeliveredCompletionPending(input.runs)
    ? { type: "archive", request: archivedArchiveRequest(request) }
    : { type: "pending", request };
}

export type DeferredArchiveDecision =
  | { readonly type: "wait"; readonly detail: string }
  | { readonly type: "archive" }
  | { readonly type: "cancel"; readonly detail: string }
  | { readonly type: "fail"; readonly detail: string };

/** Whether a pending request can archive now, must keep waiting, is void, or failed. */
export function evaluateDeferredArchive(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "worktreePath">;
  readonly request: OrchestrationV2ThreadArchiveRequest;
  readonly runs: ReadonlyArray<ArchiveRun>;
  readonly checkpoints: ReadonlyArray<ArchiveCheckpoint>;
  readonly pendingBackgroundTasks: ReadonlyArray<
    Pick<OrchestrationV2PendingBackgroundTask, "kind">
  >;
  /**
   * `restartContinuationPending`: the continuation may yet resume the work and
   * take the request over.
   */
  readonly restartContinuationPending?: boolean;
}): DeferredArchiveDecision {
  const { request } = input;
  if (input.thread.worktreePath !== request.worktreePath) {
    return { type: "cancel", detail: ARCHIVE_CANCEL_DETAIL.workspace };
  }
  if (input.restartContinuationPending === true) {
    return { type: "wait", detail: "A restart continuation is waiting to resume the agent." };
  }
  const requestedAtMs = Date.parse(request.requestedAt);
  if (request.runId !== null) {
    const target = input.runs.find((run) => run.id === request.runId);
    if (target === undefined || input.runs.some((run) => run.ordinal > target.ordinal)) {
      return { type: "cancel", detail: ARCHIVE_CANCEL_DETAIL.newWork };
    }
    const awaited = awaitedRun(target, input.runs, request);
    if (awaited !== null) {
      // Every awaited run counts, not only the latest wake: the run the archive
      // was scheduled during, and wakes before the current one.
      const continued = new Set(input.runs.flatMap((run) => run.restartContinuationOfRunId ?? []));
      const chainStopped = input.runs.some(
        (run) =>
          run.ordinal <= target.ordinal &&
          // stopped after the archive was scheduled; the awaited run itself is checked below
          run.completedAt != null &&
          DateTime.toEpochMillis(run.completedAt) > requestedAtMs &&
          STOPPED_RUN_STATUSES.has(run.status) &&
          // restart recovery: the continuation carries this run's work on
          !continued.has(run.id) &&
          // a wake withdrawn before it started never ran
          !(
            run.status === "cancelled" &&
            run.startedAt == null &&
            DateTime.toEpochMillis(run.requestedAt) >= requestedAtMs
          ),
      );
      if (chainStopped || STOPPED_RUN_STATUSES.has(awaited.status)) {
        return { type: "cancel", detail: ARCHIVE_CANCEL_DETAIL.failed };
      }
      const chainCheckpointFailed = input.runs.some(
        (run) =>
          run.ordinal <= target.ordinal &&
          run.completedAt != null &&
          DateTime.toEpochMillis(run.completedAt) > requestedAtMs &&
          finalCheckpointFailed(run, input.checkpoints),
      );
      if (chainCheckpointFailed || finalCheckpointFailed(awaited, input.checkpoints)) {
        return { type: "fail", detail: ARCHIVE_CANCEL_DETAIL.checkpointFailed };
      }
      if (awaited.status !== "completed") {
        return { type: "wait", detail: "The turn has not finished." };
      }
    }
  } else if (input.runs.some((run) => DateTime.toEpochMillis(run.requestedAt) > requestedAtMs)) {
    return { type: "cancel", detail: ARCHIVE_CANCEL_DETAIL.newWork };
  }
  if (backgroundWorkHoldsCompletion(input.pendingBackgroundTasks)) {
    return { type: "wait", detail: "Background work is still running." };
  }
  if (undeliveredCompletionPending(input.runs)) {
    return { type: "wait", detail: "A delegated result is waiting to wake the agent." };
  }
  return { type: "archive" };
}

/**
 * The run a request effectively waits on. A wake cancelled while still queued
 * (its delegated tasks were withdrawn, or restart recovery dropped it) never
 * ran, so the request falls back to the run before it; null when that run had
 * already settled before the archive was scheduled (only background work counts).
 * Only a wake moves a pending request, so a target requested at or after the
 * archive is a wake; the run the archive was scheduled during was requested
 * before it (`>=` keeps same-millisecond wakes).
 */
function awaitedRun(
  target: ArchiveRun,
  runs: ReadonlyArray<ArchiveRun>,
  request: OrchestrationV2ThreadArchiveRequest,
): ArchiveRun | null {
  const requestedAtMs = Date.parse(request.requestedAt);
  let run = target;
  while (
    run.status === "cancelled" &&
    run.startedAt == null &&
    DateTime.toEpochMillis(run.requestedAt) >= requestedAtMs
  ) {
    const ordinal = run.ordinal;
    const previous = runs
      .filter((candidate) => candidate.ordinal < ordinal)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    if (
      previous === undefined ||
      (previous.completedAt != null &&
        DateTime.toEpochMillis(previous.completedAt) <= requestedAtMs)
    ) {
      return null;
    }
    run = previous;
  }
  return run;
}

/**
 * The request moved to the run a wake message (`isWakeMessageDispatch`)
 * started, or null when nothing moves: the wake steered into the awaited run
 * or delivered nothing new.
 */
export function wakeRetargetedArchiveRequest(
  request: OrchestrationV2ThreadArchiveRequest,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "userMessageId">>,
  wakeMessageId: MessageId,
): OrchestrationV2ThreadArchiveRequest | null {
  const wakeRun = runs.find((run) => run.userMessageId === wakeMessageId);
  if (wakeRun === undefined || wakeRun.id === request.runId) return null;
  const target = runs.find((run) => run.id === request.runId);
  if (target !== undefined && wakeRun.ordinal <= target.ordinal) return null;
  return { ...request, runId: wakeRun.id };
}

/**
 * Stop cancels a pending archive only while the run it waits on is still
 * running, or the run before the queued wake it was moved to.
 */
export function stopCancelsArchive(
  request: OrchestrationV2ThreadArchiveRequest,
  runs: ReadonlyArray<ArchiveRun>,
  stoppedRunId: RunId,
): boolean {
  if (request.runId === null) return false;
  const run = runs.find((candidate) => candidate.id === stoppedRunId);
  const target = runs.find((candidate) => candidate.id === request.runId);
  return (
    run !== undefined &&
    target !== undefined &&
    run.ordinal <= target.ordinal &&
    RUNNING_RUN_STATUSES.has(run.status)
  );
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
