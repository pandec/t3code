import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadOutboxFlushBatchIds,
  type ThreadOutboxDeliveryContext,
  type ThreadOutboxDispatchResult,
} from "@t3tools/client-runtime/state/thread-outbox-delivery";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type MessageId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { scopedProjectKey, scopedThreadKey } from "../lib/scopedEntities";
import { prepareTurnAttachments, type PreparedTurnAttachments } from "../lib/attachmentUpload";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { randomHex } from "../lib/uuid";
import { refreshArchivedThreadsForEnvironment } from "../features/archive/useArchivedThreadSnapshots";
import { isModelSelectionUnavailable } from "../lib/modelOptions";
import { appAtomRegistry } from "./atom-registry";
import { useProjects, useServerConfigs, useThreadShells } from "./entities";
import { serverEnvironment } from "./server";
import {
  confirmThreadOutboxMessageQueued,
  ensureThreadOutboxLoaded,
  isThreadOutboxMessageWaitingForPreferences,
  threadOutboxManager,
  threadOutboxRevision,
  updateThreadOutboxMessage,
} from "./thread-outbox";
import { removeThreadOutboxMessage } from "./thread-outbox-removal";
import {
  flattenQueuedThreadMessages,
  isQueuedThreadCreationSendable,
  isSteerWaitingOutGraceWindow,
  pruneExpeditedQueuedMessageIds,
  queuedThreadMessageIntent,
  resolveQueuedThreadSettings,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxDispatchStep,
  resolveThreadOutboxFailureAction,
  selectNextQueuedThreadDispatch,
  shouldRetryThreadOutboxDelivery,
  soonestSteerGraceRemainingMs,
  threadOutboxRetryDelayMs,
  modelSelectionsEqual,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
  type ThreadSettingsSnapshot,
} from "./thread-outbox-model";
import {
  resolveThreadOutboxHydrationAction,
  THREAD_OUTBOX_HYDRATION_MAX_RETRIES,
  THREAD_OUTBOX_HYDRATION_RECOVERY_RETRY_MS,
} from "./thread-outbox-hydration";
import { noteThreadSteerDispatch } from "./thread-steer-pending";
import {
  environmentThreadShells,
  environmentThreads,
  threadDetailToShell,
  threadEnvironment,
} from "./threads";
import {
  appendComposerDraftAttachments,
  composerDraftsAtom,
  flushComposerDrafts,
  type ComposerDraft,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  replaceComposerDraftAttachments,
  removeDeliveredCloudQueuedMessage,
  undoComposerDraftMerge,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";
import { useAtomCommand } from "./use-atom-command";
import { useMobilePreferencesHydrated, useSteerGraceWindowMs } from "./use-mobile-preferences";
import {
  editingQueuedMessageIdsAtom,
  expeditedQueuedMessageIdsAtom,
  noteThreadOutboxStartAccepted,
  threadOutboxProjectionCaughtUp,
  threadOutboxProjectionHoldsAtom,
  threadOutboxProjectionWakeDelayMs,
  useThreadOutboxLoadState,
  useThreadOutboxMessages,
  useThreadOutboxProjectionHolds,
  useThreadOutboxShellStatuses,
} from "./use-thread-outbox";
import {
  setPendingConnectionError,
  useRemoteConnectionStatus,
} from "./use-remote-environment-registry";

export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-id"),
);

export const dispatchingQueuedMessageThreadKeyAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-thread-key"),
);

const CREATION_DELIVERY_CONTEXT: ThreadOutboxDeliveryContext = {
  sessionBaselineKnown: false,
  sessionStatus: null,
  sessionUpdatedAt: null,
  latestTurnId: null,
};

function beginDispatchingQueuedMessage(queuedMessageId: MessageId, threadKey: string): void {
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, queuedMessageId);
  appAtomRegistry.set(dispatchingQueuedMessageThreadKeyAtom, threadKey);
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const current = appAtomRegistry.get(dispatchingQueuedMessageIdAtom);
  if (current !== queuedMessageId) return;
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, null);
  appAtomRegistry.set(dispatchingQueuedMessageThreadKeyAtom, null);
}

function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  );
}

function findThreadIncludingLoadedDetail(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  const shell = findThread(threads, message);
  if (shell !== undefined) {
    return shell;
  }
  const state = Option.getOrUndefined(
    AsyncResult.value(
      appAtomRegistry.get(environmentThreads.stateAtom(message.environmentId, message.threadId)),
    ),
  );
  const detail = state === undefined ? undefined : Option.getOrUndefined(state.data);
  return detail === undefined ? undefined : threadDetailToShell(message.environmentId, detail);
}

function findCreationProject(
  projects: ReadonlyArray<EnvironmentProject>,
  message: QueuedThreadMessage,
): EnvironmentProject | undefined {
  return projects.find(
    (candidate) =>
      candidate.environmentId === message.environmentId &&
      candidate.id === message.creation?.projectId,
  );
}

function settingsCommandId(message: QueuedThreadMessage, setting: string): CommandId {
  return CommandId.make(`${message.commandId}:${setting}`);
}

/**
 * Uploads a queued message's attachments and persists the uploaded ids back
 * onto the queued message. The revision-checked update means an edit accepted
 * while the bytes uploaded wins: this attempt abandons and the next drain pass
 * re-reads the message.
 * `deliveryRevision` is the revision of the payload this attempt will send,
 * used for the delivery removal's compare-and-set.
 */
export async function prepareQueuedMessageAttachments(
  queuedMessage: QueuedThreadMessage,
  supportsImageUploads = false,
): Promise<
  | {
      readonly status: "ready";
      readonly prepared: PreparedTurnAttachments;
      readonly persistedMessage: QueuedThreadMessage;
      readonly deliveryRevision: number;
    }
  | { readonly status: "removed" | "deferred" }
> {
  if (!(await confirmThreadOutboxMessageQueued(queuedMessage))) {
    return { status: "removed" };
  }
  const revision = threadOutboxRevision(queuedMessage.messageId);
  if (!isQueuedMessagePayloadCurrent(queuedMessage, revision)) {
    return { status: "deferred" };
  }
  let persistedMessage = queuedMessage;
  let deliveryRevision = revision;
  const result = await prepareTurnAttachments({
    environmentId: queuedMessage.environmentId,
    attachments: queuedMessage.attachments,
    supportsImageUploads,
    persistUploadedReferences: async (draftAttachments) => {
      if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
        return "abandon";
      }
      const updatedMessage = { ...queuedMessage, attachments: draftAttachments };
      if (!(await updateThreadOutboxMessage(updatedMessage, revision))) {
        return "abandon";
      }
      persistedMessage = updatedMessage;
      deliveryRevision = revision + 1;
      return "persisted";
    },
  });
  if (
    result.status === "abandoned" ||
    !isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)
  ) {
    return { status: "deferred" };
  }
  return { status: "ready", prepared: result, persistedMessage, deliveryRevision };
}

function isQueuedMessagePayloadCurrent(
  message: QueuedThreadMessage,
  expectedRevision: number,
): boolean {
  return (
    threadOutboxRevision(message.messageId) === expectedRevision &&
    Object.values(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
      .flat()
      .some((candidate) => candidate === message)
  );
}

/**
 * Removes a delivered message from the outbox. The revision and editor checks
 * preserve a creation payload when its pending-task editor owns newer work.
 * The outcome tells the caller whether removal completed, ownership changed,
 * or storage cleanup failed. Exported for tests.
 */
export async function completeQueuedMessageDelivery(
  queuedMessage: QueuedThreadMessage,
  deliveryRevision: number,
): Promise<"removed" | "edited" | "failed"> {
  try {
    await removeDeliveredCloudQueuedMessage(queuedMessage).catch((error) => {
      console.warn("[thread-outbox] could not update sign-out snapshot after delivery", {
        messageId: queuedMessage.messageId,
        error,
      });
    });
    // The editor may have taken the entry while startTurn was in flight; its
    // unsaved edits have not bumped the revision yet, so the CAS alone would
    // let removal win and the editor would lose them once it saves.
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      return "edited";
    }
    // Removal also releases the message's local attachment files.
    const removed = await removeThreadOutboxMessage(
      queuedMessage,
      deliveryRevision,
      () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId],
    );
    if (!removed) {
      console.warn(
        "[thread-outbox] delivered message was edited before cleanup; keeping the newer message",
        {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
        },
      );
      return "edited";
    }
    return "removed";
  } catch (error) {
    console.warn("[thread-outbox] failed to remove delivered queued message", {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      error,
    });
    return "failed";
  }
}

/** Retries local cleanup for a send acknowledged in this drain lifetime. */
export async function removeAcknowledgedExistingThreadMessage(
  queuedMessage: QueuedThreadMessage,
  acknowledgedMessageRevisions: Map<MessageId, number>,
): Promise<"removed" | "held" | "edited" | "failed"> {
  const deliveryRevision = acknowledgedMessageRevisions.get(queuedMessage.messageId);
  if (deliveryRevision === undefined) {
    return "edited";
  }
  if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
    return "held";
  }

  const outcome = await completeQueuedMessageDelivery(queuedMessage, deliveryRevision);
  if (outcome === "removed") {
    acknowledgedMessageRevisions.delete(queuedMessage.messageId);
    return "removed";
  }
  if (outcome === "failed") {
    return "failed";
  }
  if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
    return "held";
  }

  // A newer payload owns this message id. Clear the acknowledgement so the
  // edited row goes through normal delivery (or creation recovery) next.
  acknowledgedMessageRevisions.delete(queuedMessage.messageId);
  return "edited";
}

/**
 * Recovers an edited creation after its startTurn succeeded.
 * Exported for tests; the drain is the only production caller.
 */
export async function recoverEditedCreationAfterDelivery(
  queuedMessage: QueuedThreadMessage,
): Promise<"removed" | "deferred" | "failed"> {
  const kept = Object.values(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
    .flat()
    .find((candidate) => candidate.messageId === queuedMessage.messageId);
  if (!kept) {
    return "removed";
  }
  const keptRevision = threadOutboxRevision(kept.messageId);
  if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) {
    return "deferred";
  }
  const draftKey = scopedThreadKey(kept.environmentId, kept.threadId);
  try {
    // Merge before removing. The draft reference keeps the removal sweep from
    // deleting attachment files. allowOverflow matches send-failure recovery.
    await mergeComposerDraftContent(draftKey, {
      text: kept.text,
      ...(kept.inputOrigin !== undefined ? { inputOrigin: kept.inputOrigin } : {}),
      attachments: [],
    });
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) {
      return "deferred";
    }
    if (threadOutboxRevision(kept.messageId) !== keptRevision) {
      return "deferred";
    }
    const existingAttachmentIds = new Set(
      getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
    );
    appendComposerDraftAttachments(
      draftKey,
      kept.attachments.filter((attachment) => !existingAttachmentIds.has(attachment.id)),
      { allowOverflow: true },
    );
    updateComposerDraftSettings(draftKey, {
      ...(kept.modelSelection !== undefined ? { modelSelection: kept.modelSelection } : {}),
      ...(kept.runtimeMode !== undefined ? { runtimeMode: kept.runtimeMode } : {}),
      ...(kept.interactionMode !== undefined ? { interactionMode: kept.interactionMode } : {}),
    });
    // The append only schedules a debounced write. Flush before removing the
    // queue entry, which is the only durable copy until the draft lands.
    await flushComposerDrafts();
  } catch (error) {
    console.warn("[thread-outbox] could not hand an edited pending task to the composer", error);
    return "failed";
  }
  if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) {
    return "deferred";
  }
  try {
    const removed = await removeThreadOutboxMessage(
      kept,
      keptRevision,
      () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId],
    );
    return removed ? "removed" : "deferred";
  } catch (error) {
    console.warn("[thread-outbox] could not remove recovered pending task", error);
    return "failed";
  }
}

/** Exported for tests; the drain is the only production caller. */
export async function restoreRejectedQueuedMessage(
  queuedMessage: QueuedThreadMessage,
  message: string,
): Promise<"restored" | "removed" | "deferred" | "blocked" | "retry"> {
  const draftKey = recoveryDraftKey(queuedMessage);
  // Set once the merge publishes, cleared once the queued message is removed.
  // The catch below uses it to take the merged content back out, so a retry
  // after a mid-recovery failure cannot append the recovered text again.
  let rollback: { readonly snapshot: ComposerDraft; readonly merged: ComposerDraft } | null = null;
  try {
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      return "deferred";
    }
    if (!(await confirmThreadOutboxMessageQueued(queuedMessage))) {
      return "removed";
    }
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      return "deferred";
    }
    // The confirmation above checked this exact payload is what is queued, so
    // the current revision guards the removal at the end against an edit
    // accepted while this recovery ran.
    const revision = threadOutboxRevision(queuedMessage.messageId);

    await waitForComposerDraftsLoaded();
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      return "deferred";
    }
    const originalDraft = getComposerDraftSnapshot(draftKey);
    const existingAttachmentIds = new Set(
      originalDraft.attachments.map((attachment) => attachment.id),
    );
    const addedAttachmentCount = queuedMessage.attachments.filter(
      (attachment) => !existingAttachmentIds.has(attachment.id),
    ).length;
    if (existingAttachmentIds.size + addedAttachmentCount > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      setPendingConnectionError(
        `Remove attachments from the draft before restoring this message. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
      return "blocked";
    }

    let mergedDraft: ComposerDraft;
    try {
      await mergeComposerDraftContent(draftKey, {
        text: queuedMessage.text,
        ...(queuedMessage.inputOrigin !== undefined
          ? { inputOrigin: queuedMessage.inputOrigin }
          : {}),
        attachments: queuedMessage.attachments,
      });
    } finally {
      // Snapshots for the rollbacks below: undoComposerDraftMerge restores
      // the original draft only while it is untouched, and otherwise takes
      // out just what this recovery inserted so edits typed during the awaits
      // survive. Captured in a finally because mergeComposerDraftContent
      // publishes before its persistence await: even its failure leaves the
      // merged content in the draft.
      mergedDraft = getComposerDraftSnapshot(draftKey);
      rollback = { snapshot: originalDraft, merged: mergedDraft };
    }
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      await undoComposerDraftMerge(draftKey, originalDraft, mergedDraft);
      return "deferred";
    }
    updateComposerDraftSettings(draftKey, {
      ...(queuedMessage.modelSelection ? { modelSelection: queuedMessage.modelSelection } : {}),
      ...(queuedMessage.runtimeMode ? { runtimeMode: queuedMessage.runtimeMode } : {}),
      ...(queuedMessage.interactionMode ? { interactionMode: queuedMessage.interactionMode } : {}),
      ...(queuedMessage.creation
        ? {
            workspaceSelection: {
              mode: queuedMessage.creation.workspaceMode,
              branch: queuedMessage.creation.branch,
              worktreePath: queuedMessage.creation.worktreePath,
              ...(queuedMessage.creation.startFromOrigin !== undefined
                ? { startFromOrigin: queuedMessage.creation.startFromOrigin }
                : {}),
            },
          }
        : {}),
    });
    const restoredDraft = getComposerDraftSnapshot(draftKey);
    rollback = { snapshot: originalDraft, merged: restoredDraft };
    await flushComposerDrafts();
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      await undoComposerDraftMerge(draftKey, originalDraft, restoredDraft);
      return "deferred";
    }
    if (!(await confirmThreadOutboxMessageQueued(queuedMessage))) {
      await undoComposerDraftMerge(draftKey, originalDraft, restoredDraft);
      return "removed";
    }
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      await undoComposerDraftMerge(draftKey, originalDraft, restoredDraft);
      return "deferred";
    }
    // Revision-checked: an edit that landed after the confirmation above
    // must not be deleted with the pre-edit payload this recovery restored.
    if (
      !(await removeThreadOutboxMessage(
        queuedMessage,
        revision,
        () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId],
      ))
    ) {
      await undoComposerDraftMerge(draftKey, originalDraft, restoredDraft);
      return "deferred";
    }
    // The queued message is gone; from here the draft owns the content and
    // must never be rolled back.
    rollback = null;
    setPendingConnectionError(message);
    return "restored";
  } catch (error) {
    if (rollback !== null) {
      // Take the recovered content back out (keeping edits typed since) so
      // the retry's merge starts clean instead of appending a duplicate. The
      // in-memory rollback lands even when its own persistence write fails.
      await undoComposerDraftMerge(draftKey, rollback.snapshot, rollback.merged).catch(
        (undoError) => {
          console.warn("[thread-outbox] failed to persist a recovery rollback", undoError);
        },
      );
    }
    console.warn("[thread-outbox] failed to restore an undeliverable message", error);
    setPendingConnectionError(
      error instanceof Error ? error.message : "The unsent message could not be restored.",
    );
    return "retry";
  }
}

function recoveryDraftKey(queuedMessage: QueuedThreadMessage): string {
  return queuedMessage.creation
    ? `new-task:${scopedProjectKey(queuedMessage.environmentId, queuedMessage.creation.projectId)}`
    : scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
}

async function preserveUploadedAttachmentsForEditor(
  originalMessage: QueuedThreadMessage,
  uploadedMessage: QueuedThreadMessage,
): Promise<void> {
  if (!originalMessage.creation) {
    return;
  }

  const draftKey = `pending-task:${originalMessage.messageId}`;
  const draft = getComposerDraftSnapshot(draftKey);
  const uploadedById = new Map(
    uploadedMessage.attachments.map((attachment) => [attachment.id, attachment] as const),
  );
  let changed = false;
  const nextAttachments = draft.attachments.map((attachment) => {
    const uploaded = uploadedById.get(attachment.id);
    if (
      !uploaded?.uploadedAttachmentId ||
      uploaded.uploadEnvironmentId !== originalMessage.environmentId ||
      (attachment.uploadedAttachmentId === uploaded.uploadedAttachmentId &&
        attachment.uploadEnvironmentId === uploaded.uploadEnvironmentId)
    ) {
      return attachment;
    }
    changed = true;
    return {
      ...attachment,
      uploadedAttachmentId: uploaded.uploadedAttachmentId,
      uploadEnvironmentId: uploaded.uploadEnvironmentId,
    };
  });
  if (changed) {
    replaceComposerDraftAttachments(draftKey, nextAttachments);
    await flushComposerDrafts();
  }
}

export function useThreadOutboxDrain(): void {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const editingQueuedMessageIds = useAtomValue(editingQueuedMessageIdsAtom);
  const expeditedMessageIds = useAtomValue(expeditedQueuedMessageIdsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const outboxLoadState = useThreadOutboxLoadState();
  const projectionHolds = useThreadOutboxProjectionHolds();
  // Read live: a changed grace window applies to steers that are still waiting,
  // and to every subsequent send, without a relaunch.
  const steerGraceWindowMs = useSteerGraceWindowMs();
  const preferencesHydrated = useMobilePreferencesHydrated();
  const shellStatuses = useThreadOutboxShellStatuses();
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [retryTick, setRetryTick] = useState(0);
  const [hydrationDegraded, setHydrationDegraded] = useState(false);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const hydrationRetryAttemptRef = useRef(0);
  const hydrationRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());
  // Threads whose queue is being released as one batch, and the ids that batch
  // covers. Cleared once none of those ids remain queued.
  const flushBatchRef = useRef(new Map<string, ReadonlySet<MessageId>>());

  // A batch is done once nothing it covered is queued any more. This must stay
  // declared ahead of the dispatch effect below: a spent batch that outlived
  // its rows would suppress the next turn end's batch for a whole pass.
  useEffect(() => {
    for (const [threadKey, batchIds] of flushBatchRef.current) {
      const remaining = queuedMessagesByThreadKey[threadKey] ?? [];
      const batched = remaining.filter((message) => batchIds.has(message.messageId));
      if (batched.length === 0) {
        flushBatchRef.current.delete(threadKey);
        continue;
      }
      // A batch means "the turn our leader started is still the one running".
      // Losing the environment ends that guarantee: another client may start a
      // turn while we are away, and these messages were queued to follow ours,
      // not to steer into someone else's.
      const environmentId = batched[0]?.environmentId;
      const stillConnected = connectedEnvironments.some(
        (connected) =>
          connected.environmentId === environmentId && connected.connectionState === "connected",
      );
      if (!stillConnected) {
        flushBatchRef.current.delete(threadKey);
      }
    }
  }, [connectedEnvironments, dispatchingQueuedMessageId, queuedMessagesByThreadKey]);

  const acknowledgedMessageRevisionsRef = useRef(new Map<MessageId, number>());
  const acknowledgedPreparedAttachmentsRef = useRef(new Map<MessageId, PreparedTurnAttachments>());
  const blockedRecoverySubscriptionsRef = useRef(
    new Map<
      MessageId,
      { readonly message: QueuedThreadMessage; readonly unsubscribe: () => void }
    >(),
  );

  const scheduleQueuedMessageRetry = useCallback((messageId: MessageId) => {
    const retryAttempt = (retryAttemptRef.current.get(messageId) ?? 0) + 1;
    retryAttemptRef.current.set(messageId, retryAttempt);
    const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt);
    retryNotBeforeRef.current.set(messageId, Date.now() + retryDelayMs);
    const pendingTimer = retryTimersRef.current.get(messageId);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
    }
    const retryTimer = setTimeout(() => {
      retryTimersRef.current.delete(messageId);
      setRetryTick((current) => current + 1);
    }, retryDelayMs);
    retryTimersRef.current.set(messageId, retryTimer);
  }, []);

  const restoreQueuedMessage = useCallback(
    async (
      queuedMessage: QueuedThreadMessage,
      message: string,
    ): Promise<ThreadOutboxDispatchResult> => {
      const result = await restoreRejectedQueuedMessage(queuedMessage, message);
      if (result === "restored" || result === "removed") {
        return { outcome: "removed" };
      }
      if (result === "retry") {
        return { outcome: "failed" };
      }
      if (result !== "blocked") {
        return { outcome: "deferred" };
      }

      if (!blockedRecoverySubscriptionsRef.current.has(queuedMessage.messageId)) {
        const draftKey = recoveryDraftKey(queuedMessage);
        const editorDraftKey = queuedMessage.creation
          ? `pending-task:${queuedMessage.messageId}`
          : null;
        const currentDrafts = appAtomRegistry.get(composerDraftsAtom);
        const blockedAttachments = currentDrafts[draftKey]?.attachments;
        const editorAttachments =
          editorDraftKey === null ? undefined : currentDrafts[editorDraftKey]?.attachments;
        const unsubscribe = appAtomRegistry.subscribe(composerDraftsAtom, (drafts) => {
          if (
            drafts[draftKey]?.attachments === blockedAttachments &&
            (editorDraftKey === null || drafts[editorDraftKey]?.attachments === editorAttachments)
          ) {
            return;
          }
          const active = blockedRecoverySubscriptionsRef.current.get(queuedMessage.messageId);
          if (!active) {
            return;
          }
          blockedRecoverySubscriptionsRef.current.delete(queuedMessage.messageId);
          active.unsubscribe();
          setRetryTick((current) => current + 1);
        });
        blockedRecoverySubscriptionsRef.current.set(queuedMessage.messageId, {
          message: queuedMessage,
          unsubscribe,
        });
      }
      return { outcome: "deferred" };
    },
    [],
  );

  useEffect(() => {
    const nowMs = Date.now();
    const retained = Object.entries(projectionHolds).filter(([, hold]) => {
      const thread = threads.find(
        (candidate) =>
          candidate.environmentId === hold.environmentId && candidate.id === hold.threadId,
      );
      return !threadOutboxProjectionCaughtUp(
        hold,
        thread,
        shellStatuses.get(hold.environmentId) ?? "empty",
        nowMs,
      );
    });
    if (retained.length !== Object.keys(projectionHolds).length) {
      appAtomRegistry.set(threadOutboxProjectionHoldsAtom, Object.fromEntries(retained));
      return;
    }

    // An expired hold in a non-live shell waits for the next shell transition;
    // repeatedly scheduling a zero-delay wake would spin until reconnect.
    const wakeDelayMs = threadOutboxProjectionWakeDelayMs(
      retained.map(([, hold]) => hold),
      nowMs,
    );
    if (wakeDelayMs === null) return;
    const timer = setTimeout(() => {
      setRetryTick((current) => current + 1);
    }, wakeDelayMs);
    return () => clearTimeout(timer);
  }, [projectionHolds, retryTick, shellStatuses, threads]);

  // Keep expedite state only while its row is queued or owned by an in-flight
  // edit/removal. The ownership checks avoid pruning during the manager's
  // optimistic removal window if durable storage later restores the row.
  useEffect(() => {
    const retainedMessageIds = new Set(
      flattenQueuedThreadMessages(queuedMessagesByThreadKey).map(({ messageId }) => messageId),
    );
    if (dispatchingQueuedMessageId !== null) {
      retainedMessageIds.add(dispatchingQueuedMessageId);
    }
    for (const messageId of Object.keys(editingQueuedMessageIds) as MessageId[]) {
      retainedMessageIds.add(messageId);
    }
    const nextExpeditedIds = pruneExpeditedQueuedMessageIds(
      expeditedMessageIds,
      retainedMessageIds,
    );
    if (nextExpeditedIds !== expeditedMessageIds) {
      appAtomRegistry.set(expeditedQueuedMessageIdsAtom, nextExpeditedIds);
    }
  }, [
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    expeditedMessageIds,
    queuedMessagesByThreadKey,
  ]);

  // Nothing else re-renders when a steer's grace window runs out, so wake the
  // drain as the soonest one comes due.
  useEffect(() => {
    if (!preferencesHydrated) {
      return;
    }
    const soonestGraceMs = soonestSteerGraceRemainingMs(
      flattenQueuedThreadMessages(queuedMessagesByThreadKey),
      Date.now(),
      steerGraceWindowMs,
    );
    if (soonestGraceMs === null) {
      return;
    }
    const graceTimer = setTimeout(() => {
      setRetryTick((current) => current + 1);
    }, soonestGraceMs);
    return () => clearTimeout(graceTimer);
  }, [preferencesHydrated, queuedMessagesByThreadKey, retryTick, steerGraceWindowMs]);

  useEffect(() => {
    const hydrationAction = resolveThreadOutboxHydrationAction(
      outboxLoadState,
      hydrationRetryAttemptRef.current,
    );
    if (hydrationAction === "deliver") {
      setHydrationDegraded(false);
      hydrationRetryAttemptRef.current = 0;
      return;
    }
    if (hydrationAction === "wait") return;
    if (hydrationAction === "load") {
      setHydrationDegraded(false);
      void ensureThreadOutboxLoaded();
      return;
    }
    if (hydrationAction === "recover") {
      if (!hydrationDegraded) {
        console.warn("[thread-outbox] storage hydration failed; delivering in-memory queue", {
          attempts: THREAD_OUTBOX_HYDRATION_MAX_RETRIES,
        });
      }
      setHydrationDegraded(true);
      hydrationRetryTimerRef.current = setTimeout(() => {
        hydrationRetryTimerRef.current = null;
        void ensureThreadOutboxLoaded();
      }, THREAD_OUTBOX_HYDRATION_RECOVERY_RETRY_MS);
      return () => {
        if (hydrationRetryTimerRef.current !== null) {
          clearTimeout(hydrationRetryTimerRef.current);
          hydrationRetryTimerRef.current = null;
        }
      };
    }

    setHydrationDegraded(false);
    hydrationRetryAttemptRef.current += 1;
    const delay = threadOutboxRetryDelayMs(hydrationRetryAttemptRef.current);
    hydrationRetryTimerRef.current = setTimeout(() => {
      hydrationRetryTimerRef.current = null;
      void ensureThreadOutboxLoaded();
    }, delay);
    return () => {
      if (hydrationRetryTimerRef.current !== null) {
        clearTimeout(hydrationRetryTimerRef.current);
        hydrationRetryTimerRef.current = null;
      }
    };
  }, [hydrationDegraded, outboxLoadState]);

  useEffect(
    () => () => {
      if (hydrationRetryTimerRef.current !== null) clearTimeout(hydrationRetryTimerRef.current);
      for (const timer of retryTimersRef.current.values()) clearTimeout(timer);
      retryTimersRef.current.clear();
      for (const blocked of blockedRecoverySubscriptionsRef.current.values()) {
        blocked.unsubscribe();
      }
      blockedRecoverySubscriptionsRef.current.clear();
    },
    [],
  );

  const makeDeliveryHelpers = useCallback((queuedMessage: QueuedThreadMessage) => {
    const reportFailure = (
      commandResult: AtomCommandResult<unknown, unknown>,
      stage: ThreadOutboxCommandStage,
    ): { readonly action: "retry" | "restore"; readonly message: string } | null => {
      if (!AsyncResult.isFailure(commandResult)) {
        return null;
      }
      const error = Cause.squash(commandResult.cause);
      const action = resolveThreadOutboxFailureAction({
        stage,
        error,
        interrupted: Cause.hasInterruptsOnly(commandResult.cause),
      });
      console.warn("[thread-outbox] queued message delivery failed", {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
        stage,
        cause: commandResult.cause,
        action,
      });
      return {
        action,
        message: error instanceof Error ? error.message : "The message could not be sent.",
      };
    };
    return { reportFailure };
  }, []);

  const sendQueuedMessage = useCallback(
    async (
      queuedMessage: QueuedThreadMessage,
      thread: ThreadSettingsSnapshot,
      context: ThreadOutboxDeliveryContext,
    ): Promise<ThreadOutboxDispatchResult> => {
      const serverConfig = appAtomRegistry.get(
        serverEnvironment.configValueAtom(queuedMessage.environmentId),
      );
      if (!serverConfig) return { outcome: "deferred" };
      const settings = resolveQueuedThreadSettings(queuedMessage, thread, serverConfig.providers);
      if (isModelSelectionUnavailable(serverConfig, settings.modelSelection)) {
        return restoreQueuedMessage(
          queuedMessage,
          "Antigravity model unavailable. Set it up on web or desktop, or choose another model.",
        );
      }
      const { reportFailure } = makeDeliveryHelpers(queuedMessage);

      if (!modelSelectionsEqual(settings.modelSelection, thread.modelSelection)) {
        const updateResult = await updateThreadMetadata({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "model-selection"),
            threadId: queuedMessage.threadId,
            modelSelection: settings.modelSelection,
          },
        });
        if (AsyncResult.isFailure(updateResult)) {
          reportFailure(updateResult, "settings-sync");
          return { outcome: "failed" };
        }
      }

      if (settings.branch !== thread.branch) {
        const updateResult = await updateThreadMetadata({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "branch"),
            threadId: queuedMessage.threadId,
            branch: settings.branch,
            worktreePath: null,
          },
        });
        if (AsyncResult.isFailure(updateResult)) {
          reportFailure(updateResult, "settings-sync");
          return { outcome: "failed" };
        }
      }

      if (settings.runtimeMode !== thread.runtimeMode) {
        const runtimeResult = await setThreadRuntimeMode({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "runtime-mode"),
            threadId: queuedMessage.threadId,
            runtimeMode: settings.runtimeMode,
            createdAt: queuedMessage.createdAt,
          },
        });
        if (AsyncResult.isFailure(runtimeResult)) {
          reportFailure(runtimeResult, "settings-sync");
          return { outcome: "failed" };
        }
      }

      if (settings.interactionMode !== thread.interactionMode) {
        const interactionResult = await setThreadInteractionMode({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "interaction-mode"),
            threadId: queuedMessage.threadId,
            interactionMode: settings.interactionMode,
            createdAt: queuedMessage.createdAt,
          },
        });
        if (AsyncResult.isFailure(interactionResult)) {
          reportFailure(interactionResult, "settings-sync");
          return { outcome: "failed" };
        }
      }

      let prepared: PreparedTurnAttachments;
      let persistedMessage: QueuedThreadMessage;
      let deliveryRevision: number;
      try {
        const preparedResult = await prepareQueuedMessageAttachments(
          queuedMessage,
          serverConfig.environment.capabilities.attachmentUploads === true,
        );
        if (preparedResult.status !== "ready") {
          return { outcome: preparedResult.status };
        }
        prepared = preparedResult.prepared;
        persistedMessage = preparedResult.persistedMessage;
        deliveryRevision = preparedResult.deliveryRevision;
        if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
          await preserveUploadedAttachmentsForEditor(
            queuedMessage,
            preparedResult.persistedMessage,
          );
          return { outcome: "deferred" };
        }
      } catch (error) {
        console.warn("[thread-outbox] failed to upload attachments", error);
        if (!shouldRetryThreadOutboxDelivery(error)) {
          return restoreQueuedMessage(
            queuedMessage,
            error instanceof Error ? error.message : "An attachment could not upload.",
          );
        }
        return { outcome: "failed" };
      }
      if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)) {
        return { outcome: "deferred" };
      }
      const currentConfig = appAtomRegistry.get(
        serverEnvironment.configValueAtom(queuedMessage.environmentId),
      );
      if (!currentConfig) return { outcome: "deferred" };
      if (isModelSelectionUnavailable(currentConfig, settings.modelSelection)) {
        return restoreQueuedMessage(
          persistedMessage,
          "Antigravity model unavailable. Set it up on web or desktop, or choose another model.",
        );
      }
      const sendSettings = resolveQueuedThreadSettings(
        queuedMessage,
        settings,
        currentConfig.providers,
      );
      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: queuedMessage.commandId,
          threadId: queuedMessage.threadId,
          message: {
            messageId: queuedMessage.messageId,
            role: "user",
            text: queuedMessage.text,
            attachments: prepared.attachments,
            ...(queuedMessage.inputOrigin !== undefined
              ? { inputOrigin: queuedMessage.inputOrigin }
              : {}),
          },
          modelSelection: sendSettings.modelSelection,
          runtimeMode: sendSettings.runtimeMode,
          interactionMode: sendSettings.interactionMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      const failure = reportFailure(deliveryResult, "start-turn");
      if (failure?.action === "retry") {
        return { outcome: "failed" };
      }
      if (failure?.action === "restore") {
        return restoreQueuedMessage(persistedMessage, failure.message);
      }
      noteThreadOutboxStartAccepted(persistedMessage, thread, context);
      acknowledgedMessageRevisionsRef.current.set(persistedMessage.messageId, deliveryRevision);
      acknowledgedPreparedAttachmentsRef.current.set(persistedMessage.messageId, prepared);
      const outcome = await completeQueuedMessageDelivery(persistedMessage, deliveryRevision);
      if (outcome === "failed") {
        return { outcome: "failed" };
      }
      if (outcome === "edited") {
        return { outcome: "deferred" };
      }

      acknowledgedMessageRevisionsRef.current.delete(persistedMessage.messageId);
      acknowledgedPreparedAttachmentsRef.current.delete(persistedMessage.messageId);
      if (thread.archivedAt != null) {
        refreshArchivedThreadsForEnvironment(persistedMessage.environmentId);
      }
      noteThreadSteerDispatch(persistedMessage, context);
      // The delivered turn holds its own copy of the bytes. A failed delete is
      // surfaced without failing the accepted turn; the server also expires
      // leaked pending uploads.
      await prepared.releaseUploads().catch((error) => {
        console.warn("[thread-outbox] could not delete consumed pending uploads", error);
      });
      return { outcome: "delivered", context };
    },
    [
      makeDeliveryHelpers,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      startTurn,
      updateThreadMetadata,
      restoreQueuedMessage,
    ],
  );

  const sendQueuedCreation = useCallback(
    async (
      queuedMessage: QueuedThreadMessage,
      creation: QueuedThreadCreation,
      projectCwd: string,
    ): Promise<ThreadOutboxDispatchResult> => {
      const modelSelection = queuedMessage.modelSelection;
      if (modelSelection === undefined) {
        return { outcome: "deferred" };
      }
      const serverConfig = appAtomRegistry.get(
        serverEnvironment.configValueAtom(queuedMessage.environmentId),
      );
      if (!serverConfig) return { outcome: "deferred" };
      const settings = resolveQueuedThreadSettings(
        queuedMessage,
        {
          modelSelection,
          branch: creation.branch,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        },
        serverConfig.providers,
      );
      if (isModelSelectionUnavailable(serverConfig, settings.modelSelection)) {
        return restoreQueuedMessage(
          queuedMessage,
          "Antigravity model unavailable. Set it up on web or desktop, or choose another model.",
        );
      }
      let prepared: PreparedTurnAttachments;
      let persistedMessage: QueuedThreadMessage;
      let deliveryRevision: number;
      try {
        const preparedResult = await prepareQueuedMessageAttachments(
          queuedMessage,
          serverConfig.environment.capabilities.attachmentUploads === true,
        );
        if (preparedResult.status !== "ready") {
          return { outcome: preparedResult.status };
        }
        prepared = preparedResult.prepared;
        persistedMessage = preparedResult.persistedMessage;
        deliveryRevision = preparedResult.deliveryRevision;
        if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
          await preserveUploadedAttachmentsForEditor(
            queuedMessage,
            preparedResult.persistedMessage,
          );
          return { outcome: "deferred" };
        }
      } catch (error) {
        console.warn("[thread-outbox] failed to upload attachments", error);
        if (!shouldRetryThreadOutboxDelivery(error)) {
          return restoreQueuedMessage(
            queuedMessage,
            error instanceof Error ? error.message : "An attachment could not upload.",
          );
        }
        return { outcome: "failed" };
      }
      if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)) {
        return { outcome: "deferred" };
      }
      const currentConfig = appAtomRegistry.get(
        serverEnvironment.configValueAtom(queuedMessage.environmentId),
      );
      if (!currentConfig) return { outcome: "deferred" };
      if (isModelSelectionUnavailable(currentConfig, settings.modelSelection)) {
        return restoreQueuedMessage(
          persistedMessage,
          "Antigravity model unavailable. Set it up on web or desktop, or choose another model.",
        );
      }
      const sendSettings = resolveQueuedThreadSettings(
        queuedMessage,
        settings,
        currentConfig.providers,
      );
      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: buildProjectThreadStartTurnInput({
          projectId: creation.projectId,
          projectCwd,
          threadId: queuedMessage.threadId,
          commandId: queuedMessage.commandId,
          messageId: queuedMessage.messageId,
          createdAt: queuedMessage.createdAt,
          text: queuedMessage.text.trim(),
          ...(queuedMessage.inputOrigin !== undefined
            ? { inputOrigin: queuedMessage.inputOrigin }
            : {}),
          attachments: queuedMessage.attachments,
          uploadedAttachments: prepared.attachments,
          modelSelection: sendSettings.modelSelection,
          runtimeMode: sendSettings.runtimeMode,
          interactionMode: sendSettings.interactionMode,
          workspaceMode: creation.workspaceMode,
          branch: creation.branch,
          worktreePath: creation.worktreePath,
          startFromOrigin: creation.startFromOrigin ?? false,
          worktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
        }),
      });
      const { reportFailure } = makeDeliveryHelpers(queuedMessage);
      const failure = reportFailure(deliveryResult, "start-turn");
      if (failure?.action === "retry") {
        return { outcome: "failed" };
      }
      if (failure?.action === "restore") {
        return restoreQueuedMessage(persistedMessage, failure.message);
      }
      acknowledgedMessageRevisionsRef.current.set(persistedMessage.messageId, deliveryRevision);
      acknowledgedPreparedAttachmentsRef.current.set(persistedMessage.messageId, prepared);
      const outcome = await completeQueuedMessageDelivery(persistedMessage, deliveryRevision);
      if (outcome === "failed") {
        return { outcome: "failed" };
      }
      if (outcome === "edited") {
        // The acknowledgement marker turns the next pass into cleanup-only. If
        // an editor saves a newer revision, that pass clears the marker and the
        // normal duplicate-creation recovery handles the edited payload.
        return { outcome: "deferred" };
      }

      acknowledgedMessageRevisionsRef.current.delete(persistedMessage.messageId);
      acknowledgedPreparedAttachmentsRef.current.delete(persistedMessage.messageId);
      await prepared.releaseUploads().catch((error) => {
        console.warn("[thread-outbox] could not delete consumed pending uploads", error);
      });
      return { outcome: "delivered", context: CREATION_DELIVERY_CONTEXT };
    },
    [makeDeliveryHelpers, restoreQueuedMessage, startTurn],
  );

  useEffect(() => {
    if (
      (outboxLoadState.status !== "ready" && !hydrationDegraded) ||
      dispatchingQueuedMessageId !== null
    ) {
      return;
    }

    const queuedMessageIds = new Set(
      Object.values(queuedMessagesByThreadKey)
        .flat()
        .map((message) => message.messageId),
    );
    for (const [messageId] of acknowledgedMessageRevisionsRef.current) {
      if (queuedMessageIds.has(messageId)) {
        continue;
      }
      acknowledgedMessageRevisionsRef.current.delete(messageId);
      const prepared = acknowledgedPreparedAttachmentsRef.current.get(messageId);
      acknowledgedPreparedAttachmentsRef.current.delete(messageId);
      void prepared?.releaseUploads().catch((error) => {
        console.warn("[thread-outbox] could not delete consumed pending uploads", error);
      });
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const acknowledgedMessage = queuedMessages.find((message) =>
        acknowledgedMessageRevisionsRef.current.has(message.messageId),
      );
      if (acknowledgedMessage !== undefined) {
        if (
          editingQueuedMessageIds[acknowledgedMessage.messageId] ||
          (retryNotBeforeRef.current.get(acknowledgedMessage.messageId) ?? 0) > Date.now()
        ) {
          continue;
        }
        beginDispatchingQueuedMessage(acknowledgedMessage.messageId, threadKey);
        void removeAcknowledgedExistingThreadMessage(
          acknowledgedMessage,
          acknowledgedMessageRevisionsRef.current,
        )
          .then(async (outcome) => {
            if (outcome === "failed") {
              scheduleQueuedMessageRetry(acknowledgedMessage.messageId);
              return;
            }
            if (outcome === "held") {
              return;
            }
            retryAttemptRef.current.delete(acknowledgedMessage.messageId);
            retryNotBeforeRef.current.delete(acknowledgedMessage.messageId);
            const pendingTimer = retryTimersRef.current.get(acknowledgedMessage.messageId);
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(acknowledgedMessage.messageId);
            }
            const prepared = acknowledgedPreparedAttachmentsRef.current.get(
              acknowledgedMessage.messageId,
            );
            acknowledgedPreparedAttachmentsRef.current.delete(acknowledgedMessage.messageId);
            await prepared?.releaseUploads().catch((error) => {
              console.warn("[thread-outbox] could not delete consumed pending uploads", error);
            });
          })
          .finally(() => finishDispatchingQueuedMessage(acknowledgedMessage.messageId));
        return;
      }

      const candidate = selectNextQueuedThreadDispatch(queuedMessages, {
        isHeld: (message) => {
          const blockedRecovery = blockedRecoverySubscriptionsRef.current.get(message.messageId);
          if (blockedRecovery !== undefined) {
            if (blockedRecovery.message === message) {
              return true;
            }
            blockedRecoverySubscriptionsRef.current.delete(message.messageId);
            blockedRecovery.unsubscribe();
          }
          return (
            Boolean(projectionHolds[threadKey]) ||
            isThreadOutboxMessageWaitingForPreferences(
              message,
              preferencesHydrated,
              Boolean(expeditedMessageIds[message.messageId]),
            ) ||
            Boolean(editingQueuedMessageIds[message.messageId]) ||
            isSteerWaitingOutGraceWindow(message, {
              nowMs: Date.now(),
              expedited: expeditedMessageIds,
              graceWindowMs: steerGraceWindowMs,
            }) ||
            (retryNotBeforeRef.current.get(message.messageId) ?? 0) > Date.now()
          );
        },
        resolveAction: (message) => {
          const thread = findThreadIncludingLoadedDetail(threads, message);
          const threadSettings = thread ?? message.threadSettings;
          if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
            return "wait";
          }
          const creation = message.creation;
          const environment = connectedEnvironments.find(
            (connected) => connected.environmentId === message.environmentId,
          );
          const shellStatus = shellStatuses.get(message.environmentId) ?? "empty";
          const action = resolveThreadOutboxDeliveryAction({
            isCreation: creation !== undefined,
            threadExists: threadSettings !== undefined,
            shellStatus,
            environmentConnected: environment?.connectionState === "connected",
            threadStatus: thread?.session?.status ?? null,
            // The turn this batch waited for has ended and its first message
            // started the next one, so the rest follow it in as steers rather
            // than each waiting out a whole turn. Resolving as a steer bypasses
            // only the running-turn hold — a disconnected environment or a
            // shell that is not live still waits.
            deliveryIntent: flushBatchRef.current.get(threadKey)?.has(message.messageId)
              ? "steer"
              : queuedThreadMessageIntent(message),
          });
          // An incomplete pending task (e.g. worktree mode without a branch)
          // stays queued until the user finishes it in the editor.
          if (action === "send" && creation !== undefined) {
            if (!isQueuedThreadCreationSendable(message)) {
              return "wait";
            }
            const creationProjectCwd =
              findCreationProject(projects, message)?.workspaceRoot ?? creation.projectCwd ?? null;
            if (creationProjectCwd === null && shellStatus !== "live") {
              return "wait";
            }
          }
          return action;
        },
      });
      if (candidate === null) {
        continue;
      }
      const nextQueuedMessage = candidate.message;
      const creation = nextQueuedMessage.creation;
      // The delivery action resolves first; capability checks apply only to
      // a message that will send. Checking earlier would restore a
      // creation whose startTurn already made the thread as a duplicate draft
      // instead of removing it.
      const serverConfig = serverConfigs.get(nextQueuedMessage.environmentId);
      const capabilities = serverConfig?.environment.capabilities;
      const dispatchStep = resolveThreadOutboxDispatchStep({
        deliveryAction: candidate.action,
        fileAttachments: nextQueuedMessage.attachments.filter(
          (attachment) => attachment.type === "file",
        ),
        serverConfig:
          serverConfig === undefined
            ? null
            : {
                maxFileUploadBytes:
                  capabilities?.attachmentUploads === true
                    ? capabilities.fileAttachments?.maxUploadBytes
                    : undefined,
              },
      });
      if (dispatchStep.step === "retry") {
        continue;
      }
      if (dispatchStep.step === "restore") {
        beginDispatchingQueuedMessage(nextQueuedMessage.messageId, threadKey);
        void confirmThreadOutboxMessageQueued(nextQueuedMessage)
          .then((queued): Promise<ThreadOutboxDispatchResult> | ThreadOutboxDispatchResult => {
            if (!queued) {
              return { outcome: "removed" };
            }
            if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[nextQueuedMessage.messageId]) {
              return { outcome: "deferred" };
            }
            return restoreQueuedMessage(nextQueuedMessage, dispatchStep.reason);
          })
          .then((result) => {
            if (result.outcome === "failed") {
              scheduleQueuedMessageRetry(nextQueuedMessage.messageId);
              return;
            }
            retryAttemptRef.current.delete(nextQueuedMessage.messageId);
            retryNotBeforeRef.current.delete(nextQueuedMessage.messageId);
            const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(nextQueuedMessage.messageId);
            }
          })
          .finally(() => finishDispatchingQueuedMessage(nextQueuedMessage.messageId));
        return;
      }
      // The live project shell is preferred for the workspace path, with the
      // snapshot taken at enqueue time as the fallback so a task never dies
      // just because its project shell is not loaded.
      const creationProjectCwd =
        creation !== undefined
          ? (findCreationProject(projects, nextQueuedMessage)?.workspaceRoot ??
            creation.projectCwd ??
            null)
          : null;

      beginDispatchingQueuedMessage(nextQueuedMessage.messageId, threadKey);
      const removeQueuedMessage = async (warning: string): Promise<ThreadOutboxDispatchResult> => {
        try {
          const removed = await removeThreadOutboxMessage(nextQueuedMessage);
          return { outcome: removed ? "removed" : "deferred" };
        } catch (error) {
          console.warn(warning, {
            environmentId: nextQueuedMessage.environmentId,
            threadId: nextQueuedMessage.threadId,
            messageId: nextQueuedMessage.messageId,
            error,
          });
          return { outcome: "failed" };
        }
      };
      // Enqueues publish optimistically before their durable write settles.
      // Confirm the write landed before sending, so a failed write cannot chase
      // an already-delivered turn.
      const dispatch: Promise<ThreadOutboxDispatchResult> = confirmThreadOutboxMessageQueued(
        nextQueuedMessage,
      ).then(async (queued): Promise<ThreadOutboxDispatchResult> => {
        if (!queued) {
          return { outcome: "removed" };
        }
        // Re-read mutable guards after confirmation before sending.
        if (
          appAtomRegistry.get(editingQueuedMessageIdsAtom)[nextQueuedMessage.messageId] ||
          appAtomRegistry.get(threadOutboxProjectionHoldsAtom)[threadKey]
        ) {
          return { outcome: "deferred" };
        }
        const freshThread = findThreadIncludingLoadedDetail(
          appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
          nextQueuedMessage,
        );
        const freshThreadSettings = freshThread ?? nextQueuedMessage.threadSettings;
        const environment = connectedEnvironments.find(
          (connected) => connected.environmentId === nextQueuedMessage.environmentId,
        );
        const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
        const freshAction = resolveThreadOutboxDeliveryAction({
          isCreation: creation !== undefined,
          threadExists: freshThreadSettings !== undefined,
          shellStatus,
          environmentConnected: environment?.connectionState === "connected",
          threadStatus: freshThread?.session?.status ?? null,
          deliveryIntent: flushBatchRef.current.get(threadKey)?.has(nextQueuedMessage.messageId)
            ? "steer"
            : queuedThreadMessageIntent(nextQueuedMessage),
        });
        if (freshAction !== candidate.action) {
          return { outcome: "deferred" };
        }
        if (candidate.action === "remove") {
          if (creation !== undefined) {
            const outcome = await recoverEditedCreationAfterDelivery(nextQueuedMessage);
            return { outcome };
          }
          return removeQueuedMessage(
            "[thread-outbox] failed to remove message for a missing thread",
          );
        }
        if (creation !== undefined) {
          return creationProjectCwd !== null
            ? sendQueuedCreation(nextQueuedMessage, creation, creationProjectCwd)
            : removeQueuedMessage("[thread-outbox] dropped pending task for a missing project");
        }
        if (freshThreadSettings === undefined) {
          return { outcome: "deferred" };
        }
        return sendQueuedMessage(nextQueuedMessage, freshThreadSettings, {
          sessionBaselineKnown: freshThread !== undefined,
          sessionStatus: freshThread?.session?.status ?? null,
          sessionUpdatedAt: freshThread?.session?.updatedAt ?? null,
          latestTurnId: freshThread?.latestTurn?.turnId ?? null,
        });
      });
      void dispatch
        .then((result) => {
          if (!flushBatchRef.current.has(threadKey)) {
            const batchIds = threadOutboxFlushBatchIds(queuedMessages, nextQueuedMessage, {
              result,
              action: candidate.action,
            });
            if (batchIds.size > 0) {
              flushBatchRef.current.set(threadKey, batchIds);
            }
          }
          if (result.outcome !== "failed") {
            retryAttemptRef.current.delete(nextQueuedMessage.messageId);
            retryNotBeforeRef.current.delete(nextQueuedMessage.messageId);
            const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(nextQueuedMessage.messageId);
            }
            return;
          }

          scheduleQueuedMessageRetry(nextQueuedMessage.messageId);
        })
        .finally(() => {
          finishDispatchingQueuedMessage(nextQueuedMessage.messageId);
        });
      return;
    }
  }, [
    connectedEnvironments,
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    expeditedMessageIds,
    hydrationDegraded,
    outboxLoadState,
    preferencesHydrated,
    projectionHolds,
    projects,
    queuedMessagesByThreadKey,
    retryTick,
    restoreQueuedMessage,
    scheduleQueuedMessageRetry,
    sendQueuedCreation,
    sendQueuedMessage,
    serverConfigs,
    shellStatuses,
    steerGraceWindowMs,
    threads,
  ]);
}
