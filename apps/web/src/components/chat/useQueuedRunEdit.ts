import { useAtomValue } from "@effect/atom-react";
import {
  makeQueuedRunEditStore,
  makeQueuedRunsAtom,
} from "@t3tools/client-runtime/queued-run-edit";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatAttachment,
  type EnvironmentContextRecord,
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
import { Atom } from "effect/reactivity";
import type { RefObject } from "react";
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
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
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

// Keyed by the route thread, so an edit survives navigating away and back.
const queuedRunEdits = makeQueuedRunEditStore<EditingQueuedRun>({
  registry: appAtomRegistry,
  label: "web-queued-run-edits",
});

// Thread keys whose rescued edit is still moving attachments into the thread draft.
const rescuingQueuedRunEdits = Atom.make<ReadonlyArray<string>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-queued-run-edit-rescues"),
);

function setQueuedRunEditRescuing(threadKey: string, rescuing: boolean) {
  const keys = appAtomRegistry.get(rescuingQueuedRunEdits);
  if (rescuing) {
    appAtomRegistry.set(rescuingQueuedRunEdits, [...keys, threadKey]);
    return;
  }
  const index = keys.indexOf(threadKey);
  if (index !== -1) appAtomRegistry.set(rescuingQueuedRunEdits, keys.toSpliced(index, 1));
}

/**
 * The edited run left the queue (cancelled from another client, or started
 * after its edit hold lapsed). A dirty edit is appended to the thread's own
 * draft with its attachments, contexts and model.
 */
function rescueQueuedRunEdit(input: {
  readonly edit: EditingQueuedRun;
  readonly editKey: string;
  readonly environmentId: EnvironmentId;
  readonly editTarget: ComposerThreadTarget;
  readonly threadDraftTarget: ComposerThreadTarget;
  readonly createAssetUrl: Parameters<
    typeof prepareRevertedMessageAttachments
  >[0]["createAssetUrl"];
}) {
  const { edit, environmentId, threadDraftTarget } = input;
  const threadRef = { environmentId, threadId: edit.threadId };
  const run = appAtomRegistry
    .get(environmentThreadDetails.quietThreadAtom(threadRef))
    ?.projection.runs.find((candidate) => candidate.id === edit.runId);
  const savedAttachmentLocalIds = new Map(
    edit.existingAttachments.map((attachment) => [attachment.id, randomUUID()]),
  );
  const recovery = recoverQueuedMessageEdit({
    editTarget: input.editTarget,
    threadTarget: threadDraftTarget,
    originalText: edit.originalText,
    removedSavedAttachments: edit.existingAttachments.length < edit.originalAttachmentCount,
    ...(run === undefined ? {} : { modelSelection: run.modelSelection }),
    original: {
      context: edit.context,
      savedAttachmentLocalIds,
      threadId: edit.threadId,
      environmentId,
    },
  });
  if (recovery.outcome === "clean") return;
  // Edits outlive navigation, so the toast names the thread: the user may be anywhere by now.
  const title = appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef))?.title;
  const where = title === undefined ? "" : ` in “${title}”`;
  const reportRecovered = (skippedAttachmentCount: number) => {
    // The rescue keeps every attachment even past the per-message limit.
    const draft = useComposerDraftStore.getState().getComposerDraft(threadDraftTarget);
    const overLimit =
      (draft?.images.length ?? 0) + (draft?.files.length ?? 0) > PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
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
        description: [`Your unsaved edit${where} was moved to the composer.`, ...notes].join(" "),
      }),
    );
  };
  const savedAttachments = edit.existingAttachments;
  if (savedAttachments.length === 0) {
    reportRecovered(recovery.skippedAttachmentCount);
    return;
  }
  const connection = readPreparedConnection(environmentId);
  setQueuedRunEditRescuing(input.editKey, true);
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
        createAssetUrl: input.createAssetUrl,
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
      setQueuedRunEditRescuing(input.editKey, false);
    });
}

interface QueuedRunEditContent {
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly environmentContexts: ReadonlyArray<EnvironmentContextRecord>;
}

function queuedEditDraftTarget(routeThreadRef: ScopedThreadRef, runId: RunId) {
  return DraftId.make(`queued-edit:${scopedThreadKey(routeThreadRef)}:${runId}`);
}

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
        supportsAttachmentUploads: config !== null,
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
        environmentContexts: content.environmentContexts,
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

/** Edits preserve the thread draft; attachment removals stay local until save. */
export function useQueuedRunEdit(input: {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly threadDraftTarget: ComposerThreadTarget;
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
  const editQueuedRunCommand = useEditQueuedRunCommand();
  const editKey = scopedThreadKey(routeThreadRef);
  const storedEdit = useAtomValue(queuedRunEdits.atom)[editKey] ?? null;
  const editing = activeThreadId === null ? null : storedEdit;
  const isSaving = useAtomValue(queuedRunEdits.savingAtom)[editKey] === true;
  // Sending now would leave the still-downloading attachments for the next draft.
  const rescueActive = useAtomValue(rescuingQueuedRunEdits).includes(editKey);
  // An open, saving or rescuing edit owns composer content, so rewind and compaction wait.
  const transferActive = editing !== null || rescueActive;
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
    if (store.rewindingThreadKeys.has(editKey)) return;
    if (editing !== null && editing.runId !== request.runId) clearEditDraft(editing.runId);
    const target = queuedEditDraftTarget(routeThreadRef, request.runId);
    const queuedMessage = serverProjection?.messages.find(
      (message) => message.id === request.messageId,
    );
    store.clearComposerContent(target);
    store.setPrompt(target, request.text, queuedMessage?.inputOrigin);
    const threadRef = { environmentId, threadId: activeThreadId };
    queuedRunEdits.begin(
      editKey,
      {
        threadId: activeThreadId,
        runId: request.runId,
        messageId: request.messageId,
        originalText: request.text,
        originalAttachmentCount: request.attachments.length,
        existingAttachments: request.attachments,
        context: queuedMessage?.context,
      },
      {
        runs: makeQueuedRunsAtom({
          threadId: activeThreadId,
          snapshot: threadEnvironment.snapshotAtom(environmentId),
          detailStatus: environmentThreadDetails.statusAtom(threadRef),
          runs: Atom.make(
            (get) =>
              get(environmentThreadDetails.quietThreadAtom(threadRef))?.projection.runs ?? null,
          ),
        }),
        onRunLeftQueue: (_, edit) =>
          rescueQueuedRunEdit({
            edit,
            editKey,
            environmentId,
            editTarget: queuedEditDraftTarget(routeThreadRef, edit.runId),
            threadDraftTarget,
            createAssetUrl,
          }),
      },
    );
    focusComposerSoon();
  });
  const cancelEdit = useStableCallback(() => {
    if (editing === null) return;
    clearEditDraft(editing.runId);
    queuedRunEdits.end(editKey);
    focusComposerSoon();
  });
  const removeEditingAttachment = useStableCallback((attachmentId: string) => {
    queuedRunEdits.update(editKey, (current) => ({
      ...current,
      existingAttachments: current.existingAttachments.filter(
        (attachment) => attachment.id !== attachmentId,
      ),
    }));
  });

  // The server keeps the edited message from starting until the edit ends.
  useQueuedRunEditHold(environmentId, editing?.threadId ?? null, editing?.runId ?? null);

  const saveEdit = async (
    content: QueuedRunEditContent,
    setThreadError: (threadId: ThreadId, error: string | null) => void,
  ) => {
    if (editing === null || isSaving) return;
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
    // The save's result decides the edit's fate, even if the run starts meanwhile.
    const finishSave = queuedRunEdits.startSave(editKey);
    if (finishSave === null) return;
    const error = await submitQueuedRunEdit({
      environmentId,
      draftTarget,
      editing,
      content,
      editQueuedRun: editQueuedRunCommand,
    });
    setThreadError(editing.threadId, error);
    const current = finishSave(error === null);
    if (error !== null) return;
    releaseDraftAttachments(newAttachments);
    // The edit was cancelled or begun again while this save ran; its drafts are the newer edit's.
    if (!current) return;
    promptRef.current = "";
    clearEditDraft(editing.runId);
    composerRef.current?.resetCursorState();
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
