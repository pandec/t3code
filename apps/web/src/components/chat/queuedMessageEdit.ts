import type { ChatAttachment, ModelSelection } from "@t3tools/contracts";
import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { randomUUID } from "~/lib/utils";

/**
 * Keep an unsaved edit when its queued run leaves the queue (removed from
 * another client, or started after its edit hold lapsed). The edit is appended
 * to the thread's draft with its attachments, contexts and the message's
 * model, so nothing typed is lost even when that draft already has content.
 * Saved attachments the edit kept are restored separately because they have
 * to be downloaded (restoreQueuedEditAttachments).
 */
export function recoverQueuedMessageEdit(input: {
  readonly editTarget: ComposerThreadTarget;
  readonly threadTarget: ComposerThreadTarget;
  readonly originalText: string;
  /** True when the edit dropped one of the message's saved attachments. */
  readonly removedSavedAttachments?: boolean;
  /** The queued message's model, staged so a resend uses it. */
  readonly modelSelection?: ModelSelection;
}): { readonly outcome: "kept" | "clean"; readonly skippedAttachmentCount: number } {
  const store = useComposerDraftStore.getState();
  const edit = store.getComposerDraft(input.editTarget);
  const dirty =
    edit !== null &&
    (edit.prompt !== input.originalText ||
      edit.images.length > 0 ||
      edit.files.length > 0 ||
      edit.terminalContexts.length > 0 ||
      edit.previewAnnotations.length > 0 ||
      edit.reviewComments.length > 0 ||
      edit.threadContexts.length > 0 ||
      input.removedSavedAttachments === true);
  if (edit === null || !dirty) {
    store.clearComposerContent(input.editTarget);
    return { outcome: "clean", skippedAttachmentCount: 0 };
  }
  const destination = store.getComposerDraft(input.threadTarget);
  const prompt = [destination?.prompt ?? "", edit.prompt]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  // Attachments move with their upload state; the prompt keeps its inline
  // references because the contexts they point at move along with it.
  store.moveComposerPromptAndImages(input.editTarget, input.threadTarget);
  store.setPrompt(input.threadTarget, prompt);
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
  if (input.modelSelection !== undefined) {
    store.setModelSelection(input.threadTarget, input.modelSelection, { replaceOptions: true });
  }
  // Attachments past the per-message limit stay behind in the edit draft.
  const leftover = store.getComposerDraft(input.editTarget);
  const skippedAttachmentCount = (leftover?.images.length ?? 0) + (leftover?.files.length ?? 0);
  store.clearComposerContent(input.editTarget);
  return { outcome: "kept", skippedAttachmentCount };
}

/** Adds downloaded copies of a rescued edit's saved attachments to the thread draft. */
export async function restoreQueuedEditAttachments(input: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly target: ComposerThreadTarget;
  readonly download: (attachments: ReadonlyArray<ChatAttachment>) => Promise<ReadonlyArray<File>>;
}): Promise<{ readonly skippedAttachmentCount: number }> {
  const downloaded = await input.download(input.attachments);
  const images: ComposerImageAttachment[] = [];
  const files: ComposerFileAttachment[] = [];
  downloaded.forEach((file, index) => {
    const attachment = {
      id: randomUUID(),
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
    };
    if (input.attachments[index]?.type === "image") {
      images.push({ ...attachment, type: "image", previewUrl: URL.createObjectURL(file) });
    } else {
      files.push({ ...attachment, type: "file" });
    }
  });
  const store = useComposerDraftStore.getState();
  const accepted =
    store.addImages(input.target, images, { allowDuplicates: true }).length +
    store.addFiles(input.target, files, { allowDuplicates: true }).length;
  return { skippedAttachmentCount: downloaded.length - accepted };
}

/** Generic files need upload references; images also support the inline transport. */
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
    throw new Error("Retry or remove failed uploads before saving.");
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
