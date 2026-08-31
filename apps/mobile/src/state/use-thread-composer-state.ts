import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import * as Cause from "effect/Cause";

import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  codexFeedbackMessage,
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

import type { ThreadHistoryWindowState } from "../features/threads/threadHistoryLoadMore";
import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerFiles,
  pickComposerMedia,
} from "../lib/composerImages";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  appendedComposerDraftText,
  clearComposerDraftContentIfUnchanged,
  composerDraftsAtom,
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
import { useAtomCommand } from "./use-atom-command";
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
  if (input.text.length > 0) {
    const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
    setComposerDraftText(threadKey, appendedComposerDraftText(existing, input.text));
  }
  if (input.attachments && input.attachments.length > 0) {
    // Capped: a review comment is new content, not a send-failure restore, so
    // it must not push the draft over the send limit. Overflow is released.
    const rejectedCount = appendComposerDraftAttachments(threadKey, input.attachments);
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
  const { selectedThread: selectedThreadShell, selectedEnvironmentRuntime } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const stagedThreadSettings = useStagedThreadSettings(selectedThreadKey);
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  // A thread's detail snapshot can carry far more messages than the window
  // keeps hydrated for display. Build the feed from the window's messages so a
  // long history costs a bounded amount of feed-building work per stream tick,
  // and let the feed page older messages in as the user scrolls up.
  const messageWindow = useThreadMessageWindow(
    selectedThreadShell?.environmentId ?? null,
    selectedThreadShell?.id ?? null,
  );
  const loadOlderMessages = useLoadOlderMessages(
    selectedThreadShell?.environmentId ?? null,
    selectedThreadShell?.id ?? null,
  );
  const windowedMessages = messageWindow.messages;
  const selectedThreadFeed = useMemo(() => {
    if (!selectedThreadDetail) {
      return [];
    }
    const submissions = selectedThreadKey
      ? (feedbackSubmissionsByThreadKey[selectedThreadKey] ?? [])
      : [];
    return buildThreadFeed(selectedThreadDetail, {
      loadedMessages: windowedMessages,
      localMessages: submissions.flatMap((submission) =>
        submission.status === "interrupted"
          ? []
          : [codexFeedbackMessage(submission), codexFeedbackMessage(submission, "assistant")],
      ),
    });
  }, [feedbackSubmissionsByThreadKey, selectedThreadDetail, selectedThreadKey, windowedMessages]);
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

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  // Latch staged-override expiry: once the thread moves off a field's
  // baseline the entry is deleted, so a later return to the baseline value
  // (another client's pick, a plan follow-up flipping modes back) cannot
  // revive a pick the user is no longer looking at.
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
  const interactionMode = resolvedThreadSettings?.interactionMode ?? null;

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
    selectedThreadKey,
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
      if (!selectedThreadShell) {
        return null;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
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
      if (text.length === 0 && attachments.length === 0) {
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

      // Unlike web, no isServerThread guard is needed: this composer only
      // renders for an existing server-backed thread (new drafts use
      // NewTaskDraftScreen, which has no slash commands).
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

      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (entry) => entry.instanceId === thread.modelSelection.instanceId,
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
        const result = await submitCodexFeedback({
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
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) {
            return null;
          }
          const error = Cause.squash(result.cause);
          Alert.alert(
            "Could not send feedback to OpenAI",
            error instanceof Error ? error.message : "An error occurred.",
          );
          return null;
        }
        const feedbackId = result.value.feedbackId;
        Alert.alert("Feedback sent to OpenAI", `Thread ID: ${feedbackId}`, [
          { text: "OK", style: "cancel" },
          {
            text: "Copy ID",
            onPress: () => copyTextWithHaptic(feedbackId, { target: "Codex feedback thread ID" }),
          },
        ]);
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
        attachments,
        modelSelection: stagedSettings.modelSelection,
        runtimeMode: stagedSettings.runtimeMode,
        interactionMode: stagedSettings.interactionMode,
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
          void mergeComposerDraftContent(threadKey, { text, attachments: [] });
          appendComposerDraftAttachments(threadKey, attachments, { allowOverflow: true });
          setPendingConnectionError(
            error instanceof Error ? error.message : "Failed to save the queued message.",
          );
        },
      );
      return messageId;
    },
    [
      selectedEnvironmentRuntime?.serverConfig?.providers,
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
    const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
    const result = await pickComposerMedia({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
      maxVideoBytes:
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.attachments);
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
    // pickComposerFiles clamps the advertised limit to the contract maximum.
    const result = await pickComposerFiles({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
      maxBytes,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.files);
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
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    const rejectedPasteCount = appendComposerDraftAttachments(threadKey, result.images);
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
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
  }, [composerDrafts, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
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
      stageThreadSettings(selectedThreadKey, { modelSelection: value }, baseline);
    },
    [selectedThreadKey],
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
      stageThreadSettings(selectedThreadKey, { interactionMode: value }, baseline);
    },
    [selectedThreadKey],
  );

  return {
    selectedThreadFeed,
    steerPendingMessageIds,
    threadHistoryWindow,
    selectedThreadQueueCount,
    activeWorkStartedAt,
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
    onRemoveDraftImage,
    onSendMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
