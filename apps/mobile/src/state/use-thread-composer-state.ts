import type { ComposerTextPaste } from "../native/T3ComposerEditor.types";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
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
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  applyThreadStatusEmoji,
  parseComposerRenameCommand,
  parseComposerStatusCommand,
} from "@t3tools/shared/composerTrigger";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { composerContextSendBlockReason, reidentifyComposerContext } from "../lib/composerContext";
import { uuidv4 } from "../lib/uuid";

import type { ThreadHistoryWindowState } from "../features/threads/threadHistoryLoadMore";
import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import { isModelSelectionUnavailable } from "../lib/modelOptions";
import { resolveProviderInteractionMode } from "../features/threads/legacy-plan-mode";
import {
  convertPastedImagesToAttachments,
  createPastedTextComposerAttachment,
  pasteComposerClipboard,
  pickComposerFiles,
  pickComposerMedia,
  removePersistedComposerAttachmentFile,
} from "../lib/composerImages";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed } from "../lib/threadActivity";
import { acknowledgedThreadMessagesAtom } from "./acknowledged-thread-messages";
import { appendPendingThreadMessages } from "../features/threads/pending-thread-feed";
import { appAtomRegistry } from "../state/atom-registry";
import { pendingThreadCreationMessage } from "./pending-thread-creation";
import {
  appendComposerDraftAttachments,
  clearComposerDraftContentIfUnchanged,
  captureComposerDraftInsertion,
  countComposerDraftAttachmentsAfterSelection,
  insertComposerDraftText,
  insertComposerDraftContext,
  composerDraftsAtom,
  composerContextImportsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  scheduleUnusedComposerAttachmentCleanup,
  setComposerDraftText,
  useComposerDraft,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import type { ThreadOutboxDeliveryIntent } from "./thread-outbox-model";
import { useSteerPendingMessageIds } from "./thread-steer-pending";
import { threadEnvironment, useLoadOlderMessages, useThreadMessageWindow } from "./threads";
import { dispatchingQueuedMessageIdAtom } from "./use-thread-outbox-drain";
import { useAtomCommand } from "./use-atom-command";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
} from "./composer-attachment-uploads";
import { useThreadOutboxMessages } from "./use-thread-outbox";
import { isQueuedMessageEditTransferring } from "./use-thread-outbox-actions";
import {
  getStagedThreadSettings,
  pruneExpiredStagedThreadSettings,
  resolveStagedThreadSettings,
  stageThreadSettings,
  useStagedThreadSettings,
} from "./use-thread-staged-settings";

const EMPTY_THREAD_MESSAGES: ReadonlyArray<OrchestrationMessage> = [];
const EMPTY_THREAD_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];

/**
 * Overrides for a single send. Omitting `deliveryIntent` keeps the default:
 * steer into a busy turn, otherwise queue for the next one.
 */
export type SendMessageOptions = {
  readonly deliveryIntent?: ThreadOutboxDeliveryIntent;
};

/** Appends text and attachments to a thread's composer draft (review comments, queued-message edits). */
export function appendContentToThreadDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerAttachment>;
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
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const {
    selectedThread: selectedThreadShell,
    selectedThreadCreation,
    selectedEnvironmentRuntime,
  } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
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
  const stagedThreadSettings = useStagedThreadSettings(selectedThreadKey);
  const selectedThreadQueuedMessages = useMemo(
    () =>
      selectedThreadKey
        ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []).filter(
            (message) => message.creation === undefined,
          )
        : [],
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const messageWindow = useThreadMessageWindow(
    selectedThreadShell?.environmentId ?? null,
    selectedThreadShell?.id ?? null,
  );
  const loadOlderMessages = useLoadOlderMessages(
    selectedThreadShell?.environmentId ?? null,
    selectedThreadShell?.id ?? null,
  );
  const threadHistoryWindow = useMemo<ThreadHistoryWindowState>(
    () => ({
      hasOlderMessages: messageWindow.hasOlderMessages,
      loadingOlderMessages: messageWindow.loadingOlderMessages,
      settledCount: messageWindow.settledCount,
      error: messageWindow.error,
      onLoadOlderMessages: loadOlderMessages,
    }),
    [
      messageWindow.hasOlderMessages,
      messageWindow.loadingOlderMessages,
      messageWindow.settledCount,
      messageWindow.error,
      loadOlderMessages,
    ],
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
  const selectedThreadMessages = messageWindow.messages;
  const selectedThreadActivities = selectedThreadDetail?.activities;
  // A thread whose creation has not delivered its turn yet: the prompt only
  // exists in the outbox, so it is appended to whatever the server has. The
  // detail is usually present but empty during a worktree checkout, so this
  // cannot be an either/or with the loaded messages.
  const pendingCreationMessage = selectedThreadCreation?.message ?? null;
  const selectedThreadFeed = useMemo(() => {
    const loadedMessages = selectedThreadMessages;
    const feed =
      (selectedThreadMessages && selectedThreadActivities) || pendingCreationMessage !== null
        ? buildThreadFeed(
            { messages: loadedMessages, activities: selectedThreadActivities ?? [] },
            {
              loadedMessages,
              localMessages:
                pendingCreationMessage !== null &&
                !loadedMessages.some((message) => message.id === pendingCreationMessage.messageId)
                  ? [pendingThreadCreationMessage(pendingCreationMessage)]
                  : [],
            },
          )
        : [];
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
    selectedThreadActivities,
    selectedThreadMessages,
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

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  // Latch staged-override expiry: once the thread moves off a field's
  // baseline the entry is deleted, so a later return to the baseline value
  // cannot revive a pick the user is no longer looking at.
  useEffect(() => {
    if (selectedThreadKey && selectedThread) {
      pruneExpiredStagedThreadSettings(selectedThreadKey, selectedThread);
    }
  }, [selectedThread, selectedThreadKey]);
  const latestThreadRef = useRef(selectedThread);
  latestThreadRef.current = selectedThread;
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

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  // Steers dispatched into this turn that the agent has not read yet. Only the
  // Claude adapter can hold one for long, but the signal is provider-agnostic.
  const steerPendingMessageIds = useSteerPendingMessageIds(
    useMemo(
      () => ({
        sessionStatus: selectedThreadSessionActivity?.orchestrationStatus ?? null,
        latestTurn: selectedThreadDetail?.latestTurn ?? null,
        messages: selectedThreadDetail?.messages ?? EMPTY_THREAD_MESSAGES,
        activities: selectedThreadDetail?.activities ?? EMPTY_THREAD_ACTIVITIES,
      }),
      [selectedThreadDetail, selectedThreadSessionActivity],
    ),
  );
  const isCompacting = useMemo(() => {
    const queuedMessage = selectedThreadQueuedMessages.findLast(
      (message) =>
        message.messageId === dispatchingQueuedMessageId &&
        message.text.trim().toLowerCase() === "/compact" &&
        message.attachments.length === 0,
    );
    const latestCompactMessage = selectedThreadDetail?.messages.findLast(
      (message) =>
        message.role === "user" &&
        message.text.trim().toLowerCase() === "/compact" &&
        !message.attachments?.length,
    );
    const compactRequestIsActive =
      latestCompactMessage !== undefined &&
      (latestCompactMessage.createdAt >
        (selectedThread?.latestTurn?.requestedAt ?? latestCompactMessage.createdAt) ||
        (selectedThread?.latestTurn?.state === "running" &&
          latestCompactMessage.createdAt === selectedThread.latestTurn.requestedAt));
    const compactionSettled = selectedThreadDetail?.activities.some((activity) => {
      if (!["context-compaction", "provider.turn.start.failed"].includes(activity.kind)) {
        return false;
      }
      const payload =
        typeof activity.payload === "object" && activity.payload !== null
          ? (activity.payload as { readonly requestId?: unknown })
          : null;
      return payload?.requestId === latestCompactMessage?.id;
    });
    return (
      queuedMessage !== undefined ||
      ((selectedThread?.session?.status === "starting" ||
        selectedThread?.session?.status === "running") &&
        compactRequestIsActive &&
        !compactionSettled)
    );
  }, [
    dispatchingQueuedMessageId,
    selectedThread,
    selectedThreadDetail,
    selectedThreadQueuedMessages,
  ]);

  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell]);

  const onSendMessage = useCallback(
    async (options?: SendMessageOptions) => {
      if (!selectedThreadShell || selectedThreadCreation !== null) {
        return null;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      if (appAtomRegistry.get(composerContextImportsAtom)[threadKey]) {
        return null;
      }
      if (isQueuedMessageEditTransferring(threadKey)) {
        Alert.alert(
          "Queued message is still opening",
          "Wait for it to finish moving into the composer, then send.",
        );
        return null;
      }
      const draft = getComposerDraftSnapshot(threadKey);
      const thread = selectedThreadDetail ?? selectedThreadShell;
      pruneExpiredStagedThreadSettings(threadKey, thread);
      const stagedSettings = resolveStagedThreadSettings(
        getStagedThreadSettings(threadKey),
        thread,
      );
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
      ) {
        return null;
      }
      if (text.length === 0 && attachments.length === 0 && draft.context === undefined) {
        return null;
      }
      // A failed write restores attachments without truncating them, which can
      // leave a draft over the live send cap until the user removes the excess.
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

      // Pending creations are guarded above; slash commands require a server thread.
      const renameCommand = attachments.length === 0 ? parseComposerRenameCommand(text) : null;
      const statusCommand =
        attachments.length === 0 && !renameCommand ? parseComposerStatusCommand(text) : null;
      if (renameCommand || statusCommand) {
        if (renameCommand && renameCommand.title === null) {
          Alert.alert("Unable to rename thread", "Usage: /t3-name <title> or /t3-rename <title>");
          return null;
        }
        if (statusCommand && statusCommand.emoji === null) {
          Alert.alert("Unable to set thread status", "Usage: /t3-status <emoji>");
          return null;
        }

        const nextTitle = statusCommand?.emoji
          ? applyThreadStatusEmoji(selectedThreadShell.title, statusCommand.emoji)
          : (renameCommand?.title ?? selectedThreadShell.title);
        if (nextTitle !== selectedThreadShell.title) {
          const result = await updateThreadMetadata({
            environmentId: selectedThreadShell.environmentId,
            input: {
              threadId: selectedThreadShell.id,
              title: nextTitle,
            },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            const fallbackMessage = statusCommand
              ? "The thread status could not be updated."
              : "The thread could not be renamed.";
            Alert.alert(
              statusCommand ? "Unable to set thread status" : "Unable to rename thread",
              error instanceof Error ? error.message : fallbackMessage,
            );
          }
        }

        clearComposerDraftContentIfUnchanged(threadKey, draft);
        return null;
      }

      const serverConfig = selectedEnvironmentRuntime?.serverConfig;
      if (
        selectedEnvironmentRuntime?.connectionState === "connected" &&
        isModelSelectionUnavailable(serverConfig, stagedSettings.modelSelection)
      ) {
        Alert.alert(
          "Antigravity model unavailable",
          "Set up Antigravity on web or desktop, or choose another model.",
        );
        return null;
      }
      const provider = serverConfig?.providers.find(
        (entry) => entry.instanceId === stagedSettings.modelSelection.instanceId,
      );
      const feedbackCommand =
        attachments.length === 0 &&
        (provider?.driver === "codex" || thread.session?.providerName === "codex")
          ? parseCodexFeedbackCommand(text)
          : null;
      if (feedbackCommand) {
        if (thread.session === null) {
          Alert.alert("Start a Codex thread first", "Send a message before you submit feedback.");
          return null;
        }
        const feedbackMetadata = makeQueuedMessageMetadata();
        await submitCodexFeedback({
          submission: {
            id: MessageId.make(feedbackMetadata.messageId),
            command: text,
            createdAt: feedbackMetadata.createdAt,
          },
          clearDraft: () => clearComposerDraftContentIfUnchanged(threadKey, draft),
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
              environmentId: selectedThreadShell.environmentId,
              input: {
                threadId: selectedThreadShell.id,
                ...feedbackCommand,
              },
            }),
        });
        return null;
      }

      const metadata = makeQueuedMessageMetadata();
      const messageId = MessageId.make(metadata.messageId);
      // Shell metadata is authoritative. Detail and shell subscriptions are
      // independent, so a cached detail can briefly retain an older status.
      const sessionStatus = selectedThreadShell.session?.status ?? null;
      const threadIsBusy = sessionStatus === "running" || sessionStatus === "starting";
      // Enqueue publishes synchronously; clear immediately so the tap frame
      // reflects the queued send while durability settles in the background.
      const enqueuePromise = enqueueThreadOutboxMessage({
        environmentId: selectedThreadShell.environmentId,
        threadId: selectedThreadShell.id,
        messageId,
        commandId: CommandId.make(metadata.commandId),
        text,
        ...(draft.inputOrigin !== undefined ? { inputOrigin: draft.inputOrigin } : {}),
        context: draft.context,
        attachments,
        modelSelection: stagedSettings.modelSelection,
        runtimeMode: stagedSettings.runtimeMode,
        interactionMode: resolveProviderInteractionMode(provider, stagedSettings.interactionMode),
        threadSettings: {
          archivedAt: thread.archivedAt,
          modelSelection: thread.modelSelection,
          branch: thread.branch,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
        },
        deliveryIntent: options?.deliveryIntent ?? (threadIsBusy ? "steer" : "queue"),
        createdAt: metadata.createdAt,
      });
      clearComposerDraftContentIfUnchanged(threadKey, draft);
      enqueuePromise.then(
        () => {
          // The queued message owns the files now, so the deferred sweep keeps
          // them while releasing any superseded draft files.
          scheduleUnusedComposerAttachmentCleanup(attachments);
        },
        (error: unknown) => {
          // Preserve anything typed since this send while restoring content from
          // the failed write. The uncapped path cannot evict restored files.
          void mergeComposerDraftContent(threadKey, {
            text,
            ...(draft.inputOrigin !== undefined ? { inputOrigin: draft.inputOrigin } : {}),
            context: draft.context,
            attachments: [],
          });
          appendComposerDraftAttachments(threadKey, attachments, { allowOverflow: true });
          setPendingConnectionError(
            error instanceof Error ? error.message : "Failed to save the queued message.",
          );
        },
      );
      return messageId;
    },
    [
      selectedEnvironmentRuntime?.connectionState,
      selectedEnvironmentRuntime?.serverConfig,
      selectedThreadCreation,
      selectedThreadDetail,
      selectedThreadShell,
      updateThreadMetadata,
      uploadThreadFeedback,
    ],
  );

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onVoiceTranscript = useCallback(
    (text: string) => {
      if (!selectedThreadShell) return;
      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, text, "voice-transcription");
    },
    [selectedThreadShell],
  );

  const onPickDraftMedia = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
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

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
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

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
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

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
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

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
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

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
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
      const staged = resolveStagedThreadSettings(
        getStagedThreadSettings(selectedThreadKey),
        baseline,
      );
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === staged.modelSelection.instanceId,
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
    steerPendingMessageIds,
    threadHistoryWindow,
    selectedThreadQueueCount,
    selectedThreadQueuedMessages,
    dispatchingQueuedMessageId,
    activeWorkStartedAt,
    isCompacting,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    onChangeDraftMessage,
    onVoiceTranscript,
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
