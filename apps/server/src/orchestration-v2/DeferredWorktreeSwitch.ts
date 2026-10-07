/**
 * Fork: deferred agent-requested worktree switch decisions. A Codex agent asks
 * from its running run to move the thread to another checkout of the same
 * repository; the move applies once that run completes (a v2 run reaches
 * `completed` after its final checkpoint capture, even a failed one) and
 * background work that holds completion ends. New work (a message sent or
 * still queued, or a run created after the request), a stopped run, a
 * checkout change, an archive or a pending archive cancels it; a failed final
 * checkpoint records an error and keeps the checkout. Pure: the orchestrator
 * and `ThreadWorktreeSwitchScheduler` share these rules.
 */
import type {
  CommandId,
  OrchestrationV2AppThread,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ThreadWorktreeSwitch,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

import {
  type ArchiveCheckpoint,
  type ArchiveRun,
  finalCheckpointFailed,
  latestRunOrdinal,
  pendingArchiveRequest,
  RUNNING_RUN_STATUSES,
  STOPPED_RUN_STATUSES,
} from "./DeferredArchive.ts";

export const WORKTREE_SWITCH_DETAIL = {
  agent: "Cancelled by agent.",
  newWork: "The thread started new work.",
  checkout: "The thread changed checkout before the switch.",
  archived: "The thread was archived.",
  archivePending: "An archive is pending for the thread.",
  failed: "The turn failed or was interrupted.",
  checkpointFailed: "The final checkpoint failed. The checkout was not changed.",
} as const;

type SwitchThread = Pick<
  OrchestrationV2AppThread,
  "worktreeSwitch" | "archiveRequest" | "archivedAt" | "deletedAt" | "worktreePath" | "branch"
>;

/** A pending switch on an undeleted thread, archived ones included so they can be cancelled. */
export function pendingWorktreeSwitch(
  thread: Pick<OrchestrationV2AppThread, "worktreeSwitch" | "deletedAt">,
): OrchestrationV2ThreadWorktreeSwitch | null {
  const request = thread.worktreeSwitch;
  return request?.status === "pending" && thread.deletedAt === null ? request : null;
}

export function cancelledWorktreeSwitch(
  request: OrchestrationV2ThreadWorktreeSwitch,
  detail: string,
): OrchestrationV2ThreadWorktreeSwitch {
  return { ...request, status: "cancelled", detail };
}

export function finishedWorktreeSwitch(
  request: OrchestrationV2ThreadWorktreeSwitch,
  error: string | undefined,
): OrchestrationV2ThreadWorktreeSwitch {
  if (error !== undefined) return { ...request, status: "error", detail: error };
  const { detail: _detail, ...rest } = request;
  return { ...rest, status: "completed" };
}

/** The run a switch request waits on: the newest run whose provider turn is still running. */
export function requestingRun<R extends ArchiveRun>(runs: ReadonlyArray<R>): R | null {
  return (
    runs
      .filter((run) => RUNNING_RUN_STATUSES.has(run.status))
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null
  );
}

export type WorktreeSwitchSchedulePlan =
  | { readonly type: "reject"; readonly detail: string }
  | { readonly type: "pending"; readonly request: OrchestrationV2ThreadWorktreeSwitch };

/**
 * Decide a `thread.worktree-switch.schedule`. `run` is the requesting run (one
 * of the thread's `runs`) and `driver` its provider driver. A later request
 * replaces a pending one.
 */
export function planWorktreeSwitchSchedule(input: {
  readonly thread: SwitchThread;
  readonly runs: ReadonlyArray<ArchiveRun>;
  readonly run: ArchiveRun | null;
  readonly driver: ProviderDriverKind | null;
  readonly targetPath: string;
  readonly requestId: CommandId;
  readonly now: DateTime.Utc;
}): WorktreeSwitchSchedulePlan {
  if (input.thread.archivedAt !== null)
    return { type: "reject", detail: "Thread is already archived." };
  if (pendingArchiveRequest(input.thread) !== null) {
    return { type: "reject", detail: "Cancel the pending archive before switching worktrees." };
  }
  if (input.run === null) {
    return { type: "reject", detail: "Call this from a running Codex turn." };
  }
  if (input.driver !== "codex") {
    return {
      type: "reject",
      detail: "Worktree switching is supported for Codex threads. Claude can use EnterWorktree.",
    };
  }
  return {
    type: "pending",
    request: {
      requestId: input.requestId,
      runId: input.run.id,
      sourceWorktreePath: input.thread.worktreePath,
      sourceBranch: input.thread.branch,
      targetPath: input.targetPath,
      requestedAt: DateTime.formatIso(input.now),
      latestRunOrdinal: latestRunOrdinal(input.runs),
      status: "pending",
    },
  };
}

export type WorktreeSwitchDecision =
  | { readonly type: "wait"; readonly detail: string }
  | { readonly type: "switch" }
  | { readonly type: "cancel"; readonly detail: string }
  | { readonly type: "fail"; readonly detail: string };

/** Whether a pending switch can apply now, must keep waiting, is void, or failed. */
export function evaluateWorktreeSwitch(input: {
  readonly thread: SwitchThread;
  readonly request: OrchestrationV2ThreadWorktreeSwitch;
  readonly runs: ReadonlyArray<ArchiveRun>;
  readonly checkpoints: ReadonlyArray<ArchiveCheckpoint>;
  readonly pendingBackgroundTasks: ReadonlyArray<
    Pick<OrchestrationV2PendingBackgroundTask, "kind">
  >;
}): WorktreeSwitchDecision {
  const { thread, request } = input;
  if (thread.archivedAt !== null)
    return { type: "cancel", detail: WORKTREE_SWITCH_DETAIL.archived };
  if (pendingArchiveRequest(thread) !== null) {
    return { type: "cancel", detail: WORKTREE_SWITCH_DETAIL.archivePending };
  }
  if (
    thread.worktreePath !== request.sourceWorktreePath ||
    thread.branch !== request.sourceBranch
  ) {
    return { type: "cancel", detail: WORKTREE_SWITCH_DETAIL.checkout };
  }
  const target = input.runs.find((run) => run.id === request.runId);
  // A queued run, even one created earlier (a reordered or edit-held queue),
  // would start in the old checkout's scope, and a run created after the
  // request is new work. A later-created run that already ran is not.
  const latestOrdinal = request.latestRunOrdinal ?? target?.ordinal ?? 0;
  if (
    target === undefined ||
    input.runs.some(
      (run) => run.id !== target.id && (run.status === "queued" || run.ordinal > latestOrdinal),
    )
  ) {
    return { type: "cancel", detail: WORKTREE_SWITCH_DETAIL.newWork };
  }
  if (STOPPED_RUN_STATUSES.has(target.status)) {
    return { type: "cancel", detail: WORKTREE_SWITCH_DETAIL.failed };
  }
  if (target.status !== "completed") return { type: "wait", detail: "The turn has not finished." };
  if (finalCheckpointFailed(target, input.checkpoints)) {
    return { type: "fail", detail: WORKTREE_SWITCH_DETAIL.checkpointFailed };
  }
  if (backgroundWorkHoldsCompletion(input.pendingBackgroundTasks)) {
    return { type: "wait", detail: "Background work is still running." };
  }
  return { type: "switch" };
}
