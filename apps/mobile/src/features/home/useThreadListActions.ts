import type { ThreadMoveDestination } from "../threads/threadOrder";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { showThreadUndoNotice } from "./thread-undo-notice";
import {
  canSnooze,
  resolveArchiveToggleAction,
} from "@t3tools/client-runtime/state/thread-settled";
import { mergeThreadGroups, threadGroupId } from "@t3tools/shared/threadGroups";
import { AuthOrchestrationOperateScope, CommandId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useRef } from "react";

import { withThreadDismissal } from "./thread-dismissal";
import * as Dialog from "../../components/ui/Dialog";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import { appAtomRegistry } from "../../state/atom-registry";
import { pauseListeningForThread, stopListeningForThread } from "../../state/listeningPlayer";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import {
  enqueueThreadLifecycleIntent,
  threadLifecycleOutboxManager,
} from "../../state/thread-lifecycle-outbox";
import {
  isThreadLifecycleUserAction,
  threadLifecycleActionUsesOutbox,
  threadLifecycleIntentRevision,
  type ThreadLifecycleUserAction,
} from "../../state/thread-lifecycle-outbox-model";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  beginPendingThreadOrder,
  getPendingThreadOrder,
  threadDropBusyAtom,
} from "../../state/thread-order";
import {
  createPendingThreadOrder,
  createThreadMovePlanner,
  threadDropLifecycle,
} from "../threads/threadOrder";
import { getThreadListV2OrderedSection } from "../threads/threadListV2";
import { threadCanArchive } from "./threadArchive";
import { resolveThreadTitleRename } from "../threads/thread-title-rename";
import { useForkConversation } from "../threads/useForkConversation";

function environmentConfigLoaded(environmentId: EnvironmentThreadShell["environmentId"]) {
  return appAtomRegistry.get(environmentServerConfigsAtom).has(environmentId);
}

function environmentSupportsSnoozeUntilDone(
  environmentId: EnvironmentThreadShell["environmentId"],
) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSnoozeUntilDone === true
  );
}

function environmentSupportsAutoSettleOptOut(
  environmentId: EnvironmentThreadShell["environmentId"],
) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadAutoSettleOptOut === true
  );
}

type ThreadListAction = ThreadLifecycleUserAction | "delete" | "settle" | "unsettle";

const ACTION_FAILURE_MESSAGES: Record<ThreadListAction, string> = {
  archive: "The thread could not be archived.",
  "schedule-archive": "The archive could not be scheduled.",
  unarchive: "The thread could not be unarchived.",
  "cancel-archive": "The archive could not be cancelled.",
  delete: "The thread could not be deleted.",
  settle: "The thread could not be settled.",
  unsettle: "The thread could not be un-settled.",
};

function actionFailureMessage(action: ThreadListAction, error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return ACTION_FAILURE_MESSAGES[action];
}

function selectionHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

function actionFailureTitle(action: ThreadListAction): string {
  if (action === "archive") return "Could not archive thread";
  if (action === "schedule-archive") return "Could not schedule archive";
  if (action === "cancel-archive") return "Could not cancel pending archive";
  if (action === "unarchive") return "Could not unarchive thread";
  if (action === "settle") return "Could not settle thread";
  if (action === "unsettle") return "Could not un-settle thread";
  return "Could not delete thread";
}

function checkThreadOperationPermission(thread: EnvironmentThreadShell, title: string): boolean {
  if (readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return true;
  Dialog.alert(title, "This connection cannot change threads.");
  return false;
}

/** Resolves to true iff the action succeeded or was queued for reconnect. */
function useThreadActionExecutor(
  onCompleted?: (action: ThreadListAction, thread: EnvironmentThreadShell) => void,
) {
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const scheduleArchiveMutation = useAtomCommand(threadEnvironment.scheduleArchive, {
    reportFailure: false,
  });
  const cancelArchiveMutation = useAtomCommand(threadEnvironment.cancelArchive, {
    reportFailure: false,
  });
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const deleteMutation = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const settleMutation = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleMutation = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const inFlightThreadKeys = useRef(new Set<string>());

  const executeAction = async (
    action: ThreadListAction,
    thread: EnvironmentThreadShell,
    onStarted?: () => void,
  ) => {
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (inFlightThreadKeys.current.has(key)) {
      return false;
    }

    inFlightThreadKeys.current.add(key);
    selectionHaptic();
    const succeeded = await (async () => {
      if (
        (action === "settle" || action === "unsettle") &&
        !environmentConfigLoaded(thread.environmentId)
      ) {
        Dialog.alert(
          actionFailureTitle(action),
          "This environment's server does not support settling yet. Update the server to use Settle.",
        );
        return false;
      }
      // Fork: archive controls while disconnected queue a durable intent
      // applied on reconnect, where archives are sent as archive-when-done.
      // They revise any existing intent (Undo), whatever the connection
      // state, so a direct command never races it.
      const existingIntent = appAtomRegistry.get(
        threadLifecycleOutboxManager.intentsByThreadKeyAtom,
      )[key];
      const environmentConnected = connectedEnvironments.some(
        (environment) =>
          environment.environmentId === thread.environmentId &&
          environment.connectionState === "connected",
      );
      if (
        isThreadLifecycleUserAction(action) &&
        threadLifecycleActionUsesOutbox({
          action,
          environmentConnected,
          hasIntent: existingIntent !== undefined,
        })
      ) {
        const revision = threadLifecycleIntentRevision(action, existingIntent);
        const { desiredArchived } = revision;
        if (existingIntent?.desiredArchived === desiredArchived) return true;
        if (desiredArchived) {
          for (const kind of ["settle", "snooze", "pin"]) ThreadUndo.invalidate(kind, key);
        }
        const enqueue = async () => {
          await enqueueThreadLifecycleIntent({
            environmentId: thread.environmentId,
            threadId: thread.id,
            ...revision,
            dispatchAttempted: false,
            dispatchedAction: null,
            commandId: CommandId.make(uuidv4()),
            createdAt: new Date().toISOString(),
            thread: existingIntent?.thread ?? thread.source,
          });
          return true;
        };
        const enqueued = await // A cancelled pending archive keeps its row in place.
        (
          action === "cancel-archive"
            ? enqueue()
            : withThreadDismissal(key, enqueue, (result) => result)
        ).then(
          () => true,
          (error: unknown) => {
            Dialog.alert(actionFailureTitle(action), actionFailureMessage(action, error));
            return false;
          },
        );
        if (!enqueued) return false;
        // A queued archive hides the row just like a direct one.
        if (desiredArchived) pauseListeningForThread(thread.environmentId, thread.id);
        onCompleted?.(desiredArchived ? "archive" : "unarchive", thread);
        return true;
      }

      // Archive keeps its original, narrower guard: never interrupt a
      // thread mid-turn. Offline, the queued intent defers instead.
      if (action === "archive" && !threadCanArchive(thread.runtime)) {
        Dialog.alert(
          actionFailureTitle(action),
          "This thread is working. Interrupt it first, then try again.",
        );
        return false;
      }

      // Checked here, after the outbox branch: an offline connection cannot
      // confirm its grant. The lifecycle-outbox drain checks it on reconnect
      // and drops intents the connection cannot dispatch.
      if (!checkThreadOperationPermission(thread, actionFailureTitle(action))) return false;
      // Scheduling or cancelling a deferred archive keeps the row in place.
      if (action === "schedule-archive" || action === "cancel-archive") {
        const input = { threadId: thread.id };
        const result = await (action === "schedule-archive"
          ? scheduleArchiveMutation({
              environmentId: thread.environmentId,
              input: { ...input, afterTurn: true },
            })
          : cancelArchiveMutation({ environmentId: thread.environmentId, input }));
        if (result._tag === "Failure") {
          Dialog.alert(
            actionFailureTitle(action),
            actionFailureMessage(action, Cause.squash(result.cause)),
          );
          return false;
        }
        onCompleted?.(action, thread);
        return true;
      }
      if (action === "unsettle") ThreadUndo.invalidate("settle", key);
      if (action === "archive" || action === "delete") {
        for (const kind of ["settle", "snooze", "pin"]) ThreadUndo.invalidate(kind, key);
      }
      onStarted?.();
      const result = await withThreadDismissal(
        key,
        async () =>
          action === "unsettle"
            ? // reason "user" pins the thread active: auto-settle stays
              // suppressed until real activity clears the pin server-side.
              await unsettleMutation({
                environmentId: thread.environmentId,
                input: { threadId: thread.id, reason: "user" },
              })
            : await (
                action === "settle"
                  ? settleMutation
                  : action === "archive"
                    ? archiveMutation
                    : action === "unarchive"
                      ? unarchiveMutation
                      : deleteMutation
              )({
                environmentId: thread.environmentId,
                input: { threadId: thread.id },
              }),
        (result) => result._tag === "Success",
      );
      if (result._tag === "Failure") {
        Dialog.alert(
          actionFailureTitle(action),
          actionFailureMessage(action, Cause.squash(result.cause)),
        );
        return false;
      }
      if (action === "archive" || action === "unarchive" || action === "delete") {
        refreshArchivedThreadsForEnvironment(thread.environmentId);
      }
      // Audio owned by a deleted thread must not keep playing with no
      // control anywhere; deletion clears the player outright. Archive
      // pauses instead — archived rows also leave every surface carrying
      // the pause control, but the recording stays loaded and resumable.
      if (action === "delete") {
        stopListeningForThread(thread.environmentId, thread.id);
      } else if (action === "archive") {
        pauseListeningForThread(thread.environmentId, thread.id);
      }
      onCompleted?.(action, thread);
      return true;
    })();
    inFlightThreadKeys.current.delete(key);
    return succeeded;
  };

  return executeAction;
}

// Hookless use* functions skip compilation, leaving their returned handlers unstable.
function confirmThreadDeletion(
  executeAction: (action: ThreadListAction, thread: EnvironmentThreadShell) => Promise<boolean>,
  thread: EnvironmentThreadShell,
  onDeleted?: (thread: EnvironmentThreadShell) => void,
) {
  if (!checkThreadOperationPermission(thread, actionFailureTitle("delete"))) return;
  const title = "Delete thread?";
  const message = `“${thread.title}” will be permanently deleted, including its terminal history.`;
  Dialog.confirm({
    title,
    message,
    confirmText: "Delete",
    destructive: true,
    onConfirm: () => {
      void executeAction("delete", thread).then((result) => {
        if (result) onDeleted?.(thread);
      });
    },
  });
}

export function useThreadListActions(
  options: {
    readonly selectedThreadKey?: string | null;
    readonly onSelectedThreadRemoved?: () => void;
    /** Opens a newly forked thread; defaults to pushing it on the root stack. */
    readonly onOpenForkedThread?: (thread: EnvironmentThreadShell) => void;
  } = {},
): {
  readonly archiveThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly settleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly snoozeThread: (
    thread: EnvironmentThreadShell,
    snoozedUntil: string | null,
    options?: { readonly untilDone?: boolean },
  ) => Promise<boolean>;
  readonly unsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unsettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly pinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly setThreadAutoSettle: (
    thread: EnvironmentThreadShell,
    enabled: boolean,
  ) => Promise<boolean>;
  readonly moveThread: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => Promise<boolean>;
  readonly renameThread: (thread: EnvironmentThreadShell) => void;
  readonly regenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
  /** Forks the conversation and opens the copy. */
  readonly forkThread: (thread: EnvironmentThreadShell) => void;
} {
  const handleSelectedThreadRemoved = (thread: EnvironmentThreadShell) => {
    if (scopedThreadKey(thread.environmentId, thread.id) === options.selectedThreadKey) {
      options.onSelectedThreadRemoved?.();
    }
  };
  // Archived rows leave the list, including archives queued offline; a
  // scheduled or cancelled deferred archive keeps the row.
  const handleCompleted = (action: ThreadListAction, thread: EnvironmentThreadShell) => {
    if (action === "archive") handleSelectedThreadRemoved(thread);
  };
  const executeAction = useThreadActionExecutor(handleCompleted);
  const forkThread = useForkConversation(options.onOpenForkedThread);
  const snoozeMutation = useAtomCommand(threadEnvironment.snooze, { reportFailure: false });
  const unsnoozeMutation = useAtomCommand(threadEnvironment.unsnooze, { reportFailure: false });
  const pinMutation = useAtomCommand(threadEnvironment.pin, { reportFailure: false });
  const unpinMutation = useAtomCommand(threadEnvironment.unpin, { reportFailure: false });
  const setAutoSettleMutation = useAtomCommand(threadEnvironment.setAutoSettle, {
    reportFailure: false,
  });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const snoozeInFlightThreadKeys = useRef(new Set<string>());
  const titleRegenerationInFlightThreadKeys = useRef(new Set<string>());

  /** The archive toggle: archives, archives when done, or cancels a pending archive. */
  const archiveThread = (thread: EnvironmentThreadShell) => {
    const toggle = resolveArchiveToggleAction(thread);
    return executeAction(
      toggle === "cancel"
        ? "cancel-archive"
        : toggle === "schedule"
          ? "schedule-archive"
          : "archive",
      thread,
    );
  };
  const offerUndo = (
    thread: EnvironmentThreadShell,
    action: "Settled" | "Snoozed" | "Unpinned",
    claim: ReturnType<typeof ThreadUndo.begin>,
    plan: ThreadUndo.ThreadUndoPlan,
  ) =>
    showThreadUndoNotice({
      action,
      claim,
      undo: async () => {
        try {
          await ThreadUndo.executeThreadUndo(
            plan,
            async (step) => {
              switch (step.action) {
                case "unsettle":
                  return unsettleThread(thread);
                case "unsnooze":
                  return unsnoozeThread(thread);
                case "pin":
                  return pinThread(thread, step.orderKey);
                case "snooze": {
                  const failureTitle =
                    action === "Unpinned" ? "Could not undo unpin" : "Could not undo settle";
                  if (!checkThreadOperationPermission(thread, failureTitle)) return false;
                  const result = await snoozeMutation({
                    environmentId: thread.environmentId,
                    input: { threadId: thread.id, snoozedUntil: step.snoozedUntil },
                  });
                  if (result._tag === "Failure") {
                    const error = Cause.squash(result.cause);
                    Dialog.alert(
                      "Could not restore snooze",
                      error instanceof Error ? error.message : "The thread could not be snoozed.",
                    );
                    return false;
                  }
                  return true;
                }
              }
            },
            (result) => result,
          );
        } catch (error) {
          Dialog.alert(
            "Could not undo thread action",
            error instanceof Error ? error.message : "Try again.",
          );
        }
      },
    });
  const settleThread = async (thread: EnvironmentThreadShell) => {
    const key = scopedThreadKey(thread.environmentId, thread.id);
    const plan = ThreadUndo.planThreadUndo("settle", thread);
    let claim: ReturnType<typeof ThreadUndo.begin> | undefined;
    const succeeded = await executeAction("settle", thread, () => {
      ThreadUndo.invalidate("pin", key);
      ThreadUndo.invalidate("snooze", key);
      claim = ThreadUndo.begin("settle", key);
    });
    if (claim) {
      if (succeeded) offerUndo(thread, "Settled", claim, plan);
      else claim.finish();
    }
    return succeeded;
  };
  const snoozeThread = async (
    thread: EnvironmentThreadShell,
    snoozedUntil: string | null,
    options?: { readonly untilDone?: boolean },
  ) => {
    if (!checkThreadOperationPermission(thread, "Could not snooze thread")) return false;
    const untilDone = options?.untilDone === true;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (snoozeInFlightThreadKeys.current.has(key)) {
      return false;
    }
    snoozeInFlightThreadKeys.current.add(key);
    const succeeded = await (async () => {
      if (!environmentConfigLoaded(thread.environmentId)) {
        Dialog.alert(
          "Could not snooze thread",
          "This environment's server does not support snoozing yet. Update the server to use Snooze.",
        );
        return false;
      }
      // Fork: only "Until it's done" may omit the wake time on mobile, and
      // older servers drop its flag and would park the thread for good.
      if (
        snoozedUntil === null &&
        (!untilDone || !environmentSupportsSnoozeUntilDone(thread.environmentId))
      ) {
        Dialog.alert(
          "Could not snooze thread",
          "This environment's server does not support snoozing until the work is done. Update the server to use it.",
        );
        return false;
      }
      if (!canSnooze(thread)) {
        Dialog.alert(
          "Could not snooze thread",
          thread.hasPendingApprovals ||
            thread.hasPendingUserInput ||
            thread.pendingSubagentRequest != null
            ? "This thread is waiting on you. Respond to the pending request before snoozing it."
            : "This thread is still starting a turn. Try again once it's running.",
        );
        return false;
      }

      selectionHaptic();
      const claim = ThreadUndo.begin("snooze", key);
      const result = await withThreadDismissal(
        key,
        () =>
          snoozeMutation({
            environmentId: thread.environmentId,
            input: {
              threadId: thread.id,
              snoozedUntil,
              ...(untilDone ? { untilDone } : {}),
            },
          }),
        (result) => result._tag === "Success",
      );
      if (result._tag === "Failure") {
        claim.finish();
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Could not snooze thread",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread could not be snoozed.",
        );
        return false;
      }
      offerUndo(thread, "Snoozed", claim, ThreadUndo.planThreadUndo("snooze"));
      return true;
    })();
    snoozeInFlightThreadKeys.current.delete(key);
    return succeeded;
  };
  const unsnoozeThread = async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Could not wake thread")) return false;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (snoozeInFlightThreadKeys.current.has(key)) {
      return false;
    }
    snoozeInFlightThreadKeys.current.add(key);
    const succeeded = await (async () => {
      if (!environmentConfigLoaded(thread.environmentId)) {
        Dialog.alert(
          "Could not wake thread",
          "This environment's server does not support snoozing yet. Update the server to wake this thread.",
        );
        return false;
      }

      selectionHaptic();
      ThreadUndo.invalidate("snooze", key);
      const result = await withThreadDismissal(
        key,
        () =>
          unsnoozeMutation({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, reason: "user" },
          }),
        (result) => result._tag === "Success",
      );
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Could not wake thread",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread could not be woken.",
        );
        return false;
      }
      return true;
    })();
    snoozeInFlightThreadKeys.current.delete(key);
    return succeeded;
  };
  const unsettleThread = async (thread: EnvironmentThreadShell) =>
    (await executeAction("unsettle", thread)) === true;
  const pinThread = async (thread: EnvironmentThreadShell, restoreOrderKey?: string) => {
    if (!checkThreadOperationPermission(thread, "Could not pin thread")) return false;
    if (!environmentConfigLoaded(thread.environmentId)) {
      Dialog.alert(
        "Could not pin thread",
        "This environment's server does not support pinning yet. Update the server to use Pin.",
      );
      return false;
    }
    selectionHaptic();
    const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
    let firstKey: string | null = null;
    for (const shell of shells) {
      if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
      if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
    }
    const orderKey = restoreOrderKey ?? pinOrderKeyBetween(null, firstKey) ?? undefined;
    ThreadUndo.invalidate("pin", scopedThreadKey(thread.environmentId, thread.id));
    // Pinning clears snooze, so older Settled or Snoozed undos would fight this pin.
    ThreadUndo.invalidate("settle", scopedThreadKey(thread.environmentId, thread.id));
    ThreadUndo.invalidate("snooze", scopedThreadKey(thread.environmentId, thread.id));
    const result = await withThreadDismissal(
      scopedThreadKey(thread.environmentId, thread.id),
      () =>
        pinMutation({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, ...(orderKey !== undefined ? { orderKey } : {}) },
        }),
      (result) => result._tag === "Success",
    );
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Could not pin thread",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The thread could not be pinned.",
      );
      return false;
    }
    return true;
  };
  const unpinThread = async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Could not unpin thread")) return false;
    if (!environmentConfigLoaded(thread.environmentId)) {
      Dialog.alert(
        "Could not unpin thread",
        "This environment's server does not support pinning yet. Update the server to use Pin.",
      );
      return false;
    }
    selectionHaptic();
    const plan = ThreadUndo.planThreadUndo("unpin", thread);
    const claim = ThreadUndo.begin("pin", scopedThreadKey(thread.environmentId, thread.id));
    const result = await withThreadDismissal(
      scopedThreadKey(thread.environmentId, thread.id),
      () =>
        unpinMutation({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        }),
      (result) => result._tag === "Success",
    );
    if (result._tag === "Failure") {
      claim.finish();
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Could not unpin thread",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The thread could not be unpinned.",
      );
      return false;
    }
    offerUndo(thread, "Unpinned", claim, plan);
    return true;
  };
  const setThreadAutoSettle = async (thread: EnvironmentThreadShell, enabled: boolean) => {
    if (!checkThreadOperationPermission(thread, "Could not update auto-settle")) return false;
    if (!environmentSupportsAutoSettleOptOut(thread.environmentId)) {
      Dialog.alert(
        "Could not update auto-settle",
        "This environment's server does not support turning auto-settle off per thread yet. Update the server to use it.",
      );
      return false;
    }
    selectionHaptic();
    const result = await setAutoSettleMutation({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, enabled },
    });
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Could not update auto-settle",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The auto-settle setting could not be changed.",
      );
      return false;
    }
    return true;
  };
  const regenerateThreadTitle = async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Could not regenerate title")) return false;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (thread.titleRegeneration != null || titleRegenerationInFlightThreadKeys.current.has(key)) {
      return false;
    }
    if (!environmentConfigLoaded(thread.environmentId)) {
      Dialog.alert(
        "Could not regenerate title",
        "This environment's server does not support title regeneration yet. Update the server to regenerate thread titles.",
      );
      return false;
    }

    titleRegenerationInFlightThreadKeys.current.add(key);
    selectionHaptic();
    const succeeded = await (async () => {
      const result = await updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, regenerateTitle: true },
      });
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Could not regenerate title",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread title could not be regenerated.",
        );
        return false;
      }
      return true;
    })();
    titleRegenerationInFlightThreadKeys.current.delete(key);
    return succeeded;
  };
  const renameThread = (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Could not rename thread")) return;
    const commit = (title: string) => {
      const resolution = resolveThreadTitleRename({ title, originalTitle: thread.title });
      if (resolution.action === "reject-empty") {
        Dialog.alert("Could not rename thread", "Thread title cannot be empty.");
        return;
      }
      if (resolution.action === "noop") return;
      selectionHaptic();
      void updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Success") return;
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Could not rename thread",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread could not be renamed.",
        );
      });
    };

    Dialog.prompt({
      title: "Rename thread",
      initialValue: thread.title,
      confirmText: "Rename",
      onConfirm: commit,
    });
  };

  // Plan against the complete section so filtering does not change a move.
  const reorderPinnedMutation = useAtomCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  const reorderActiveMutation = useAtomCommand(threadEnvironment.reorderActive, {
    reportFailure: false,
  });
  const setCustomGroupMutation = useAtomCommand(threadEnvironment.setCustomGroup, {
    reportFailure: false,
  });
  const moveThread = async (thread: EnvironmentThreadShell, direction: ThreadMoveDestination) => {
    if (!checkThreadOperationPermission(thread, "Could not move thread")) return false;
    if (getPendingThreadOrder() !== null || appAtomRegistry.get(threadDropBusyAtom)) return false;
    const shells = appAtomRegistry.get(environmentThreadShells.navigationThreadShellsAtom);
    const current = shells.find(
      (row) => row.id === thread.id && row.environmentId === thread.environmentId,
    );
    if (!current || current.archivedAt !== null) return false;
    thread = current;
    const section =
      typeof direction === "object" && direction.section !== undefined
        ? direction.section
        : thread.pinnedAt != null
          ? "pinned"
          : "active";
    if (section === "settled") {
      if (!environmentConfigLoaded(thread.environmentId)) return false;
      appAtomRegistry.set(threadDropBusyAtom, true);
      const settled = await settleThread(thread);
      appAtomRegistry.set(threadDropBusyAtom, false);
      return settled;
    }
    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    if (!configs.has(thread.environmentId)) {
      Dialog.alert(
        "Could not move thread",
        "This environment's server does not support reordering these threads. Update the server to arrange them.",
      );
      return false;
    }
    // Fork: active moves stay inside the source or requested custom group.
    const groups = mergeThreadGroups(
      ...[...configs.values()].map((config) => config.settings.threadGroups),
    );
    const customGroupId =
      typeof direction === "object" && direction.customGroupId !== undefined
        ? direction.customGroupId
        : threadGroupId(thread, groups);
    const changesGroup = section === "active" && customGroupId !== threadGroupId(thread, groups);
    if (
      changesGroup &&
      configs.get(thread.environmentId)?.environment.capabilities.threadCustomGroups !== true
    )
      return false;
    const sectionOrdered = getThreadListV2OrderedSection({
      threads: shells,
      section,
      now: new Date().toISOString(),
      queuedThreadKeys: appAtomRegistry.get(queuedThreadKeysAtom),
      settlementEnvironmentIds: new Set(configs.keys()),
      snoozeEnvironmentIds: new Set(configs.keys()),
    });
    const ordered = sectionOrdered.filter(
      (row) => section !== "active" || threadGroupId(row, groups) === customGroupId,
    );
    const assignments = createThreadMovePlanner({
      groups,
      allThreads: shells,
      ordered,
      section,
      reorderableEnvironmentIds: new Set(configs.keys()),
    })(scopedThreadKey(thread.environmentId, thread.id), direction);
    if (assignments === null) return false;
    const lifecycle = threadDropLifecycle(thread, section, new Date().toISOString());
    const crossSection = !ordered.some(
      (row) => row.id === thread.id && row.environmentId === thread.environmentId,
    );
    const shellByKey = new Map(
      shells.map((shell) => [scopedThreadKey(shell.environmentId, shell.id), shell]),
    );
    for (const assignment of assignments) {
      const target = shellByKey.get(assignment.id);
      if (target && !checkThreadOperationPermission(target, "Could not move thread")) return false;
    }
    selectionHaptic();
    appAtomRegistry.set(threadDropBusyAtom, true);
    const pending = crossSection
      ? null
      : beginPendingThreadOrder(
          createPendingThreadOrder({
            ...(section === "active" ? { customGroupId } : {}),
            section,
            ordered,
            movedId: scopedThreadKey(thread.environmentId, thread.id),
            direction,
            assignments,
          }),
        );
    const reorder = section === "pinned" ? reorderPinnedMutation : reorderActiveMutation;
    const moved = await (async () => {
      // Fork: a move into another group changes membership first.
      if (changesGroup) {
        const result = await setCustomGroupMutation({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, customGroupId },
        });
        if (result._tag === "Failure") {
          Dialog.alert("Could not move thread to group", String(Cause.squash(result.cause)));
          return false;
        }
      }
      if (crossSection) {
        if (section === "pinned") {
          const orderKey = assignments.find(
            ({ id }) => id === scopedThreadKey(thread.environmentId, thread.id),
          )?.orderKey;
          // Same as pinThread: older Unpinned, Settled, or Snoozed undos would fight this pin.
          ThreadUndo.invalidate("pin", scopedThreadKey(thread.environmentId, thread.id));
          ThreadUndo.invalidate("settle", scopedThreadKey(thread.environmentId, thread.id));
          ThreadUndo.invalidate("snooze", scopedThreadKey(thread.environmentId, thread.id));
          const result = await pinMutation({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, ...(orderKey === undefined ? {} : { orderKey }) },
          });
          if (result._tag === "Failure") {
            Dialog.alert("Could not pin thread", String(Cause.squash(result.cause)));
            return false;
          }
        } else {
          if (lifecycle.unpin && !(await unpinThread(thread))) return false;
          if (lifecycle.unsettle && !(await unsettleThread(thread))) return false;
          if (lifecycle.unsnooze && !(await unsnoozeThread(thread))) return false;
        }
      }
      for (const assignment of assignments) {
        if (
          crossSection &&
          section === "pinned" &&
          thread.pinnedAt == null &&
          assignment.id === scopedThreadKey(thread.environmentId, thread.id)
        )
          continue;
        if (pending !== null && !pending.isPending()) return false;
        const target = shellByKey.get(assignment.id);
        if (target === undefined) continue;
        if (!checkThreadOperationPermission(target, "Could not move thread")) return false;
        ThreadUndo.invalidate("pin", scopedThreadKey(target.environmentId, target.id));
        const result = await reorder({
          environmentId: target.environmentId,
          input: { threadId: target.id, orderKey: assignment.orderKey },
        });
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          Dialog.alert(
            "Could not move thread",
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "The thread could not be moved.",
          );
          return false;
        }
      }
      pending?.complete();
      return true;
    })();
    if (!moved) pending?.cancel();
    appAtomRegistry.set(threadDropBusyAtom, false);
    return moved;
  };

  const confirmDeleteThread = (thread: EnvironmentThreadShell) =>
    confirmThreadDeletion(executeAction, thread, handleSelectedThreadRemoved);

  return {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    moveThread,
    renameThread,
    regenerateThreadTitle,
    forkThread,
  };
}

export function useArchivedThreadListActions(
  onCompleted?: (thread: EnvironmentThreadShell) => void,
): {
  readonly unarchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
} {
  const handleCompleted = (_action: ThreadListAction, thread: EnvironmentThreadShell) => {
    onCompleted?.(thread);
  };
  const executeAction = useThreadActionExecutor(handleCompleted);
  const unarchiveThread = (thread: EnvironmentThreadShell) => {
    void executeAction("unarchive", thread);
  };
  const confirmDeleteThread = (thread: EnvironmentThreadShell) =>
    confirmThreadDeletion(executeAction, thread);

  return { unarchiveThread, confirmDeleteThread };
}
