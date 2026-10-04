import { describe, expect, it } from "vite-plus/test";
import {
  ChatAttachmentId,
  ComposerContextId,
  MessageId,
  RunId,
  type ChatAttachment,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";

import { composerDraftEnvironmentId } from "../lib/composerAttachmentUploadQueue";
import { isQueuedEditDraftKey, queuedEditDraftKey } from "./queued-edit-draft-key";
import {
  queuedRunEditHasChanges,
  rebindQueuedEditContext,
  resolveQueuedEditPayload,
  type QueuedRunEdit,
} from "./queued-run-edit";

const image = (id: string): ChatAttachment => ({
  type: "image",
  id: ChatAttachmentId.make(id),
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 10,
});

function edit(attachments: ReadonlyArray<ChatAttachment>): QueuedRunEdit {
  return {
    runId: RunId.make("run-1"),
    messageId: MessageId.make("message-1"),
    originalText: "original",
    existingAttachments: attachments,
  };
}

function context(attachmentIds: ReadonlyArray<string>): OrchestrationMessageContext {
  return {
    version: 1,
    records: attachmentIds.map((attachmentId, index) => ({
      version: 1,
      kind: "image",
      contextId: ComposerContextId.make(`ctx-${index}`),
      label: `${attachmentId}.png`,
      attachmentId,
      name: `${attachmentId}.png`,
      mimeType: "image/png",
      sizeBytes: 10,
    })),
  };
}

describe("queued edit draft key", () => {
  it("keeps the environment readable so attachment uploads still resolve it", () => {
    const key = queuedEditDraftKey("env-1:thread-9", "run-3");

    expect(isQueuedEditDraftKey(key)).toBe(true);
    expect(isQueuedEditDraftKey("env-1:thread-9")).toBe(false);
    expect(composerDraftEnvironmentId(key, [])).toBe("env-1");
  });
});

describe("resolveQueuedEditPayload", () => {
  it("resends the kept server attachments ahead of the newly uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([image("kept")]),
      draftContext: undefined,
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept", "uploaded"]);
  });

  it("rebinds context records from the draft's ids to the uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([]),
      draftContext: context(["draft-1"]),
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.context?.records).toEqual([
      expect.objectContaining({ attachmentId: "uploaded" }),
    ]);
  });

  it("drops the record of an attachment the user removed", () => {
    const payload = resolveQueuedEditPayload({
      // "gone" was on the message and has been removed from the kept list.
      edit: edit([image("kept")]),
      draftContext: context(["kept", "gone"]),
      draftAttachments: [],
      uploaded: [],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept"]);
    expect(payload.context?.records).toEqual([expect.objectContaining({ attachmentId: "kept" })]);
  });

  it("returns no context when every record lost its attachment", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([]),
      draftContext: context(["gone"]),
      draftAttachments: [],
      uploaded: [],
    });

    expect(payload.attachments).toEqual([]);
    expect(payload.context).toBeUndefined();
  });
});

describe("queuedRunEditHasChanges", () => {
  const begun = { ...edit([image("kept")]), originalAttachmentCount: 1 };

  it("closes an untouched edit without rescuing it", () => {
    expect(queuedRunEditHasChanges(begun, { text: "original", attachments: [] })).toBe(false);
  });

  it("rescues new text, new attachments, or a removed saved attachment", () => {
    expect(queuedRunEditHasChanges(begun, { text: "changed", attachments: [] })).toBe(true);
    expect(queuedRunEditHasChanges(begun, { text: "original", attachments: [{}] })).toBe(true);
    expect(
      queuedRunEditHasChanges(
        { ...begun, existingAttachments: [] },
        { text: "original", attachments: [] },
      ),
    ).toBe(true);
  });
});

describe("rebindQueuedEditContext", () => {
  it("points saved-attachment chips at the rescued copies and leaves the rest alone", () => {
    const rebound = rebindQueuedEditContext(
      context(["saved-1", "new-draft"]),
      new Map([["saved-1", "local-1"]]),
    );
    expect(
      rebound?.records.map((record) => ("attachmentId" in record ? record.attachmentId : null)),
    ).toEqual(["local-1", "new-draft"]);
    expect(rebindQueuedEditContext(undefined, new Map([["saved-1", "local-1"]]))).toBeUndefined();
  });
});
