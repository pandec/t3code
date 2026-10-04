import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import {
  prepareQueuedEditAttachments,
  recoverQueuedMessageEdit,
  restoreQueuedEditAttachments,
} from "./queuedMessageEdit";

const environmentId = EnvironmentId.make("remote-environment");
const threadTarget = scopeThreadRef(environmentId, ThreadId.make("thread:edit"));
const editTarget = DraftId.make("queued-edit:test");
const file: ComposerFileAttachment = {
  type: "file",
  id: "file:report",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 6,
  file: new File(["report"], "report.pdf", { type: "application/pdf" }),
};
const image: ComposerImageAttachment = {
  type: "image",
  id: "image:screen",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 5,
  file: new File(["image"], "screen.png", { type: "image/png" }),
  previewUrl: "blob:screen",
};
const uploadedFile = {
  type: "file" as const,
  id: "upload:report",
  name: file.name,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
};

describe("queued message file edits", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  });

  it.each([
    { images: [], label: "file-only" },
    { images: [image], label: "mixed" },
  ])("preserves a generic file in a $label save", async ({ images }) => {
    const attachments = await prepareQueuedEditAttachments({
      existingAttachments: [],
      images,
      files: [file],
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "data:image/png;base64,aW1hZ2U=",
    });
    expect(attachments.at(-1)).toEqual(uploadedFile);
    expect(attachments.length).toBe(images.length + 1);
    if (images.length > 0)
      expect(attachments[0]).toMatchObject({
        type: "image",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      });
  });

  it("retains saved attachments alongside newly uploaded files", async () => {
    const saved = { ...uploadedFile, id: "saved:earlier" };
    const attachments = await prepareQueuedEditAttachments({
      existingAttachments: [saved],
      images: [],
      files: [file],
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "unused",
    });
    expect(attachments).toEqual([saved, uploadedFile]);
  });

  it("fails a save instead of dropping a file whose upload is missing", async () => {
    await expect(
      prepareQueuedEditAttachments({
        existingAttachments: [],
        images: [image],
        files: [file],
        uploadFiles: async () => [],
        readImage: async () => "image",
      }),
    ).rejects.toThrow("Retry or remove");
  });

  it("keeps file-only edits when another client starts the queued run", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    store.addFiles(editTarget, [file]);
    expect(
      recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "Original message" }),
    ).toEqual({ outcome: "kept", skippedAttachmentCount: 0 });
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Original message");
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([file]);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("preserves uploaded file references when a remote queue advance interrupts the edit", () => {
    const store = useComposerDraftStore.getState();
    const uploaded = {
      ...file,
      file: null,
      uploadedAttachmentId: uploadedFile.id,
      uploadEnvironmentId: environmentId,
    };
    store.addFiles(editTarget, [uploaded]);
    expect(recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "" }).outcome).toBe(
      "kept",
    );
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([uploaded]);
  });

  it("appends the edit to a separate draft, with its contexts and model, instead of dropping it", () => {
    const store = useComposerDraftStore.getState();
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-edit" };
    const comment = {
      id: "review:1",
      sectionId: "section:1",
      sectionTitle: "src/a.ts",
      filePath: "src/a.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "L1",
      text: "Rename this",
      diff: "+const a = 1;",
    };
    store.setPrompt(threadTarget, "Separate draft");
    store.setPrompt(editTarget, "Edited message");
    store.addFiles(editTarget, [file]);
    store.setReviewComments(editTarget, [comment]);
    expect(
      recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: "Original message",
        modelSelection,
      }).outcome,
    ).toBe("kept");
    const draft = store.getComposerDraft(threadTarget);
    expect(draft?.prompt.startsWith("Separate draft\n\nEdited message")).toBe(true);
    expect(draft?.files).toEqual([file]);
    expect(draft?.reviewComments.map((entry) => entry.id)).toEqual([comment.id]);
    expect(draft?.modelSelectionByProvider[modelSelection.instanceId]?.model).toBe("gpt-edit");
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("keeps an edit that only removed a saved attachment", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    expect(
      recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: "Original message",
        removedSavedAttachments: true,
      }).outcome,
    ).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Original message");
  });

  it("leaves the thread draft alone when the edit had no changes", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadTarget, "Separate draft");
    store.setPrompt(editTarget, "Original message");
    expect(
      recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "Original message" })
        .outcome,
    ).toBe("clean");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Separate draft");
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("restores a rescued edit's saved attachments as draft images and files", async () => {
    const store = useComposerDraftStore.getState();
    const savedImage = {
      type: "image" as const,
      id: "saved:image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 5,
    };
    const restored = await restoreQueuedEditAttachments({
      attachments: [savedImage, uploadedFile],
      target: threadTarget,
      download: async (attachments) =>
        attachments.map(
          (attachment) => new File(["bytes"], attachment.name, { type: attachment.mimeType }),
        ),
    });
    expect(restored.skippedAttachmentCount).toBe(0);
    const draft = store.getComposerDraft(threadTarget);
    expect(draft?.images.map((entry) => entry.name)).toEqual(["screen.png"]);
    expect(draft?.files.map((entry) => entry.name)).toEqual(["report.pdf"]);
  });
});
