import type {
  ChatAttachment,
  EnvironmentId,
  ModelSelection,
  OrchestrationMessageContext,
  ThreadId,
} from "@t3tools/contracts";
import {
  composerFileDedupKey,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { randomUUID } from "~/lib/utils";
import { applyMessageContextRestore, planMessageContextRestore } from "./messageContextRestore";

/**
 * Keep an unsaved edit when its queued run leaves the queue (removed from
 * another client, or started after its edit hold lapsed). The edit is appended
 * to the thread's draft with its attachments, contexts and the message's
 * model, so nothing typed is lost even when that draft already has content.
 * Saved attachments the edit kept are restored separately because they have
 * to be downloaded (restoreQueuedEditAttachments, with the same
 * `savedAttachmentLocalIds`); chips for the message's own context records are
 * rebuilt on the thread's draft so they keep their payload.
 */
export function recoverQueuedMessageEdit(input: {
  readonly editTarget: ComposerThreadTarget;
  readonly threadTarget: ComposerThreadTarget;
  readonly originalText: string;
  /** True when the edit dropped one of the message's saved attachments. */
  readonly removedSavedAttachments?: boolean;
  /** The queued message's model, staged so a resend uses it. */
  readonly modelSelection?: ModelSelection;
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
  const prompt = [destination?.prompt ?? "", restoredContext?.text ?? edit.prompt]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  // Attachments move with their upload state, past the per-message limit if
  // need be (sending still enforces it); the prompt keeps its inline
  // references because the contexts they point at move along with it.
  store.moveComposerPromptAndImages(input.editTarget, input.threadTarget, { allowOverflow: true });
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
  if (restoredContext !== null) applyMessageContextRestore(input.threadTarget, restoredContext);
  if (input.modelSelection !== undefined) {
    store.setModelSelection(input.threadTarget, input.modelSelection, { replaceOptions: true });
  }
  // Files the thread draft already holds stay behind as duplicates; anything
  // else left (a file that cannot cross environments) is reported.
  const leftover = store.getComposerDraft(input.editTarget);
  const destinationFileIds = new Set(destination?.files.map((file) => file.id));
  const destinationFileKeys = new Set(destination?.files.map(composerFileDedupKey));
  const skippedAttachmentCount =
    (leftover?.images.length ?? 0) +
    (leftover?.files.filter(
      (file) =>
        !destinationFileIds.has(file.id) && !destinationFileKeys.has(composerFileDedupKey(file)),
    ).length ?? 0);
  store.clearComposerContent(input.editTarget);
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
  const downloaded = await input.download(input.attachments);
  const images: ComposerImageAttachment[] = [];
  const files: ComposerFileAttachment[] = [];
  downloaded.forEach((file, index) => {
    const source = input.attachments[index];
    const attachment = {
      id: (source && input.localIds?.get(source.id)) ?? randomUUID(),
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
    };
    if (source?.type === "image") {
      images.push({ ...attachment, type: "image", previewUrl: URL.createObjectURL(file) });
    } else {
      files.push({ ...attachment, type: "file" });
    }
  });
  const store = useComposerDraftStore.getState();
  const accepted =
    store.addImages(input.target, images, { allowDuplicates: true, allowOverflow: true }).length +
    store.addFiles(input.target, files, { allowDuplicates: true, allowOverflow: true }).length;
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
