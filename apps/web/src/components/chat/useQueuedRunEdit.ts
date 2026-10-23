import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatAttachment,
  type EnvironmentId,
  type MessageId,
  type OrchestrationMessageContext,
  type PreviewAnnotationPayload,
  type RunId,
  type ScopedThreadRef,
  type ThreadContextRecord,
  type ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useAssetUrls } from "../../assets/assetUrls";
import { prepareRevertedMessageAttachments } from "../ChatView.logic";
import {
  DraftId,
  composerTargetKey,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { buildMessageContext } from "../../lib/composerContextRecords";
import { readFileAsDataUrl } from "../../lib/imageCompression";
import { randomUUID } from "../../lib/utils";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { readPreparedConnection } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ChatComposerHandle } from "./ChatComposer";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { pendingDraftWork } from "./pendingDraftWork";
import {
  prepareQueuedEditAttachments,
  recoverQueuedMessageEdit,
  restoreQueuedEditAttachments,
} from "./queuedMessageEdit";
import type { EditQueuedRunRequest } from "./QueuedRunsControl";
import { useQueuedRunEditHold } from "./useQueuedRunEditHold";

interface EditingQueuedRun {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
  readonly originalAttachmentCount: number;
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}

/** What the composer holds when the user saves a queued-message edit. */
export interface QueuedRunEditContent {
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}

/** Draft id for editing a queued run of the route thread. */
function queuedEditDraftTarget(routeThreadRef: ScopedThreadRef, runId: RunId) {
  return DraftId.make(`queued-edit:${scopedThreadKey(routeThreadRef)}:${runId}`);
}

/** Uploads the edit's new attachments and saves it. Returns the error to show, or null. */
async function submitQueuedRunEdit(input: {
  readonly environmentId: EnvironmentId;
  readonly draftTarget: ComposerThreadTarget;
  readonly editing: EditingQueuedRun;
  readonly content: QueuedRunEditContent;
  readonly editQueuedRun: ReturnType<typeof useEditQueuedRunCommand>;
}): Promise<string | null> {
  const { environmentId, draftTarget, editing, content } = input;
  const editText = content.prompt.trim();
  const newAttachments = [...content.images, ...content.files];
  const uploadFiles = async (files: ReadonlyArray<ComposerFileAttachment>) => {
    const validateFiles = () => {
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
      const reason = fileAttachmentCapabilityBlockReason({
        files,
        attachmentUploadsCapabilityKnown: config !== null,
        supportsAttachmentUploads: config?.environment.capabilities.attachmentUploads === true,
        maxFileAttachmentBytes:
          config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
      });
      if (reason !== null) throw new Error(reason);
    };
    validateFiles();
    for (const file of files) startAttachmentUpload({ environmentId, image: file, draftTarget });
    await awaitAttachmentUploads(files.map((file) => file.id));
    validateFiles();
    const uploaded = getUploadedAttachments({ environmentId, images: files });
    if (uploaded === null) throw new Error("Retry or remove failed uploads before saving.");
    return uploaded;
  };
  try {
    const uploads = await prepareQueuedEditAttachments({
      existingAttachments: editing.existingAttachments,
      images: content.images,
      files: content.files,
      readImage: readFileAsDataUrl,
      uploadFiles,
    });
    // Kept records for removed attachments would point at nothing.
    const keptRecords = (editing.context?.records ?? []).filter(
      (record) =>
        !("attachmentId" in record) ||
        editing.existingAttachments.some((attachment) => attachment.id === record.attachmentId),
    );
    const newRecords =
      buildMessageContext({
        terminalContexts: content.terminalContexts.filter(
          (context) => context.text.trim().length > 0,
        ),
        reviewComments: content.reviewComments,
        previewAnnotations: content.previewAnnotations,
        threadContexts: content.threadContexts,
        attachments: newAttachments.map((attachment, index) => ({
          attachment,
          attachmentId: uploads[editing.existingAttachments.length + index]?.id ?? attachment.id,
        })),
      })?.records ?? [];
    const result = await input.editQueuedRun({
      environmentId,
      input: {
        threadId: editing.threadId,
        runId: editing.runId,
        text: editText.length === 0 ? ATTACHMENT_ONLY_BOOTSTRAP_PROMPT : editText,
        edit: {
          messageId: editing.messageId,
          attachments: uploads,
          // null = typed: clears a voice origin the edit removed.
          inputOrigin:
            useComposerDraftStore.getState().getComposerDraft(draftTarget)?.inputOrigin ?? null,
          context: {
            version: 1,
            records: [
              ...new Map(
                [...keptRecords, ...newRecords].map(
                  (record) => [record.contextId, record] as const,
                ),
              ).values(),
            ],
          },
        },
      },
    });
    return result._tag === "Failure" ? "Could not save the edited queued message." : null;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not save the edited queued message.";
  }
}

function useEditQueuedRunCommand() {
  return useAtomCommand(threadEnvironment.editQueuedRun, { reportFailure: false });
}

/**
 * Queued-message edit mode. While active, the composer is retargeted to a
 * per-run edit draft so the user's in-progress draft on the thread survives
 * untouched; `existingAttachments` tracks which stored attachments the edit
 * keeps (removal is client state until save).
 */
export function useQueuedRunEdit(input: {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly threadDraftTarget: ComposerThreadTarget;
  // Null while the route has no thread yet; an edit needs one to target.
  readonly activeThreadId: ThreadId | null;
  readonly serverProjection: ThreadStructure | null;
  readonly promptRef: { current: string };
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly createAssetUrl: Parameters<
    typeof prepareRevertedMessageAttachments
  >[0]["createAssetUrl"];
}) {
  const {
    environmentId,
    routeThreadRef,
    threadDraftTarget,
    activeThreadId,
    serverProjection,
    promptRef,
    composerRef,
    createAssetUrl,
  } = input;
  const routeThreadKey = scopedThreadKey(routeThreadRef);
  const editQueuedRunCommand = useEditQueuedRunCommand();
  const [editing, setEditing] = useState<EditingQueuedRun | null>(null);
  const saveInFlightRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  // Thread keys whose rescued edit is still moving attachments into the thread draft.
  const [rescueThreadKeys, setRescueThreadKeys] = useState<ReadonlyArray<string>>([]);
  // Sending now would leave the still-downloading attachments for the next draft.
  const rescueActive = rescueThreadKeys.includes(routeThreadKey);
  // An open, saving or rescuing edit owns composer content, so rewind and compaction wait.
  const transferActive = editing !== null || rescueActive;
  // Navigating to another thread ends the edit; its draft stays for later.
  if (editing !== null && activeThreadId !== editing.threadId) {
    setEditing(null);
  }
  const draftTarget =
    editing === null ? threadDraftTarget : queuedEditDraftTarget(routeThreadRef, editing.runId);

  const imageResources = (editing?.existingAttachments ?? [])
    .filter((attachment) => attachment.type === "image")
    .map((attachment) => ({ _tag: "attachment" as const, attachmentId: attachment.id }));
  const imageUrls = useAssetUrls(environmentId, imageResources);
  const urlByAttachmentId = new Map(
    imageResources.map((resource, index) => [resource.attachmentId, imageUrls[index] ?? null]),
  );
  const editingAttachments =
    editing === null
      ? null
      : editing.existingAttachments.map((attachment) => ({
          attachment,
          url: urlByAttachmentId.get(attachment.id) ?? null,
        }));

  const focusComposerSoon = () => {
    window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  };
  const clearEditDraft = (runId: RunId) =>
    useComposerDraftStore
      .getState()
      .clearComposerContent(queuedEditDraftTarget(routeThreadRef, runId));

  // Read at call time so a revert can recheck after an awaited confirmation.
  const isTransferActive = useStableCallback(() => transferActive);
  const beginEdit = useStableCallback((request: EditQueuedRunRequest) => {
    if (activeThreadId === null) return;
    const store = useComposerDraftStore.getState();
    // A rewind is about to replace the composer contents.
    if (store.rewindingThreadKeys.has(routeThreadKey)) return;
    if (editing !== null && editing.runId !== request.runId) clearEditDraft(editing.runId);
    const target = queuedEditDraftTarget(routeThreadRef, request.runId);
    const queuedMessage = serverProjection?.messages.find(
      (message) => message.id === request.messageId,
    );
    store.clearComposerContent(target);
    store.setPrompt(target, request.text, queuedMessage?.inputOrigin);
    setEditing({
      threadId: activeThreadId,
      runId: request.runId,
      messageId: request.messageId,
      originalText: request.text,
      originalAttachmentCount: request.attachments.length,
      existingAttachments: request.attachments,
      context: queuedMessage?.context,
    });
    focusComposerSoon();
  });
  const cancelEdit = useStableCallback(() => {
    if (editing === null) return;
    clearEditDraft(editing.runId);
    setEditing(null);
    focusComposerSoon();
  });
  const removeEditingAttachment = useStableCallback((attachmentId: string) => {
    setEditing((current) =>
      current === null
        ? current
        : {
            ...current,
            existingAttachments: current.existingAttachments.filter(
              (attachment) => attachment.id !== attachmentId,
            ),
          },
    );
  });

  // The server keeps the edited message from starting until the edit ends.
  useQueuedRunEditHold(environmentId, editing?.threadId ?? null, editing?.runId ?? null);

  // Exit edit mode when the edited run leaves the queue (cancelled from another
  // client, or started after its edit hold lapsed). A dirty edit is appended to
  // the thread's own draft with its attachments, contexts and model.
  useEffect(() => {
    if (editing === null || activeThreadId !== editing.threadId) return;
    if (serverProjection === null) return;
    const run = serverProjection.runs.find((candidate) => candidate.id === editing.runId);
    if (run !== undefined && run.status === "queued") return;
    const savedAttachmentLocalIds = new Map(
      editing.existingAttachments.map((attachment) => [attachment.id, randomUUID()]),
    );
    const recovery = recoverQueuedMessageEdit({
      editTarget: queuedEditDraftTarget(routeThreadRef, editing.runId),
      threadTarget: threadDraftTarget,
      originalText: editing.originalText,
      removedSavedAttachments: editing.existingAttachments.length < editing.originalAttachmentCount,
      ...(run === undefined ? {} : { modelSelection: run.modelSelection }),
      original: {
        context: editing.context,
        savedAttachmentLocalIds,
        threadId: editing.threadId,
        environmentId,
      },
    });
    // oxlint-disable-next-line react/set-state-in-effect -- Leaving edit mode follows the draft recovery above, which must run once after commit.
    setEditing(null);
    if (recovery.outcome === "clean") return;
    const reportRecovered = (skippedAttachmentCount: number) => {
      // The rescue keeps every attachment even past the per-message limit.
      const draft = useComposerDraftStore.getState().getComposerDraft(threadDraftTarget);
      const overLimit =
        (draft?.images.length ?? 0) + (draft?.files.length ?? 0) >
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
      const notes = [
        ...(skippedAttachmentCount === 0
          ? []
          : [
              `${skippedAttachmentCount} attachment${skippedAttachmentCount === 1 ? "" : "s"} could not be added.`,
            ]),
        ...(overLimit
          ? [
              `The composer is over the ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-attachment limit; remove some before sending.`,
            ]
          : []),
      ];
      toastManager.add(
        stackedThreadToast({
          type: notes.length === 0 ? "info" : "warning",
          title: "Queued message is no longer queued",
          description: ["Your unsaved edit was moved to the composer.", ...notes].join(" "),
        }),
      );
    };
    const savedAttachments = editing.existingAttachments;
    if (savedAttachments.length === 0) {
      reportRecovered(recovery.skippedAttachmentCount);
      return;
    }
    const connection = readPreparedConnection(environmentId);
    const rescueThreadKey = routeThreadKey;
    setRescueThreadKeys((keys) => [...keys, rescueThreadKey]);
    // Also blocks stashing, which would empty the draft the downloads land in.
    const rescueDraftKey = composerTargetKey(threadDraftTarget);
    pendingDraftWork.begin(rescueDraftKey);
    void restoreQueuedEditAttachments({
      attachments: savedAttachments,
      target: threadDraftTarget,
      localIds: savedAttachmentLocalIds,
      download: (attachments) => {
        if (!connection) return Promise.reject(new Error("The environment is not connected."));
        return prepareRevertedMessageAttachments({
          message: { attachments },
          environmentId,
          httpBaseUrl: connection.httpBaseUrl,
          createAssetUrl,
        });
      },
    })
      .then(
        (restored) =>
          reportRecovered(recovery.skippedAttachmentCount + restored.skippedAttachmentCount),
        () => reportRecovered(recovery.skippedAttachmentCount + savedAttachments.length),
      )
      .finally(() => {
        pendingDraftWork.end(rescueDraftKey);
        setRescueThreadKeys((keys) => {
          const index = keys.indexOf(rescueThreadKey);
          return index === -1 ? keys : keys.toSpliced(index, 1);
        });
      });
  }, [
    activeThreadId,
    createAssetUrl,
    editing,
    environmentId,
    routeThreadKey,
    routeThreadRef,
    serverProjection,
    threadDraftTarget,
  ]);

  /**
   * Saves the composer content into the queued message being edited. Reports
   * failures through `setThreadError`, which callers own because the error
   * banner lives with the thread.
   */
  const saveEdit = async (
    content: QueuedRunEditContent,
    setThreadError: (threadId: ThreadId, error: string | null) => void,
  ) => {
    if (editing === null || saveInFlightRef.current) return;
    const newAttachments = [...content.images, ...content.files];
    if (
      editing.existingAttachments.length + newAttachments.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      setThreadError(
        editing.threadId,
        `A message can have at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
      return;
    }
    if (
      content.prompt.trim().length === 0 &&
      editing.existingAttachments.length === 0 &&
      newAttachments.length === 0
    ) {
      return;
    }
    saveInFlightRef.current = true;
    setIsSaving(true);
    const error = await submitQueuedRunEdit({
      environmentId,
      draftTarget,
      editing,
      content,
      editQueuedRun: editQueuedRunCommand,
    });
    saveInFlightRef.current = false;
    setIsSaving(false);
    setThreadError(editing.threadId, error);
    if (error !== null) return;
    releaseDraftAttachments(newAttachments);
    promptRef.current = "";
    clearEditDraft(editing.runId);
    composerRef.current?.resetCursorState();
    setEditing(null);
    focusComposerSoon();
  };

  return {
    editingRunId: editing?.runId ?? null,
    isEditing: editing !== null,
    isSaving,
    rescueActive,
    transferActive,
    isTransferActive,
    draftTarget,
    editingAttachments,
    beginEdit,
    cancelEdit,
    removeEditingAttachment,
    saveEdit,
  };
}
