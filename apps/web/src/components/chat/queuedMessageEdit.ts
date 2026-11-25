import type {
  ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  ComposerContextId,
  ComposerContextRecord,
  EnvironmentId,
  ModelSelection,
  OrchestrationMessageContext,
  ThreadId,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import {
  composerDraftHasUserContent,
  composerFileDedupKey,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { msg } from "gt-react";
import { m } from "../../i18n/messages";
import { randomUUID } from "~/lib/utils";
import { applyMessageContextRestore, planMessageContextRestore } from "./messageContextRestore";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";
import {
  attachmentContextRecord,
  isSameComposerContextPayload,
} from "../../lib/composerContextRecords";

export function isQueuedImageAttachment(
  attachment: ChatAttachment,
): attachment is ChatImageAttachment {
  return attachment.type === "image";
}

export function isQueuedFileAttachment(
  attachment: ChatAttachment,
): attachment is ChatFileAttachment {
  return attachment.type === "file";
}

export function attachmentContextIdsForRecord(
  context: OrchestrationMessageContext | undefined,
  attachment: Pick<ChatAttachment, "id" | "type">,
): ComposerContextId[] {
  return (context?.records ?? []).flatMap((record) =>
    record.kind === attachment.type &&
    "attachmentId" in record &&
    record.attachmentId === attachment.id
      ? [record.contextId]
      : [],
  );
}

export function matchRestorableQueuedAttachment(input: {
  readonly environmentId: EnvironmentId;
  readonly sourceEnvironmentId: EnvironmentId | null;
  readonly record: Extract<ComposerContextRecord, { kind: "image" | "file" }>;
  readonly removedQueuedAttachments: ReadonlyArray<{
    readonly attachment: ChatAttachment;
    readonly contextIds: ReadonlyArray<ComposerContextId>;
  }>;
}): { readonly attachment: ChatAttachment; readonly contextId: ComposerContextId } | null {
  if (input.sourceEnvironmentId !== input.environmentId) return null;
  const match = input.removedQueuedAttachments.find(
    ({ attachment, contextIds }) =>
      (isQueuedImageAttachment(attachment) || isQueuedFileAttachment(attachment)) &&
      attachment.type === input.record.kind &&
      contextIds.some((contextId) =>
        isSameComposerContextPayload(
          attachmentContextRecord({
            attachment,
            attachmentId: attachment.id,
            contextId,
          }),
          input.record,
        ),
      ),
  );
  if (!match || match.contextIds.length === 0) return null;
  const contextId =
    match.contextIds.find((candidate) => candidate === input.record.contextId) ??
    match.contextIds[0]!;
  return { attachment: match.attachment, contextId };
}

/** Staged attachments upload as soon as they are added, so a dropped edit must release them. */
export function discardQueuedEditDraft(target: ComposerThreadTarget): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  if (draft) {
    releaseDraftAttachments([...draft.images, ...draft.files]);
    for (const image of draft.images) {
      if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
    }
  }
  store.clearComposerContent(target);
  store.clearDraftThread(target);
}

/**
 * Keep an unsaved edit when its queued run leaves the queue by appending it to
 * the thread's draft, even when that draft has content. Saved attachments must
 * be downloaded, so restoreQueuedEditAttachments restores them separately with
 * the same `savedAttachmentLocalIds`.
 */
export function recoverQueuedMessageEdit(input: {
  readonly editTarget: ComposerThreadTarget;
  readonly threadTarget: ComposerThreadTarget;
  readonly originalText: string;
  readonly originalReplyContextId?: ComposerContextId | undefined;
  /** True when the edit dropped one of the message's saved attachments. */
  readonly removedSavedAttachments?: boolean;
  /** The queued message's model, staged so a resend uses it. */
  readonly modelSelection?: ModelSelection;
  /** The model the edit opened with; a different pick in the edit draft wins. */
  readonly originalModelSelection?: ModelSelection;
  /** The queued message's own context, which the edit's original chips still point at. */
  readonly original?: {
    readonly context: OrchestrationMessageContext | undefined;
    /** Saved attachment id to the draft id its downloaded copy will get. */
    readonly savedAttachmentLocalIds: ReadonlyMap<string, string>;
    readonly threadId: ThreadId;
    readonly environmentId: EnvironmentId;
  };
}): { readonly outcome: "kept" | "clean"; readonly skippedAttachmentCount: number } {
  const store = useComposerDraftStore.getState();
  const edit = store.getComposerDraft(input.editTarget);
  const editModelSelection = edit?.activeProvider
    ? edit.modelSelectionByProvider[edit.activeProvider]
    : undefined;
  const modelChanged =
    editModelSelection !== undefined &&
    !Equal.equals(editModelSelection, input.originalModelSelection);
  const dirty =
    edit !== null &&
    (edit.prompt !== input.originalText ||
      edit.replyTo?.contextId !== input.originalReplyContextId ||
      edit.images.length > 0 ||
      edit.files.length > 0 ||
      edit.terminalContexts.length > 0 ||
      edit.previewAnnotations.length > 0 ||
      edit.reviewComments.length > 0 ||
      modelChanged ||
      input.removedSavedAttachments === true);
  // An edit emptied to nothing has nothing to append, so it leaves like an unchanged one.
  const hasContent =
    composerDraftHasUserContent(edit) || (input.original?.savedAttachmentLocalIds.size ?? 0) > 0;
  if (edit === null || !dirty || !hasContent) {
    discardQueuedEditDraft(input.editTarget);
    return { outcome: "clean", skippedAttachmentCount: 0 };
  }
  const destination = store.getComposerDraft(input.threadTarget);
  const restoredContext =
    input.original === undefined
      ? null
      : planMessageContextRestore({
          text: edit.prompt,
          records: input.original.context?.records ?? [],
          threadId: input.original.threadId,
          environmentId: input.original.environmentId,
          attachmentLocalIds: input.original.savedAttachmentLocalIds,
          existingTerminalContexts: [
            ...(destination?.terminalContexts ?? []),
            ...edit.terminalContexts,
          ],
        });
  // A draft holds one reply: the thread draft's wins, and a different one from the edit
  // stays as a quote of that response.
  const destinationReply = destination?.replyTo ?? null;
  const replyQuote =
    edit.replyTo !== null &&
    destinationReply !== null &&
    destinationReply.contextId !== edit.replyTo.contextId
      ? serializeAssistantCitation(edit.replyTo.citation)
      : "";
  const editText = [replyQuote, restoredContext?.text ?? edit.prompt]
    .filter((part) => part.trim().length > 0)
    .join(" ");
  const prompt = [destination?.prompt ?? "", editText]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  // Attachments may exceed the per-message limit here (sending still enforces
  // it); inline references stay valid because their contexts move too. The
  // merged prompt keeps voice provenance from either side.
  const inputOrigin = edit.inputOrigin ?? destination?.inputOrigin;
  store.moveComposerPromptAndImages(input.editTarget, input.threadTarget, { allowOverflow: true });
  store.setPrompt(input.threadTarget, prompt, inputOrigin);
  if (edit.replyTo !== null && destinationReply === null) {
    store.setReplyTo(input.threadTarget, edit.replyTo);
  }
  if (edit.terminalContexts.length > 0) {
    store.addTerminalContexts(input.threadTarget, [...edit.terminalContexts], {
      appendReference: false,
    });
  }
  if (edit.previewAnnotations.length > 0) {
    store.setPreviewAnnotations(input.threadTarget, [
      ...(destination?.previewAnnotations ?? []),
      ...edit.previewAnnotations,
    ]);
  }
  if (edit.reviewComments.length > 0) {
    store.setReviewComments(input.threadTarget, [
      ...(destination?.reviewComments ?? []),
      ...edit.reviewComments,
    ]);
  }
  if (edit.threadContexts.length > 0) {
    store.addThreadContexts(input.threadTarget, edit.threadContexts, { appendReference: false });
  }
  if (edit.environmentContexts.length > 0) {
    store.addEnvironmentContexts(input.threadTarget, edit.environmentContexts, {
      appendReference: false,
    });
  }
  if (restoredContext !== null) applyMessageContextRestore(input.threadTarget, restoredContext);
  if (modelChanged) {
    store.setModelSelection(input.threadTarget, editModelSelection, {
      explicit: true,
      replaceOptions: true,
    });
  } else if (input.modelSelection !== undefined) {
    store.setModelSelection(input.threadTarget, input.modelSelection, { replaceOptions: true });
  }
  // Files the thread draft already holds stay behind as duplicates; anything
  // else left is reported.
  const leftover = store.getComposerDraft(input.editTarget);
  const destinationFileIds = new Set(destination?.files.map((file) => file.id));
  const destinationFileKeys = new Set(destination?.files.map(composerFileDedupKey));
  const skippedAttachmentCount =
    (leftover?.images.length ?? 0) +
    (leftover?.files.filter(
      (file) =>
        !destinationFileIds.has(file.id) && !destinationFileKeys.has(composerFileDedupKey(file)),
    ).length ?? 0);
  discardQueuedEditDraft(input.editTarget);
  return { outcome: "kept", skippedAttachmentCount };
}

/** Adds downloaded copies of a rescued edit's saved attachments to the thread draft. */
export async function restoreQueuedEditAttachments(input: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly target: ComposerThreadTarget;
  readonly download: (attachments: ReadonlyArray<ChatAttachment>) => Promise<ReadonlyArray<File>>;
  /** Draft ids chosen up front, so chips already in the prompt bind to these copies. */
  readonly localIds?: ReadonlyMap<string, string>;
}): Promise<{ readonly skippedAttachmentCount: number }> {
  // Each attachment downloads on its own so one failure keeps the rest.
  const results = await Promise.allSettled(
    input.attachments.map(async (source) => {
      const [file] = await input.download([source]);
      if (file === undefined) throw new Error(`Could not restore attachment: ${source.name}`);
      return { source, file };
    }),
  );
  const images: ComposerImageAttachment[] = [];
  const files: ComposerFileAttachment[] = [];
  for (const result of results) {
    if (result.status === "rejected") continue;
    const { source, file } = result.value;
    const attachment = {
      id: input.localIds?.get(source.id) ?? randomUUID(),
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
    };
    if (source.type === "image") {
      images.push({ ...attachment, type: "image", previewUrl: URL.createObjectURL(file) });
    } else {
      files.push({ ...attachment, type: "file" });
    }
  }
  const store = useComposerDraftStore.getState();
  const accepted =
    store.addImages(input.target, images, { allowDuplicates: true, allowOverflow: true }).length +
    store.addFiles(input.target, files, { allowDuplicates: true, allowOverflow: true }).length;
  return { skippedAttachmentCount: input.attachments.length - accepted };
}

export async function prepareQueuedEditAttachments(input: {
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly uploadFiles: (
    files: ReadonlyArray<ComposerFileAttachment>,
  ) => Promise<ReadonlyArray<ChatAttachment>>;
  readonly readImage: (file: File) => Promise<string>;
}) {
  const files = input.files.length === 0 ? [] : await input.uploadFiles(input.files);
  if (files.length !== input.files.length)
    throw new Error(m(msg("Retry or remove failed uploads before saving.")));
  const images = await Promise.all(
    input.images.map(async (image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await input.readImage(image.file),
      ...(image.source ? { source: image.source } : {}),
    })),
  );
  return [...input.existingAttachments, ...images, ...files];
}
