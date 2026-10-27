import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type ArchiveToggleAction,
  canSnooze,
  effectiveSnoozed,
  resolveArchiveToggleAction,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { conversationForkTarget } from "@t3tools/client-runtime/state/thread-fork";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type ScopedThreadRef,
  ThreadId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useRouter } from "@tanstack/react-router";

import {
  getFallbackThreadIdAfterDelete,
  pinOrderKeyBetween,
  shouldNavigateAfterThreadPark,
} from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { pauseListeningForThread, stopListeningForThread } from "../state/listeningPlayback";
import { environmentSession, readEnvironmentScope } from "../state/session";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { sessionImportEnvironment } from "../state/sessionImport";
import { orchestrationEnvironment } from "../state/orchestration";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useNewThreadHandler } from "./useHandleNewThread";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { readLocalApi } from "../localApi";
import {
  readConversationForkOptions,
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentSupportsActiveMark,
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsPinReorder,
  readEnvironmentSupportsActiveReorder,
  readEnvironmentSupportsCustomGroups,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  readEnvironmentSupportsSnoozeUntilDone,
  readEnvironmentSupportsVisitedTracking,
  readEnvironmentThreadRefs,
  readProject,
  readThreadShell,
  readThreadShells,
  waitForThreadShell,
} from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { clearThreadPreviewState } from "../previewStateStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { resolveVisitTargetAfterPark } from "../threadVisitTargets";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useClientSettings } from "./useSettings";
import * as ThreadUndo from "./threadUndo";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import { useAtomCommand } from "../state/use-atom-command";
import { readEmptyNewThreadDraftId } from "../archiveUndo";
import { foldSplitForParkedThread } from "../components/thread-split/threadSplitStore";
import { newThreadId } from "../lib/utils";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

export class ThreadArchiveBlockedError extends Schema.TaggedError<ThreadArchiveBlockedError>()(
  "ThreadArchiveBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "Cannot archive while the provider is active.";
  }
}

export class ThreadForkUnavailableError extends Schema.TaggedError<ThreadForkUnavailableError>()(
  "ThreadForkUnavailableError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This conversation cannot be forked right now. Wait for its turn to finish.";
  }
}

export class ThreadForkNotSyncedError extends Schema.TaggedError<ThreadForkNotSyncedError>()(
  "ThreadForkNotSyncedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "The fork was created, but its thread data did not reach this client. Reconnect and open it from the sidebar.";
  }
}

// One fork per source thread at a time, so a double click on any surface
// (hover action, menus, palette) cannot create two copies.
const forkingThreadKeys = new Set<string>();

/** Fork: archive attempts in flight (including an open confirmation), shared
 * by every surface, so the same thread archived from two surfaces at once
 * (menu plus shortcut) runs once. */
const archivingThreadKeys = new Set<string>();

/** Deleting a thread expires every pending Undo that would try to revive it. */
function invalidateThreadUndos(target: ScopedThreadRef) {
  const key = scopedThreadKey(target);
  for (const kind of ["archive", "snooze", "settle", "pin"]) {
    ThreadUndo.invalidate(kind, key);
  }
}

export class ThreadSettlementUnsupportedError extends Schema.TaggedError<ThreadSettlementUnsupportedError>()(
  "ThreadSettlementUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support settling yet. Update the server to use Settle.";
  }
}

export class ThreadSnoozeUnsupportedError extends Schema.TaggedError<ThreadSnoozeUnsupportedError>()(
  "ThreadSnoozeUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support snoozing yet. Update the server to use Snooze.";
  }
}

export class ThreadSnoozeBlockedError extends Schema.TaggedError<ThreadSnoozeBlockedError>()(
  "ThreadSnoozeBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This thread is waiting on you. Respond to the pending request before snoozing it.";
  }
}

function topOfPinnedRunOrderKey(): string | undefined {
  let firstKey: string | null = null;
  for (const shell of readThreadShells()) {
    if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
    if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
  }
  return pinOrderKeyBetween(null, firstKey) ?? undefined;
}

export class ThreadAutoSettleOptOutUnsupportedError extends Schema.TaggedError<ThreadAutoSettleOptOutUnsupportedError>()(
  "ThreadAutoSettleOptOutUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support turning auto-settle off per thread yet. Update the server to use it.";
  }
}

export class ThreadActiveMarkUnsupportedError extends Schema.TaggedError<ThreadActiveMarkUnsupportedError>()(
  "ThreadActiveMarkUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support marking threads as active yet. Update the server to use it.";
  }
}

export class ThreadPinningUnsupportedError extends Schema.TaggedError<ThreadPinningUnsupportedError>()(
  "ThreadPinningUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support pinning yet. Update the server to use Pin.";
  }
}

export class ThreadPinReorderUnsupportedError extends Schema.TaggedError<ThreadPinReorderUnsupportedError>()(
  "ThreadPinReorderUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support reordering pinned threads yet. Update the server to reorder pins.";
  }
}

export class ThreadActiveReorderUnsupportedError extends Schema.TaggedError<ThreadActiveReorderUnsupportedError>()(
  "ThreadActiveReorderUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "Update this environment's server to reorder active threads.";
  }
}

export class ThreadCustomGroupsUnsupportedError extends Schema.TaggedError<ThreadCustomGroupsUnsupportedError>()(
  "ThreadCustomGroupsUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "Update this environment's server to use thread groups.";
  }
}

async function requestThreadUnpinConfirmation(input: {
  enabled: boolean;
  title: string;
  confirm: ((message: string) => Promise<boolean>) | null;
}) {
  const { confirm } = input;
  if (!input.enabled || confirm === null) {
    return AsyncResult.success(true);
  }

  return settlePromise(() =>
    confirm(
      [
        `Unpin thread "${input.title}"?`,
        "This will move the thread out of your pinned section.",
      ].join("\n"),
    ),
  );
}

/** One prompt for a multi-select unpin; the per-thread dialog would stack once per row. */
export async function requestBulkThreadUnpinConfirmation(input: {
  enabled: boolean;
  count: number;
  confirm: ((message: string) => Promise<boolean>) | null;
}) {
  const { confirm } = input;
  if (!input.enabled || confirm === null) {
    return AsyncResult.success(true);
  }

  return settlePromise(() =>
    confirm(
      [
        `Unpin ${input.count} thread${input.count === 1 ? "" : "s"}?`,
        "This will move these threads out of your pinned section.",
      ].join("\n"),
    ),
  );
}

export async function navigateAfterThreadDeletion(navigate: () => Promise<void>) {
  const result = await settlePromise(navigate);
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Thread deleted, but navigation failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}

function useMarkThreadUnread() {
  const markThreadUnreadMutation = useAtomCommand(threadEnvironment.markUnread, {
    reportFailure: false,
  });
  const markThreadUnreadLocal = useUiStateStore((state) => state.markThreadUnread);
  return (target: ScopedThreadRef) => {
    if (readEnvironmentSupportsVisitedTracking(target.environmentId)) {
      void markThreadUnreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      return;
    }
    const thread = readThreadShell(target);
    markThreadUnreadLocal(scopedThreadKey(target), thread?.latestRun?.completedAt);
  };
}

export function useAcknowledgeThreadWoke() {
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  return (target: ScopedThreadRef, wokeAt: string) => {
    if (readEnvironmentSupportsVisitedTracking(target.environmentId)) {
      void visitThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, visitedAt: wokeAt },
      });
      return;
    }
    markThreadVisited(scopedThreadKey(target), wokeAt);
  };
}

function threadOperationFailure(target: ScopedThreadRef) {
  return readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
    ? null
    : AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            message: "This connection cannot change threads.",
            requiredScope: AuthOrchestrationOperateScope,
          }),
        ),
      );
}

export function useThreadActions() {
  const archiveThreadMutation = useOrchestrationCommand(threadEnvironment.archive, {
    reportFailure: false,
  });
  const unarchiveThreadMutation = useOrchestrationCommand(threadEnvironment.unarchive, {
    reportFailure: false,
  });
  const cancelThreadArchiveMutation = useOrchestrationCommand(threadEnvironment.cancelArchive, {
    reportFailure: false,
  });
  const scheduleThreadArchiveMutation = useOrchestrationCommand(threadEnvironment.scheduleArchive, {
    reportFailure: false,
  });
  const deleteThreadMutation = useOrchestrationCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const settleThreadMutation = useOrchestrationCommand(threadEnvironment.settle, {
    reportFailure: false,
  });
  const unsettleThreadMutation = useOrchestrationCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  const pinThreadMutation = useOrchestrationCommand(threadEnvironment.pin, {
    reportFailure: false,
  });
  const unpinThreadMutation = useOrchestrationCommand(threadEnvironment.unpin, {
    reportFailure: false,
  });
  const setThreadAutoSettleMutation = useOrchestrationCommand(threadEnvironment.setAutoSettle, {
    reportFailure: false,
  });
  const setThreadActiveMarkMutation = useOrchestrationCommand(threadEnvironment.setActiveMark, {
    reportFailure: false,
  });
  const reorderPinnedThreadMutation = useOrchestrationCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  const reorderActiveThreadMutation = useOrchestrationCommand(threadEnvironment.reorderActive, {
    reportFailure: false,
  });
  const setThreadCustomGroupMutation = useOrchestrationCommand(threadEnvironment.setCustomGroup, {
    reportFailure: false,
  });
  const snoozeThreadMutation = useOrchestrationCommand(threadEnvironment.snooze, {
    reportFailure: false,
  });
  const unsnoozeThreadMutation = useOrchestrationCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const forkThreadMutation = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });
  const forkImportedThreadMutation = useAtomCommand(sessionImportEnvironment.forkThread, {
    reportFailure: false,
  });
  const markThreadUnread = useMarkThreadUnread();
  const stopThreadSession = useOrchestrationCommand(threadEnvironment.stopSession);
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, {
    reportFailure: false,
  });
  const loadSessionState = useAtomQueryRunner(environmentSession.sessionStateAtom, {
    reportFailure: false,
  });
  const loadWorktreeThreadIds = useAtomQueryRunner(orchestrationEnvironment.worktreeThreadIds, {
    reportFailure: false,
    refresh: true,
  });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const sidebarThreadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmThreadArchive = useClientSettings((settings) => settings.confirmThreadArchive);
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const confirmThreadUnpin = useClientSettings((settings) => settings.confirmThreadUnpin);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalUiState = useTerminalUiStateStore((state) => state.clearTerminalUiState);
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();

  const resolveThreadTarget = (target: ScopedThreadRef) => {
    const thread = readThreadShell(target);
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  };
  const getCurrentRouteThreadRef = () => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  };

  const unarchiveThread = async (
    target: ScopedThreadRef,
    opts: {
      navigate?: boolean;
      /** The thread archiving moved the reader to; still on it, they return. */
      returnFrom?: string | null;
    } = {},
  ) => {
    ThreadUndo.invalidate("archive", scopedThreadKey(target));
    // Only an empty, unsubmitted draft (or the thread archiving moved the
    // reader to) gets replaced by the restored thread; re-checked after the
    // round trip so a draft the reader started typing into, or a thread
    // they opened, meanwhile stays put.
    const emptyDraftId = opts.navigate ? readEmptyNewThreadDraftId(router) : null;
    const isOnLanding = () => {
      const routeRef = getCurrentRouteThreadRef();
      return (
        opts.returnFrom != null &&
        routeRef !== null &&
        scopedThreadKey(routeRef) === opts.returnFrom
      );
    };
    const wasOnLanding = isOnLanding();
    const result = await unarchiveThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag === "Failure") {
      return result;
    }
    refreshArchivedThreadsForEnvironment(target.environmentId);
    if (
      (emptyDraftId !== null && readEmptyNewThreadDraftId(router) === emptyDraftId) ||
      (wasOnLanding && isOnLanding())
    ) {
      return settlePromise(() =>
        router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(target),
        }),
      );
    }
    return result;
  };

  const archiveThread = async (target: ScopedThreadRef, opts: { onArchived?: () => void } = {}) => {
    const resolved = resolveThreadTarget(target);
    if (!resolved) return AsyncResult.success(undefined);
    const { thread, threadRef } = resolved;
    if (!threadRuntimeCanArchive(thread.runtime)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadArchiveBlockedError({
            environmentId: threadRef.environmentId,
            threadId: threadRef.threadId,
          }),
        ),
      );
    }

    const currentRouteThreadRef = getCurrentRouteThreadRef();
    const wasOpen =
      currentRouteThreadRef?.threadId === threadRef.threadId &&
      currentRouteThreadRef.environmentId === threadRef.environmentId;
    // The thread the reader moves to below, which Undo leaves again.
    let landedOn: string | null = null;
    const action = ThreadUndo.begin("archive", scopedThreadKey(threadRef));
    const archiveResult = await archiveThreadMutation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (archiveResult._tag === "Failure") {
      action.finish();
      return archiveResult;
    }
    // Archived rows leave every list surface carrying the pause control,
    // so the thread's audio pauses (but stays loaded and resumable).
    pauseListeningForThread(threadRef.environmentId, threadRef.threadId);
    const wokeAt = threadWokeAt(thread, { now: new Date().toISOString() });
    if (wokeAt !== null) {
      markThreadVisited(scopedThreadKey(threadRef), wokeAt);
    }
    refreshArchivedThreadsForEnvironment(threadRef.environmentId);
    opts.onArchived?.();
    showThreadUndoNotice({
      action: "Archived",
      claim: action,
      // Undo also brings the reader back when archiving moved them away.
      undo: () => unarchiveThread(threadRef, { navigate: wasOpen, returnFrom: landedOn }),
      failureTitle: "Failed to undo archive",
    });

    // In a split, the other pane's thread stays on screen. Otherwise a reader still
    // on the archived thread moves to the previously visited thread (Ctrl+Tab) or a
    // new draft. Agent and scheduled archives never move the reader (ParkedThreadWatcher).
    const threadKey = scopedThreadKey(threadRef);
    const routeRefAfterArchive = getCurrentRouteThreadRef();
    const routeKeyAfterArchive =
      routeRefAfterArchive === null ? null : scopedThreadKey(routeRefAfterArchive);
    const foldedSplit = foldSplitForParkedThread(threadKey, routeKeyAfterArchive, (ref) =>
      router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) }),
    );

    if (wasOpen && !foldedSplit && routeKeyAfterArchive === threadKey) {
      const previous = resolveVisitTargetAfterPark(threadRef);
      if (previous?.kind === "server") landedOn = scopedThreadKey(previous.threadRef);
      const navigationResult = await settlePromise((): Promise<unknown> =>
        previous === null
          ? handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId))
          : previous.kind === "draft"
            ? router.navigate({ to: "/draft/$draftId", params: { draftId: previous.draftId } })
            : router.navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(previous.threadRef),
              }),
      );
      if (navigationResult._tag === "Failure") {
        return navigationResult;
      }
      return archiveResult;
    }

    return archiveResult;
  };

  const deleteThread = async (
    target: ScopedThreadRef,
    opts: { deletedThreadKeys?: ReadonlySet<string> } = {},
  ) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const resolved = resolveThreadTarget(target);
    if (!resolved) {
      const result = await deleteThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Success") {
        invalidateThreadUndos(target);
        refreshArchivedThreadsForEnvironment(target.environmentId);
        // Audio owned by a deleted thread must not keep playing with no
        // control anywhere.
        stopListeningForThread(target.environmentId, target.threadId);
        clearThreadPreviewState(target);
      }
      return result;
    }
    const { thread, threadRef } = resolved;
    const threads = readEnvironmentThreadRefs(threadRef.environmentId).flatMap((ref) => {
      const shell = readThreadShell(ref);
      return shell === null ? [] : [shell];
    });
    const threadProject = readProject({
      environmentId: threadRef.environmentId,
      projectId: thread.projectId,
    });
    const deletedIds =
      opts.deletedThreadKeys && opts.deletedThreadKeys.size > 0
        ? new Set<ThreadId>(
            [...opts.deletedThreadKeys].flatMap((threadKey) => {
              const ref = parseScopedThreadKey(threadKey);
              return ref && ref.environmentId === threadRef.environmentId ? [ref.threadId] : [];
            }),
          )
        : undefined;
    const survivingThreads =
      deletedIds && deletedIds.size > 0
        ? threads.filter((entry) => entry.id === threadRef.threadId || !deletedIds.has(entry.id))
        : threads;
    const environmentConfig = appAtomRegistry
      .get(environmentServerConfigsAtom)
      .get(threadRef.environmentId);
    let orphanedWorktreePath = getOrphanedWorktreePathForThread(
      survivingThreads,
      threadRef.threadId,
    );
    // A shell that leaves idle subagent children out cannot prove nobody else uses the worktree,
    // so the server's list decides. A failed read keeps the worktree.
    if (orphanedWorktreePath !== null && environmentConfig?.shellThreadFamilies === true) {
      const occupants = await loadWorktreeThreadIds({
        environmentId: threadRef.environmentId,
        input: { worktreePath: orphanedWorktreePath },
      });
      if (
        occupants._tag !== "Success" ||
        occupants.value.threadIds.some(
          (threadId) => threadId !== threadRef.threadId && deletedIds?.has(threadId) !== true,
        )
      ) {
        orphanedWorktreePath = null;
      }
    }
    const displayWorktreePath = orphanedWorktreePath
      ? formatWorktreePathForDisplay(orphanedWorktreePath)
      : null;
    const localApi = readLocalApi();
    let canDeleteWorktree = false;
    if (
      orphanedWorktreePath !== null &&
      threadProject !== null &&
      !isScratchProject(threadProject, environmentConfig?.scratchWorkspaceRoot) &&
      localApi
    ) {
      const sessionResult = await loadSessionState(threadRef.environmentId);
      const permissionFailure = threadOperationFailure(threadRef);
      if (permissionFailure) return permissionFailure;
      canDeleteWorktree =
        sessionResult._tag === "Success" &&
        sessionGrantsScope(sessionResult.value, AuthSourceControlWriteScope);
    }
    let shouldDeleteWorktree = false;
    const environmentSettings = environmentConfig?.settings;
    const automaticWorktreeCleanup = environmentSettings
      ? resolveWorktreeCleanup(environmentSettings, thread.projectId).worktreeOnDelete
      : false;
    if (canDeleteWorktree && localApi && !automaticWorktreeCleanup) {
      const confirmationResult = await settlePromise(() =>
        localApi.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmationResult._tag === "Failure") {
        return confirmationResult;
      }
      shouldDeleteWorktree = confirmationResult.value;
    }

    if (thread.runtime !== null) {
      await stopThreadSession({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
    }

    const deletedThreadIds = deletedIds ?? new Set<ThreadId>();
    const currentRouteThreadRef = getCurrentRouteThreadRef();
    const shouldNavigateToFallback =
      currentRouteThreadRef?.threadId === threadRef.threadId &&
      currentRouteThreadRef.environmentId === threadRef.environmentId;
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads,
      deletedThreadId: threadRef.threadId,
      deletedThreadIds,
      sortOrder: sidebarThreadSortOrder,
    });
    const deleteResult = await deleteThreadMutation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (deleteResult._tag === "Failure") {
      return deleteResult;
    }
    invalidateThreadUndos(threadRef);
    refreshArchivedThreadsForEnvironment(threadRef.environmentId);
    // Audio owned by a deleted thread must not keep playing with no
    // control anywhere.
    stopListeningForThread(threadRef.environmentId, threadRef.threadId);
    releaseComposerDraftUploads(threadRef);
    clearComposerDraftForThread(threadRef);
    clearProjectDraftThreadById(
      scopeProjectRef(threadRef.environmentId, thread.projectId),
      threadRef,
    );
    clearTerminalUiState(threadRef);
    clearThreadPreviewState(threadRef);

    if (shouldNavigateToFallback) {
      const fallbackThread = fallbackThreadId
        ? readThreadShell(scopeThreadRef(threadRef.environmentId, fallbackThreadId))
        : null;
      await navigateAfterThreadDeletion(() =>
        fallbackThread
          ? router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
              ),
              replace: true,
            })
          : router.navigate({ to: "/", replace: true }),
      );
    }

    if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
      return deleteResult;
    }

    const removeResult = readEnvironmentScope(threadRef.environmentId, AuthSourceControlWriteScope)
      ? await removeWorktree({
          environmentId: threadRef.environmentId,
          input: {
            cwd: threadProject.workspaceRoot,
            path: orphanedWorktreePath,
            force: true,
          },
        })
      : AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              message: "This connection can no longer remove worktrees.",
              requiredScope: AuthSourceControlWriteScope,
            }),
          ),
        );
    const refreshResult =
      removeResult._tag === "Success"
        ? await refreshVcsStatus({
            environmentId: threadRef.environmentId,
            input: { cwd: threadProject.workspaceRoot },
          })
        : null;
    const cleanupFailure =
      removeResult._tag === "Failure"
        ? removeResult
        : refreshResult?._tag === "Failure"
          ? refreshResult
          : null;
    if (cleanupFailure) {
      const removalFailed = removeResult._tag === "Failure";
      const error = squashAtomCommandFailure(cleanupFailure);
      const message = error instanceof Error ? error.message : "An error occurred.";
      console.error("Worktree cleanup failed after thread deletion", {
        threadId: threadRef.threadId,
        projectCwd: threadProject.workspaceRoot,
        worktreePath: orphanedWorktreePath,
        error,
      });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: removalFailed
            ? "Failed to delete worktree"
            : "Worktree deleted, but Git status refresh failed",
          description: removalFailed
            ? `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`
            : message,
        }),
      );
      // Cleanup has its own toast; reporting its failure would falsely imply deletion failed.
    }
    return deleteResult;
  };

  const unsettleThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentSupportsSettlement(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSettlementUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("settle", scopedThreadKey(target));
    // reason "user" pins active until real activity, suppressing auto-settle.
    return unsettleThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  };

  /**
   * Fork: the one user-facing archive path: archive now, when done, or cancel
   * (`resolveArchiveToggleAction`). A changed `expectedAction` does nothing; archiving
   * now confirms when set and toasts failures. Concurrent attempts collapse into one;
   * `onApplied` runs once the request lands, before an archive's navigation.
   */
  const attemptArchiveThread = async (
    target: ScopedThreadRef,
    opts: {
      expectedAction?: ArchiveToggleAction;
      onApplied?: () => void;
      /** Appended to the "Archive when done" notice. */
      scheduledHint?: string;
    } = {},
  ) => {
    const threadKey = scopedThreadKey(target);
    if (archivingThreadKeys.has(threadKey)) return;
    const resolved = resolveThreadTarget(target);
    if (!resolved || resolved.thread.archivedAt !== null) return;
    const run = async () => {
      const toggleAction = resolveArchiveToggleAction(resolved.thread);
      if (opts.expectedAction !== undefined && opts.expectedAction !== toggleAction) return;
      if (toggleAction !== "archive") {
        // Scheduling and cancelling are reversible, so they skip the confirmation.
        const input = { threadId: target.threadId };
        const result = await (toggleAction === "cancel"
          ? cancelThreadArchiveMutation({ environmentId: target.environmentId, input })
          : scheduleThreadArchiveMutation({
              environmentId: target.environmentId,
              input: { ...input, afterTurn: true },
            }));
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Unable to update thread archive",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        opts.onApplied?.();
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: toggleAction === "cancel" ? "Archive cancelled" : "Archive when done",
            description:
              toggleAction === "cancel"
                ? "This thread will stay open."
                : `Archives when the current turn and background work finish.${
                    opts.scheduledHint === undefined ? "" : ` ${opts.scheduledHint}`
                  }`,
          }),
        );
        return;
      }
      if (confirmThreadArchive) {
        const localApi = readLocalApi();
        if (!localApi) return;
        const confirmed = await settlePromise(() =>
          localApi.dialogs.confirm(`Archive thread "${resolved.thread.title}"?`),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      let didArchive = false;
      const result = await archiveThread(target, {
        onArchived: () => {
          didArchive = true;
          opts.onApplied?.();
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: didArchive
              ? "Thread archived, but navigation failed"
              : "Failed to archive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    };
    archivingThreadKeys.add(threadKey);
    await run().finally(() => archivingThreadKeys.delete(threadKey));
  };

  const setThreadAutoSettle = async (target: ScopedThreadRef, enabled: boolean) => {
    if (!readEnvironmentSupportsAutoSettleOptOut(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadAutoSettleOptOutUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return setThreadAutoSettleMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, enabled },
    });
  };

  const setThreadActiveMark = async (target: ScopedThreadRef, marked: boolean) => {
    if (!readEnvironmentSupportsActiveMark(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadActiveMarkUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return setThreadActiveMarkMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, marked },
    });
  };

  const pinThread = async (target: ScopedThreadRef, opts: { orderKey?: string } = {}) => {
    if (!readEnvironmentSupportsPinning(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinningUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    // Older servers cannot decode orderKey, so send only the pin to them.
    const orderKey = readEnvironmentSupportsPinReorder(target.environmentId)
      ? (opts.orderKey ?? topOfPinnedRunOrderKey())
      : undefined;
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    // Pinning clears snooze, so older Settled or Snoozed undos would fight this pin.
    ThreadUndo.invalidate("settle", scopedThreadKey(target));
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    return pinThreadMutation({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        ...(orderKey !== undefined ? { orderKey } : {}),
      },
    });
  };

  const unpinThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentSupportsPinning(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinningUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const thread = readThreadShell(target);
    const undoPlan = ThreadUndo.planThreadUndo("unpin", thread);
    const action = ThreadUndo.begin("pin", scopedThreadKey(target));
    const result = await unpinThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag === "Success" && action.isCurrent()) {
      showThreadUndoNotice({
        action: "Unpinned",
        claim: action,
        undo: () => runUndoPlan(target, undoPlan),
        failureTitle: "Failed to undo unpin",
      });
    } else {
      action.finish();
    }
    return result;
  };

  const settleThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentSupportsSettlement(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSettlementUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const resolved = resolveThreadTarget(target);
    // oxlint-disable-next-line react/purity -- reads the clock in the settle event handler
    const nowIso = new Date().toISOString();
    const wokeAt = resolved ? threadWokeAt(resolved.thread, { now: nowIso }) : null;
    // Fork: restore only a timed snooze that still held; an expired or
    // raised-hand one had already woken. Settling stops the work an "until
    // it's done" snooze waits on (DECISIONS Q3.1), so that snooze would have
    // woken: never restore it.
    const restoresSnooze =
      resolved !== null &&
      resolved.thread.snoozedUntilRunId == null &&
      effectiveSnoozed(resolved.thread, { now: nowIso });
    const undoPlan = ThreadUndo.planThreadUndo(
      "settle",
      resolved && {
        ...resolved.thread,
        snoozedUntil: restoresSnooze ? resolved.thread.snoozedUntil : null,
      },
    );
    // An older unpin/snooze Undo would re-pin or re-snooze, and the server
    // treats either as a promotion that un-settles; settling supersedes them.
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    const action = ThreadUndo.begin("settle", scopedThreadKey(target));
    const result = await settleThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag !== "Success") {
      action.finish();
      return result;
    }
    if (wokeAt !== null) {
      markThreadVisited(scopedThreadKey(target), wokeAt);
    }
    showThreadUndoNotice({
      action: "Settled",
      claim: action,
      undo: () => runUndoPlan(target, undoPlan),
      failureTitle: "Failed to undo settle",
    });
    return result;
  };

  const confirmAndUnpinThread = async (target: ScopedThreadRef) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const localApi = readLocalApi();
    const resolved = resolveThreadTarget(target);
    const confirmationResult = await requestThreadUnpinConfirmation({
      enabled: confirmThreadUnpin,
      title: resolved?.thread.title ?? "this thread",
      confirm: localApi ? (message) => localApi.dialogs.confirm(message) : null,
    });
    if (confirmationResult._tag === "Failure") {
      return confirmationResult;
    }
    if (!confirmationResult.value) {
      return AsyncResult.success(undefined);
    }
    return unpinThread(target);
  };

  const reorderPinnedThread = async (target: ScopedThreadRef, orderKey: string) => {
    if (!readEnvironmentSupportsPinReorder(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinReorderUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    return reorderPinnedThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey },
    });
  };

  const reorderActiveThread = async (target: ScopedThreadRef, orderKey: string) => {
    if (!readEnvironmentSupportsActiveReorder(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadActiveReorderUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return reorderActiveThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey },
    });
  };

  /** Fork: move a thread into a custom group (null: Active). */
  const setThreadCustomGroup = async (target: ScopedThreadRef, customGroupId: string | null) => {
    if (!readEnvironmentSupportsCustomGroups(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadCustomGroupsUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return setThreadCustomGroupMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, customGroupId },
    });
  };

  const unsnoozeThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentSupportsSnooze(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    return unsnoozeThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  };

  const snoozeThread = async (
    target: ScopedThreadRef,
    snoozedUntil: string | null,
    options?: {
      readonly untilDone?: boolean;
      /** Other threads snoozed in the same batch: never a place to land. */
      readonly alsoParking?: ReadonlySet<string> | undefined;
      /** Where to go when the reader was on the thread and no previous one is left. */
      readonly moveOnFallback?: (() => void) | null;
    },
  ) => {
    const untilDone = options?.untilDone === true;
    // Fork: only "until it's done" omits the wake time, and it needs
    // threadSnoozeUntilDone: older servers drop the flag and would park the
    // thread indefinitely.
    if (
      !readEnvironmentSupportsSnooze(target.environmentId) ||
      (untilDone
        ? snoozedUntil !== null || !readEnvironmentSupportsSnoozeUntilDone(target.environmentId)
        : snoozedUntil === null)
    ) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const resolved = resolveThreadTarget(target);
    if (resolved && !canSnooze(resolved.thread)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeBlockedError({
            environmentId: resolved.threadRef.environmentId,
            threadId: resolved.threadRef.threadId,
          }),
        ),
      );
    }
    const threadKey = scopedThreadKey(target);
    const routeKeyNow = () => {
      const routeRef = getCurrentRouteThreadRef();
      return routeRef === null ? null : scopedThreadKey(routeRef);
    };
    // Only a reader who had the thread open when snoozing moves on; opening
    // it during the await is a choice to look at it.
    const wasOpen = routeKeyNow() === threadKey;
    const action = ThreadUndo.begin("snooze", threadKey);
    const result = await snoozeThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil, ...(untilDone ? { untilDone } : {}) },
    });
    if (result._tag !== "Success") {
      action.finish();
      return result;
    }
    showThreadUndoNotice({
      action: "Snoozed",
      claim: action,
      undo: () => runUndoPlan(target, ThreadUndo.planThreadUndo("snooze")),
      failureTitle: "Failed to wake thread",
    });
    // A reader still on the snoozed thread moves back to the thread they
    // visited before it (the Ctrl+Tab target); in a split, the other pane
    // takes over instead. A navigation made during the await wins over ours.
    const routeKey = routeKeyNow();
    const navigateToThread = (ref: ScopedThreadRef) =>
      router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    if (
      !foldSplitForParkedThread(threadKey, routeKey, navigateToThread) &&
      wasOpen &&
      shouldNavigateAfterThreadPark({
        threadKey,
        currentThreadKey: routeKey,
        action: "snooze",
        // oxlint-disable-next-line react/purity -- reads the clock after the snooze mutation
        now: new Date().toISOString(),
        thread: readThreadShell(target),
      })
    ) {
      const previous = resolveVisitTargetAfterPark(target, options?.alsoParking);
      if (previous === null) {
        options?.moveOnFallback?.();
      } else if (previous.kind === "draft") {
        void router
          .navigate({ to: "/draft/$draftId", params: { draftId: previous.draftId } })
          .catch(() => undefined);
      } else {
        void navigateToThread(previous.threadRef).catch(() => undefined);
      }
    }
    return result;
  };

  const runUndoPlan = (target: ScopedThreadRef, plan: ThreadUndo.ThreadUndoPlan) =>
    ThreadUndo.executeThreadUndo(
      plan,
      async (step) => {
        switch (step.action) {
          case "unsettle":
            return unsettleThread(target);
          case "unsnooze":
            return unsnoozeThread(target);
          case "pin":
            return pinThread(
              target,
              step.orderKey === undefined ? {} : { orderKey: step.orderKey },
            );
          case "snooze":
            return snoozeThreadMutation({
              environmentId: target.environmentId,
              input: { threadId: target.threadId, snoozedUntil: step.snoozedUntil },
            });
        }
      },
      (result) => result._tag === "Success",
    );

  const confirmAndDeleteThread = async (target: ScopedThreadRef) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const localApi = readLocalApi();
    const resolved = resolveThreadTarget(target);

    if (confirmThreadDelete && localApi) {
      const title = resolved?.thread.title ?? "this thread";
      const confirmationResult = await settlePromise(() =>
        localApi.dialogs.confirm(
          [
            `Delete thread "${title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmationResult._tag === "Failure") {
        return confirmationResult;
      }
      if (!confirmationResult.value) {
        return AsyncResult.success(undefined);
      }
    }

    return deleteThread(target);
  };

  /** Forks the whole conversation into a new thread and opens it. */
  const forkThread = async (target: ScopedThreadRef) => {
    const threadKey = scopedThreadKey(target);
    // Interrupted, not a plain failure: callers treat interrupts as silent
    // no-ops, which is right for a duplicate click.
    if (forkingThreadKeys.has(threadKey)) return AsyncResult.failure(Cause.interrupt());
    const thread = readThreadShell(target);
    const forkTarget =
      thread === null ? null : conversationForkTarget(thread, readConversationForkOptions(thread));
    if (forkTarget === null) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadForkUnavailableError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const run = async () => {
      let targetThreadId = newThreadId();
      if (forkTarget.type === "run") {
        const result = await forkThreadMutation({
          environmentId: target.environmentId,
          input: { sourceThreadId: target.threadId, targetThreadId, runId: forkTarget.runId },
        });
        if (result._tag === "Failure") return result;
      } else {
        // A runless imported thread forks its native session server-side.
        const result = await forkImportedThreadMutation({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        });
        if (result._tag === "Failure") return result;
        targetThreadId = result.value.threadId;
      }
      const targetThreadRef = scopeThreadRef(target.environmentId, targetThreadId);
      if (!(await waitForThreadShell(targetThreadRef))) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadForkNotSyncedError({
              environmentId: target.environmentId,
              threadId: targetThreadId,
            }),
          ),
        );
      }
      const navigation = await settlePromise(() =>
        router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(targetThreadRef),
        }),
      );
      return navigation._tag === "Failure" ? navigation : AsyncResult.success(targetThreadId);
    };
    forkingThreadKeys.add(threadKey);
    return run().finally(() => forkingThreadKeys.delete(threadKey));
  };

  return {
    archiveThread,
    attemptArchiveThread,
    unarchiveThread,
    deleteThread,
    confirmAndDeleteThread,
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    confirmAndUnpinThread,
    reorderPinnedThread,
    reorderActiveThread,
    setThreadCustomGroup,
    markThreadUnread,
    setThreadAutoSettle,
    setThreadActiveMark,
    forkThread,
  };
}
