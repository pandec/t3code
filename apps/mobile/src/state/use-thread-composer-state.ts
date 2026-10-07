import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { readEnvironmentScope } from "./session";
import type { ComposerTextPaste } from "../native/T3ComposerEditor.types";
import { useAtomValue } from "@effect/atom-react";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import {
  deriveProviderSubagentStatus,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  threadRuntimeHasInterruptibleRun,
} from "@t3tools/client-runtime/state/thread-execution";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type EnvironmentId,
  type MessageInputOrigin,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { nextPastedTextFileName, pastedTextDisposition } from "@t3tools/client-runtime/text-paste";
import {
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { hasPendingArchive } from "@t3tools/client-runtime/state/thread-settled";
import { parseComposerArchiveCommand } from "@t3tools/shared/composerTrigger";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { composerContextSendBlockReason, reidentifyComposerContext } from "../lib/composerContext";
import { uuidv4 } from "../lib/uuid";
import { downloadServerAttachmentToDraft } from "../lib/composerContextClipboard";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import { isModelSelectionUnavailable } from "../lib/modelOptions";
import { resolveProviderInteractionMode } from "./legacy-plan-mode";
import {
  convertPastedImagesToAttachments,
  createPastedTextComposerAttachment,
  pasteComposerClipboard,
  pickComposerFiles,
  pickComposerMedia,
  removePersistedComposerAttachmentFile,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed } from "../lib/threadActivity";
import { acknowledgedThreadMessagesAtom } from "./acknowledged-thread-messages";
import { appendPendingThreadMessages } from "../features/threads/pending-thread-feed";
import { threadAllowsProviderSwitch } from "./thread-provider-switching";
import { appAtomRegistry } from "../state/atom-registry";
import { pendingThreadCreationMessage } from "./pending-thread-creation";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
} from "../state/composer-attachment-uploads";
import {
  appendComposerDraftAttachments,
  captureComposerDraftInsertion,
  countComposerDraftAttachmentsAfterSelection,
  insertComposerDraftText,
  insertComposerDraftContext,
  clearComposerDraftContent,
  composerDraftsAtom,
  composerContextImportsAtom,
  setComposerContextImporting,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  sameComposerDraftState,
  scheduleUnusedComposerAttachmentCleanup,
  setComposerDraftText,
  useComposerDraft,
} from "./use-composer-drafts";
import {
  getStagedThreadSettings,
  pruneExpiredStagedThreadSettings,
  resolveStagedThreadSettings,
  stageThreadSettings,
  useStagedThreadSettings,
} from "./use-thread-staged-settings";
import {
  resolveComposerDispatchMode,
  type ActiveTurnComposerAction,
} from "@t3tools/client-runtime/state/composer-dispatch";
import { Atom } from "effect/reactivity";
import { AsyncResult } from "effect/reactivity";
import { prepareTurnAttachments } from "../lib/attachmentUpload";
import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../lib/followUpBehavior";
import { mobilePreferencesAtom } from "./preferences";
import { environmentThreadDetails } from "./threads";
import {
  endQueuedRunEdit,
  getQueuedRunEdit,
  queuedEditDraftKey,
  queuedRunEditHasChanges,
  rebindQueuedEditContext,
  removeQueuedRunEditAttachment,
  resolveQueuedEditPayload,
  useQueuedRunEdit,
} from "./queued-run-edit";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { clearThreadComposerError, setThreadComposerError } from "./thread-composer-error";
import {
  useSelectedThreadProjection,
  useSelectedThreadVisibleTurnItems,
} from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import { dispatchingQueuedMessageIdAtom, useThreadOutboxMessages } from "./use-thread-outbox";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

const EMPTY_QUEUE_WORKFLOW_ATOM = Atom.make<null>(null).pipe(
  Atom.withLabel("mobile-thread-queue-workflow:empty"),
);

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const upgraded = upgradeLegacyContextMessage(input.text);
  if (
    !insertComposerDraftContext(
      threadKey,
      reidentifyComposerContext(upgraded.text, upgraded.records, uuidv4),
    )
  ) {
    Alert.alert("Too many context items", "Remove some context from the draft and try again.");
    return;
  }
  if (input.attachments && input.attachments.length > 0) {
    // Capped: a review comment is new content, not a send-failure restore, so
    // it must not push the draft over the send limit. Overflow is released.
    const rejectedCount = appendComposerDraftAttachments(threadKey, input.attachments, {
      appendReference: true,
    });
    if (rejectedCount > 0) {
      setPendingConnectionError(
        `${rejectedCount} comment attachment${rejectedCount === 1 ? " was" : "s were"} not added. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
    }
  }
}

/**
 * Which draft the composer is editing right now. While a queued message is
 * being edited the composer is pointed at that edit's own draft, so typing,
 * attaching, and pasting never touch the user's draft for the thread.
 * Resolved per call rather than captured, so a callback created before the
 * edit began still writes to the right place.
 */
function activeComposerDraftKey(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}): string {
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  const edit = getQueuedRunEdit(threadKey);
  return edit === null ? threadKey : queuedEditDraftKey(threadKey, edit.runId);
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

export function useThreadComposerState() {
  const {
    selectedThread: selectedThreadShell,
    selectedThreadCreation,
    selectedEnvironmentRuntime,
  } = useThreadSelection();
  const selectedThreadProjection = useSelectedThreadProjection();
  const selectedThreadVisibleTurnItems = useSelectedThreadVisibleTurnItems();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const acknowledgedMessages = useAtomValue(acknowledgedThreadMessagesAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const scheduleThreadArchive = useAtomCommand(threadEnvironment.scheduleArchive, {
    reportFailure: false,
  });
  const cancelThreadArchive = useAtomCommand(threadEnvironment.cancelArchive, {
    reportFailure: false,
  });
  const editQueuedRun = useAtomCommand(threadEnvironment.editQueuedRun, {
    label: "edit queued message",
    reportFailure: false,
  });
  const [isSavingQueuedEdit, setIsSavingQueuedEdit] = useState(false);
  const savingQueuedEditRef = useRef(false);
  const pastedTextFileNamesRef = useRef<{ threadKey: string | null; names: Set<string> }>({
    threadKey: null,
    names: new Set(),
  });
  const reservePastedTextFileName = useCallback(
    (threadKey: string, existingNames: ReadonlyArray<string>) => {
      if (pastedTextFileNamesRef.current.threadKey !== threadKey) {
        pastedTextFileNamesRef.current = { threadKey, names: new Set() };
      }
      const names = pastedTextFileNamesRef.current.names;
      for (const name of existingNames) names.add(name);
      const nextName = nextPastedTextFileName([...names]);
      names.add(nextName);
      return nextName;
    },
    [],
  );

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  // The creation entry is the thread itself (rendered as the first message),
  // not a follow-up waiting behind it.
  const selectedThreadQueuedMessages = useMemo(
    () =>
      selectedThreadKey
        ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []).filter(
            (message) => message.creation === undefined,
          )
        : [],
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const feedbackSubmissions = useMemo(
    () => (selectedThreadKey ? (feedbackSubmissionsByThreadKey[selectedThreadKey] ?? []) : []),
    [feedbackSubmissionsByThreadKey, selectedThreadKey],
  );
  const dismissFeedback = useCallback(
    (id: MessageId) => {
      if (!selectedThreadKey) return;
      setFeedbackSubmissionsByThreadKey((current) => ({
        ...current,
        [selectedThreadKey]: (current[selectedThreadKey] ?? []).filter((entry) => entry.id !== id),
      }));
    },
    [selectedThreadKey],
  );
  const selectedThreadMessages = selectedThreadProjection?.projection.messages;
  const selectedThreadAttempts = selectedThreadProjection?.projection.attempts;
  const selectedThreadNodes = selectedThreadProjection?.projection.nodes;
  // A thread whose creation has not delivered its turn yet: the prompt only
  // exists in the outbox, so it is appended to whatever the server has. The
  // detail is usually present but empty during a worktree checkout, so this
  // cannot be an either/or with the loaded messages.
  const pendingCreationMessage = selectedThreadCreation?.message ?? null;
  const selectedThreadFeed = useMemo(() => {
    const pendingCreation =
      pendingCreationMessage !== null &&
      !selectedThreadMessages?.some((message) => message.id === pendingCreationMessage.messageId)
        ? [pendingThreadCreationMessage(pendingCreationMessage)]
        : [];
    const feed = buildThreadFeed(selectedThreadVisibleTurnItems, {
      anchoredMessages: pendingCreation,
      attempts: selectedThreadAttempts,
      nodes: selectedThreadNodes,
    });
    const pendingAcknowledgments = acknowledgedMessages.filter(
      (message) =>
        scopedThreadKey(message.environmentId, message.threadId) === selectedThreadKey &&
        !selectedThreadQueuedMessages.some((queued) => queued.messageId === message.messageId),
    );
    if (pendingAcknowledgments.length === 0) return feed;
    return appendPendingThreadMessages(feed, feed, pendingAcknowledgments).map((entry) =>
      entry.pendingMessage ? { ...entry, acknowledged: true } : entry,
    );
  }, [
    selectedThreadMessages,
    selectedThreadAttempts,
    selectedThreadNodes,
    selectedThreadVisibleTurnItems,
    pendingCreationMessage,
    selectedThreadKey,
    selectedThreadQueuedMessages,
    acknowledgedMessages,
  ]);
  useEffect(() => {
    const echoedIds = new Set(selectedThreadMessages?.map((message) => message.id));
    if (acknowledgedMessages.some((message) => echoedIds.has(message.messageId))) {
      appAtomRegistry.set(
        acknowledgedThreadMessagesAtom,
        appAtomRegistry
          .get(acknowledgedThreadMessagesAtom)
          .filter((message) => !echoedIds.has(message.messageId)),
      );
    }
  }, [acknowledgedMessages, selectedThreadMessages]);

  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const followUpBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR)
    : DEFAULT_FOLLOW_UP_BEHAVIOR;
  // Steering needs a live provider turn the adapter can interrupt; the queue
  // workflow already derives that from the session's capabilities.
  const queueWorkflow = useAtomValue(
    selectedThreadShell === null
      ? EMPTY_QUEUE_WORKFLOW_ATOM
      : environmentThreadDetails.queueWorkflowAtom({
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
        }),
  );
  const canSteerActiveTurn = queueWorkflow?.canPromoteToSteer === true;
  const queuedRunEdit = useQueuedRunEdit(selectedThreadKey);
  const composerDraftKey =
    selectedThreadKey === null
      ? null
      : queuedRunEdit === null
        ? selectedThreadKey
        : queuedEditDraftKey(selectedThreadKey, queuedRunEdit.runId);
  // Content follows the composer's current draft; the model and mode pickers
  // stay bound to the thread, through its staged settings.
  const editedDraft = composerDraftKey ? composerDrafts[composerDraftKey] : null;
  const stagedThreadSettings = useStagedThreadSettings(selectedThreadKey);
  const draftMessage = editedDraft?.text ?? "";
  const draftAttachments = editedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadShell;
  // Fork: the pickers follow the thread's live settings. A pick is staged for
  // this session only and holds while the thread still has the value it was
  // made against; once the thread moves on, the pick expires for good, so a
  // later return to that value (another client, a plan follow-up) cannot
  // revive it. The ref gives the picker callbacks the thread to stage
  // against without changing their identity on every thread update.
  const latestThreadRef = useRef(selectedThread);
  useEffect(() => {
    latestThreadRef.current = selectedThread;
    if (selectedThreadKey && selectedThread) {
      pruneExpiredStagedThreadSettings(selectedThreadKey, selectedThread);
    }
  }, [selectedThread, selectedThreadKey]);
  const resolvedThreadSettings = selectedThread
    ? resolveStagedThreadSettings(stagedThreadSettings, selectedThread)
    : null;
  const modelSelection = resolvedThreadSettings?.modelSelection ?? null;
  const runtimeMode = resolvedThreadSettings?.runtimeMode ?? null;
  const selectedProvider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
    (provider) => provider.instanceId === modelSelection?.instanceId,
  );
  const interactionMode = resolvedThreadSettings
    ? resolveProviderInteractionMode(selectedProvider, resolvedThreadSettings.interactionMode)
    : null;
  // Whether the model picker may leave this thread's provider. Derived here
  // because the projection already drives this hook; the composer only needs
  // the answer, not a subscription to every projection update.
  const canSwitchThreadProvider = useMemo(
    () =>
      threadAllowsProviderSwitch({
        thread: selectedThreadShell,
        projection: selectedThreadProjection?.projection,
      }),
    [selectedThreadProjection, selectedThreadShell],
  );
  const selectedThreadRuntime = useMemo(
    () =>
      selectedThreadProjection
        ? deriveThreadRuntime(selectedThreadProjection.projection)
        : (selectedThreadShell?.runtime ?? null),
    [selectedThreadProjection, selectedThreadShell?.runtime],
  );
  const selectedThreadActivityRun = useMemo(
    () =>
      selectedThreadProjection
        ? deriveThreadActivityRun(selectedThreadProjection.projection)
        : (selectedThreadShell?.latestRun ?? null),
    [selectedThreadProjection, selectedThreadShell?.latestRun],
  );

  const isCompacting = useMemo(() => {
    const queuedCompact = selectedThreadQueuedMessages.some(
      (message) =>
        message.messageId === dispatchingQueuedMessageId &&
        message.text.trim().toLowerCase() === "/compact" &&
        message.attachments.length === 0,
    );
    if (queuedCompact) return true;
    const activeRunId = selectedThreadRuntime?.activeRunId;
    if (!activeRunId || !threadRuntimeIsActive(selectedThreadRuntime)) return false;
    const compactMessage = selectedThreadVisibleTurnItems.findLast(
      ({ item }) =>
        item.runId === activeRunId &&
        item.type === "user_message" &&
        item.text.trim().toLowerCase() === "/compact" &&
        item.attachments.length === 0,
    );
    if (!compactMessage) return false;
    return !selectedThreadVisibleTurnItems.some(
      ({ item }) =>
        item.runId === activeRunId &&
        item.type === "compaction" &&
        (item.status === "completed" || item.status === "failed"),
    );
  }, [
    dispatchingQueuedMessageId,
    selectedThreadQueuedMessages,
    selectedThreadRuntime,
    selectedThreadVisibleTurnItems,
  ]);

  const runlessWorkStartedAt = useMemo(
    () =>
      selectedThreadProjection
        ? deriveRunlessWorkStartedAt(selectedThreadProjection.projection)
        : null,
    [selectedThreadProjection],
  );
  const activeWorkStartedAt = useMemo(() => {
    if (!selectedThreadShell) {
      return null;
    }
    return (
      resolveThreadWorkingStartedAt({
        latestRun: selectedThreadActivityRun,
        runtime: selectedThreadRuntime,
      }) ?? runlessWorkStartedAt
    );
  }, [selectedThreadActivityRun, runlessWorkStartedAt, selectedThreadRuntime, selectedThreadShell]);
  const runlessWorkActive = runlessWorkStartedAt !== null;

  const providerSubagentStatus = useMemo(
    () =>
      selectedThreadProjection
        ? deriveProviderSubagentStatus(selectedThreadProjection.projection)
        : null,
    [selectedThreadProjection],
  );

  // The server holds a message while it is open here, but it can still be
  // removed from another client, or start once an abandoned hold lapses. Leave
  // edit mode rather than saving into a run the server will refuse, and append
  // an unsaved edit to the thread's draft with its attachments, context and
  // model instead of dropping it.
  const selectedThreadRuns = selectedThreadProjection?.projection.runs;
  const editedRunId = queuedRunEdit?.runId ?? null;
  useEffect(() => {
    if (selectedThreadKey === null || editedRunId === null || selectedThreadRuns === undefined) {
      return;
    }
    if (savingQueuedEditRef.current) return;
    const editedRun = selectedThreadRuns.find((run) => run.id === editedRunId);
    if (editedRun?.status === "queued") return;
    const edit = getQueuedRunEdit(selectedThreadKey);
    const editDraft = getComposerDraftSnapshot(queuedEditDraftKey(selectedThreadKey, editedRunId));
    const dirty = edit !== null && queuedRunEditHasChanges(edit, editDraft);
    endQueuedRunEdit(selectedThreadKey, { deferAttachmentCleanup: dirty });
    if (!dirty) return;
    const threadKey = selectedThreadKey;
    const environmentId = parseScopedThreadKey(threadKey)?.environmentId;
    // Saved attachments are downloaded back into the draft. Their ids are
    // chosen up front so the edit's chips bind to the copies; a failed
    // download takes its chip with it.
    const saved = environmentId === undefined ? [] : edit.existingAttachments;
    const savedLocalIds = new Map(saved.map((attachment) => [attachment.id, uuidv4()] as const));
    const context = rebindQueuedEditContext(editDraft.context, savedLocalIds);
    // Attachments may go past the per-message limit here (sending still
    // enforces it) so a rescue never drops one.
    const report = (failedCount: number) => {
      const overLimit =
        getComposerDraftSnapshot(threadKey).attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
      setThreadComposerError(
        threadKey,
        [
          failedCount === 0
            ? "That message is no longer queued. Your edit is back in the composer."
            : `That message is no longer queued. Your edit is back in the composer without ${failedCount} saved attachment${failedCount === 1 ? "" : "s"} that could not be downloaded.`,
          ...(overLimit
            ? [
                `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} before sending.`,
              ]
            : []),
        ].join(" "),
      );
    };
    const restoreSaved = async () => {
      appendComposerDraftAttachments(threadKey, editDraft.attachments, { allowOverflow: true });
      if (environmentId === undefined || saved.length === 0) return 0;
      const signal = new AbortController().signal;
      const results = await Promise.allSettled(
        saved.map((attachment) =>
          downloadServerAttachmentToDraft(
            {
              attachmentId: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              kind: attachment.type === "image" ? "image" : "file",
            },
            environmentId,
            signal,
            savedLocalIds.get(attachment.id),
          ),
        ),
      );
      const downloaded = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      appendComposerDraftAttachments(threadKey, downloaded, { allowOverflow: true });
      saved.forEach((attachment, index) => {
        const localId = savedLocalIds.get(attachment.id);
        if (results[index]?.status === "rejected" && localId !== undefined) {
          removeComposerDraftAttachment(threadKey, localId);
        }
      });
      return saved.length - downloaded.length;
    };
    // Sending before the downloads land would leave them for the next draft;
    // the import flag holds the send button and onSendMessage until then.
    const restoring = saved.length > 0;
    if (restoring) setComposerContextImporting(threadKey, true);
    void mergeComposerDraftContent(threadKey, {
      text: editDraft.text,
      attachments: [],
      ...(context ? { context } : {}),
      ...(editDraft.inputOrigin ? { inputOrigin: editDraft.inputOrigin } : {}),
    })
      .then(restoreSaved, restoreSaved)
      .then(report, () => report(saved.length))
      .finally(() => {
        if (restoring) setComposerContextImporting(threadKey, false);
      });
    const baseline = latestThreadRef.current;
    if (editedRun !== undefined && baseline) {
      stageThreadSettings(threadKey, { modelSelection: editedRun.modelSelection }, baseline);
    }
  }, [editedRunId, selectedThreadKey, selectedThreadRuns]);

  const activeThreadBusy = threadRuntimeIsActive(selectedThreadRuntime);
  const interruptibleRunId = threadRuntimeHasInterruptibleRun(selectedThreadRuntime)
    ? (selectedThreadRuntime?.activeRunId ?? null)
    : null;

  const cancelQueuedRunEdit = useCallback(() => {
    if (selectedThreadKey === null || savingQueuedEditRef.current) return;
    endQueuedRunEdit(selectedThreadKey);
  }, [selectedThreadKey]);

  const onRemoveQueuedEditAttachment = useCallback(
    (attachmentId: string) => {
      if (selectedThreadKey === null) return;
      removeQueuedRunEditAttachment(selectedThreadKey, attachmentId);
    },
    [selectedThreadKey],
  );

  const saveQueuedRunEdit = useCallback(async () => {
    const thread = selectedThreadShell;
    if (!thread || savingQueuedEditRef.current) return;
    const threadKey = scopedThreadKey(thread.environmentId, thread.id);
    const edit = getQueuedRunEdit(threadKey);
    if (edit === null) return;
    const draft = getComposerDraftSnapshot(queuedEditDraftKey(threadKey, edit.runId));
    const text = draft.text.trim();
    if (text.length === 0) {
      // The server rejects an empty queued message, attachments or not.
      Alert.alert("Add a message", "A queued message cannot be left empty.");
      return;
    }
    if (
      edit.existingAttachments.length + draft.attachments.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      Alert.alert(
        "Too many attachments",
        `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
      );
      return;
    }
    savingQueuedEditRef.current = true;
    setIsSavingQueuedEdit(true);
    try {
      const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
      const prepared = await prepareTurnAttachments({
        environmentId: thread.environmentId,
        attachments: draft.attachments,
        supportsImageUploads: capabilities?.attachmentUploads === true,
      });
      if (prepared.status !== "ready") return;
      const payload = resolveQueuedEditPayload({
        edit,
        draftContext: draft.context,
        draftAttachments: draft.attachments,
        uploaded: prepared.attachments,
      });
      const result = await editQueuedRun({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          runId: edit.runId,
          text,
          edit: {
            messageId: edit.messageId,
            attachments: payload.attachments,
            ...(payload.context ? { context: payload.context } : {}),
            // null = typed: clears a voice origin the edit removed.
            inputOrigin: draft.inputOrigin ?? null,
          },
        },
      });
      if (result._tag !== "Success") {
        Alert.alert(
          "Could not save the queued message",
          "It may have already started. Your edit is still in the composer.",
        );
        return;
      }
      endQueuedRunEdit(threadKey, { deferAttachmentCleanup: true });
      scheduleUnusedComposerAttachmentCleanup(draft.attachments);
    } finally {
      savingQueuedEditRef.current = false;
      setIsSavingQueuedEdit(false);
    }
  }, [editQueuedRun, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onSendMessage = useCallback(
    async (followUpOverride?: ActiveTurnComposerAction) => {
      if (
        selectedThreadShell &&
        selectedEnvironmentRuntime?.connectionState === "connected" &&
        !readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope)
      )
        return null;
      if (!selectedThreadShell) {
        return null;
      }
      // The server has not created this thread yet. Queuing a follow-up against
      // its id would strand the message: if the creation is rejected the thread
      // never appears and the drain drops the orphan. The composer disables its
      // send button too; this guard also covers the editor's submit key.
      if (selectedThreadCreation !== null) {
        return null;
      }

      // Editing a queued message repurposes the composer: the send button saves
      // the edit in place instead of enqueuing a new message.
      const editKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      if (getQueuedRunEdit(editKey) !== null) {
        await saveQueuedRunEdit();
        return null;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      const draft = getComposerDraftSnapshot(threadKey);
      if (appAtomRegistry.get(composerContextImportsAtom)[threadKey]) return null;
      const thread = selectedThreadShell;
      const text = draft.text.trim();
      const attachments = draft.attachments;
      if (
        composerAttachmentUploadBlockReason({
          environmentId: selectedThreadShell.environmentId,
          attachments,
          connected: selectedEnvironmentRuntime?.connectionState === "connected",
          serverConfig: selectedEnvironmentRuntime?.serverConfig ?? null,
          states: appAtomRegistry.get(composerAttachmentUploadsAtom),
        }) !== null
      )
        return null;
      if (text.length === 0 && attachments.length === 0) {
        return null;
      }
      // A send-failure restore appends with allowOverflow so it never drops the
      // user's files, which can leave the draft over the cap. Sending it anyway
      // would enqueue a message that outbox recovery rejects forever, so block
      // here until the user removes attachments.
      if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        Alert.alert(
          "Too many attachments",
          `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
        );
        return null;
      }

      const contextBlockReason = composerContextSendBlockReason(draft.context);
      if (contextBlockReason) {
        Alert.alert("Too much context", contextBlockReason);
        return null;
      }

      // Fork: `/t3-archive` archives now or when done; sent again, it cancels.
      // Attachments or context mean a real prompt, which goes to the provider.
      const archiveCommand =
        attachments.length === 0 && (draft.context?.records.length ?? 0) === 0
          ? parseComposerArchiveCommand(text)
          : null;
      if (archiveCommand) {
        if (archiveCommand.action === null) {
          Alert.alert(
            "Unable to archive thread",
            "Usage: /t3-archive (send again to cancel a pending archive)",
          );
          return null;
        }
        const environmentId = thread.environmentId;
        const input = { threadId: thread.id };
        const cancelArchive = archiveCommand.action === "cancel" || hasPendingArchive(thread);
        const result = await (cancelArchive
          ? cancelThreadArchive({ environmentId, input })
          : scheduleThreadArchive({ environmentId, input: { ...input, afterTurn: true } }));
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            Alert.alert(
              "Unable to update thread archive",
              error instanceof Error ? error.message : "An error occurred.",
            );
          }
          return null;
        }
        Alert.alert(
          cancelArchive ? "Archive cancelled" : "Archive requested",
          cancelArchive
            ? "This thread will stay open."
            : "Archives when the current turn and background work finish. Send /t3-archive again to cancel.",
        );
        // Clear only an unchanged draft: the user may have typed on meanwhile.
        if (sameComposerDraftState(getComposerDraftSnapshot(threadKey), draft)) {
          clearComposerDraftContent(threadKey);
        }
        return null;
      }

      pruneExpiredStagedThreadSettings(threadKey, thread);
      const threadSettings = resolveStagedThreadSettings(
        getStagedThreadSettings(threadKey),
        thread,
      );
      const modelSelection = threadSettings.modelSelection;
      const serverConfig = selectedEnvironmentRuntime?.serverConfig;
      if (
        selectedEnvironmentRuntime?.connectionState === "connected" &&
        isModelSelectionUnavailable(serverConfig, modelSelection)
      ) {
        Alert.alert(
          "Antigravity model unavailable",
          "Set up Antigravity on web or desktop, or choose another model.",
        );
        return null;
      }
      const provider = serverConfig?.providers.find(
        (entry) => entry.instanceId === modelSelection.instanceId,
      );
      const feedbackCommand =
        attachments.length === 0 && provider?.driver === "codex"
          ? parseCodexFeedbackCommand(text)
          : null;
      if (feedbackCommand) {
        if (!readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope))
          return null;
        if (thread.activeProviderThreadId === null) {
          Alert.alert("Start a Codex thread first", "Send a message before you submit feedback.");
          return null;
        }
        const metadata = makeQueuedMessageMetadata();
        await submitCodexFeedback({
          submission: {
            id: MessageId.make(metadata.messageId),
            command: text,
            createdAt: metadata.createdAt,
          },
          clearDraft: () => clearComposerDraftContent(threadKey),
          onUpdate: (submission) => {
            setFeedbackSubmissionsByThreadKey((current) => {
              const existing = current[threadKey] ?? [];
              const found = existing.some((entry) => entry.id === submission.id);
              return {
                ...current,
                [threadKey]: found
                  ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                  : [...existing, submission],
              };
            });
          },
          upload: () =>
            uploadThreadFeedback({
              environmentId: thread.environmentId,
              input: { threadId: thread.id, ...feedbackCommand },
            }),
        });
        return null;
      }

      // Resolved here rather than at drain time: the outbox can deliver minutes
      // later, and the choice belongs to the moment the user pressed send.
      // Steering travels as "auto" so a turn that ends in the meantime degrades
      // to a queued run on the server instead of failing the delivery and
      // bouncing the message back into the draft.
      const followUpAction = resolveComposerDispatchMode({
        running: activeThreadBusy && canSteerActiveTurn,
        alternateModifier: followUpOverride !== undefined && followUpOverride !== followUpBehavior,
        activeTurnDefault: followUpBehavior,
      });
      const followUpDispatchMode =
        followUpAction === "auto" ? null : followUpAction === "queue" ? "queue" : "auto";

      const metadata = makeQueuedMessageMetadata();
      const messageId = MessageId.make(metadata.messageId);
      // A new send supersedes the reason the previous one bounced back.
      clearThreadComposerError(threadKey);
      // Enqueue publishes the queued atom synchronously (the durable write
      // happens behind it), so clearing the draft here gives send feedback on
      // the tap frame instead of after file I/O. If the write fails the message
      // is rolled out of the queue and the content is merged back into the
      // draft, preserving anything typed since.
      const enqueuePromise = enqueueThreadOutboxMessage({
        environmentId: selectedThreadShell.environmentId,
        threadId: selectedThreadShell.id,
        messageId,
        commandId: CommandId.make(metadata.commandId),
        text,
        ...(draft.inputOrigin ? { inputOrigin: draft.inputOrigin } : {}),
        attachments,
        context: draft.context,
        modelSelection,
        runtimeMode: threadSettings.runtimeMode,
        interactionMode: resolveProviderInteractionMode(provider, threadSettings.interactionMode),
        ...(followUpDispatchMode === null ? {} : { dispatchMode: followUpDispatchMode }),
        createdAt: metadata.createdAt,
      });
      clearComposerDraftContent(threadKey, { deferAttachmentCleanup: true });
      enqueuePromise.then(
        () => scheduleUnusedComposerAttachmentCleanup(attachments),
        (error: unknown) => {
          // Restore text via merge (idempotent) but attachments via the uncapped
          // append: the merge path slots existing attachments first and truncates
          // at the send limit, which would silently drop this message's images if
          // the user attached new ones while the write was in flight.
          void mergeComposerDraftContent(threadKey, {
            text,
            ...(draft.inputOrigin ? { inputOrigin: draft.inputOrigin } : {}),
            context: draft.context,
            attachments: [],
          });
          appendComposerDraftAttachments(threadKey, attachments, { allowOverflow: true });
          setThreadComposerError(
            threadKey,
            error instanceof Error ? error.message : "Failed to save the queued message.",
          );
        },
      );
      return messageId;
    },
    [
      activeThreadBusy,
      canSteerActiveTurn,
      followUpBehavior,
      saveQueuedRunEdit,
      selectedEnvironmentRuntime?.connectionState,
      selectedEnvironmentRuntime?.serverConfig,
      selectedThreadCreation,
      selectedThreadShell,
      uploadThreadFeedback,
      scheduleThreadArchive,
      cancelThreadArchive,
    ],
  );

  const onChangeDraftMessage = useCallback(
    (value: string, inputOrigin?: MessageInputOrigin) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = activeComposerDraftKey(selectedThreadShell);
      setComposerDraftText(threadKey, value, inputOrigin);
    },
    [selectedThreadShell],
  );

  const onPickDraftMedia = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = activeComposerDraftKey(selectedThreadShell);
    const insertion = captureComposerDraftInsertion(threadKey);
    const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
    const result = await pickComposerMedia({
      existingCount: countComposerDraftAttachmentsAfterSelection(threadKey, insertion),
      maxVideoBytes:
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.attachments, {
      appendReference: true,
      insertion,
    });
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not attach photo or video", problems.join("\n\n"));
    }
  }, [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPickDraftFiles = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }
    const maxBytes =
      selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.fileAttachments
        ?.maxUploadBytes;
    if (maxBytes === undefined) {
      Alert.alert("Could not attach file", "This server does not support file attachments.");
      return;
    }

    const threadKey = activeComposerDraftKey(selectedThreadShell);
    const insertion = captureComposerDraftInsertion(threadKey);
    // pickComposerFiles clamps the advertised limit to the contract maximum.
    const result = await pickComposerFiles({
      existingCount: countComposerDraftAttachmentsAfterSelection(threadKey, insertion),
      maxBytes,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.files, {
      appendReference: true,
      insertion,
    });
    // The picker error and the live-cap rejection can both happen in one
    // pick; report both in a single alert.
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not attach file", problems.join("\n\n"));
    }
  }, [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = activeComposerDraftKey(selectedThreadShell);
    const insertion = captureComposerDraftInsertion(threadKey);
    const result = await pasteComposerClipboard({
      existingCount: countComposerDraftAttachmentsAfterSelection(threadKey, insertion),
    });
    const rejectedPasteCount = appendComposerDraftAttachments(threadKey, result.images, {
      appendReference: true,
      insertion,
    });
    if (result.text) {
      const currentDraft = getComposerDraftSnapshot(threadKey);
      const currentAttachments = currentDraft.attachments;
      const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
      const advertisedMax =
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined;
      const maxBytes =
        advertisedMax === undefined ? null : clampFileAttachmentUploadBytes(advertisedMax);
      const wouldExceedInputLimit =
        currentDraft.text.length -
          (currentDraft.text === insertion.text
            ? Math.max(0, insertion.end - insertion.start)
            : 0) +
          result.text.length >
        PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
      const shouldFold =
        pastedTextDisposition({
          text: result.text,
          wouldExceedInputLimit,
          canAttach: true,
        }) === "attachment";
      const canAttach =
        maxBytes !== null &&
        countComposerDraftAttachmentsAfterSelection(threadKey, insertion) <
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
        new TextEncoder().encode(result.text).byteLength <= maxBytes;
      if (shouldFold && canAttach && maxBytes !== null) {
        try {
          const attachment = await createPastedTextComposerAttachment({
            text: result.text,
            name: reservePastedTextFileName(
              threadKey,
              currentAttachments.map((item) => item.name),
            ),
            maxBytes,
          });
          // Same reference the pasted images above get: a folded paste is only visible
          // as its chip until the message is sent.
          if (
            appendComposerDraftAttachments(threadKey, [attachment], {
              appendReference: true,
              insertion,
            }) > 0
          ) {
            await removePersistedComposerAttachmentFile(attachment.fileUri);
            setPendingConnectionError(
              `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
            );
          }
        } catch (error) {
          setPendingConnectionError(
            error instanceof Error ? error.message : "Could not attach pasted text.",
          );
        }
      } else if (shouldFold && !wouldExceedInputLimit) {
        insertComposerDraftText(threadKey, result.text, insertion);
      } else if (shouldFold) {
        setPendingConnectionError(
          wouldExceedInputLimit
            ? "Pasted text is too large for this message. Remove some text or an attachment, then paste again."
            : "Could not attach pasted text. Remove an attachment or use a smaller paste, then try again.",
        );
      } else {
        insertComposerDraftText(threadKey, result.text, insertion);
      }
    }
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedPasteCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not paste", problems.join("\n\n"));
    }
  }, [
    composerDrafts,
    reservePastedTextFileName,
    selectedEnvironmentRuntime?.serverConfig,
    selectedThreadShell,
  ]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = activeComposerDraftKey(selectedThreadShell);
      const insertion = captureComposerDraftInsertion(threadKey);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: countComposerDraftAttachmentsAfterSelection(threadKey, insertion),
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images, { appendReference: true, insertion });
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onNativePasteText = useCallback(
    async (paste: ComposerTextPaste) => {
      if (!selectedThreadShell) return;
      const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
      const advertisedMax =
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined;
      if (advertisedMax === undefined) return;

      const threadKey = activeComposerDraftKey(selectedThreadShell);
      const insertion = { text: paste.value, ...paste.selection };
      const currentAttachments = getComposerDraftSnapshot(threadKey).attachments;
      try {
        const attachment = await createPastedTextComposerAttachment({
          text: paste.text,
          name: reservePastedTextFileName(
            threadKey,
            currentAttachments.map((item) => item.name),
          ),
          maxBytes: clampFileAttachmentUploadBytes(advertisedMax),
        });
        // The chip is how a folded paste stays visible: without it the attachment is in the
        // draft but nothing in the composer says so until the message is sent. Web folds
        // through its ordinary attach path, which always writes a reference; match that.
        const rejectedCount = appendComposerDraftAttachments(threadKey, [attachment], {
          appendReference: true,
          insertion,
        });
        if (rejectedCount > 0) {
          await removePersistedComposerAttachmentFile(attachment.fileUri);
          setPendingConnectionError(
            `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
          );
        }
      } catch (error) {
        setPendingConnectionError(
          error instanceof Error ? error.message : "Could not attach pasted text.",
        );
      }
    },
    [
      composerDrafts,
      reservePastedTextFileName,
      selectedEnvironmentRuntime?.serverConfig,
      selectedThreadShell,
    ],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = activeComposerDraftKey(selectedThreadShell);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      const baseline = latestThreadRef.current;
      if (!selectedThreadKey || !baseline) {
        return;
      }
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === value.instanceId,
      );
      stageThreadSettings(
        selectedThreadKey,
        {
          modelSelection: value,
          ...(provider?.showInteractionModeToggle === false
            ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
            : {}),
        },
        baseline,
      );
    },
    [selectedEnvironmentRuntime?.serverConfig, selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      const baseline = latestThreadRef.current;
      if (!selectedThreadKey || !baseline) {
        return;
      }
      stageThreadSettings(selectedThreadKey, { runtimeMode: value }, baseline);
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      const baseline = latestThreadRef.current;
      if (!selectedThreadKey || !baseline) {
        return;
      }
      const modelSelection = resolveStagedThreadSettings(
        getStagedThreadSettings(selectedThreadKey),
        baseline,
      ).modelSelection;
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === modelSelection.instanceId,
      );
      stageThreadSettings(
        selectedThreadKey,
        { interactionMode: resolveProviderInteractionMode(provider, value) },
        baseline,
      );
    },
    [selectedEnvironmentRuntime?.serverConfig, selectedThreadKey],
  );

  return {
    feedbackSubmissions,
    dismissFeedback,
    selectedThreadFeed,
    selectedThreadActivityRun,
    selectedThreadQueueCount,
    selectedThreadQueuedMessages,
    dispatchingQueuedMessageId,
    activeWorkStartedAt,
    runlessWorkActive,
    providerSubagentStatus,
    isCompacting,
    draftMessage,
    draftAttachments,
    composerDraftKey,
    followUpBehavior,
    canSteerActiveTurn,
    queuedRunEdit,
    isSavingQueuedEdit,
    cancelQueuedRunEdit,
    onRemoveQueuedEditAttachment,
    modelSelection,
    canSwitchThreadProvider,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    interruptibleRunId,
    onChangeDraftMessage,
    onPickDraftMedia,
    onPickDraftFiles,
    onPasteIntoDraft,
    onNativePasteImages,
    onNativePasteText,
    onRemoveDraftImage,
    onSendMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
