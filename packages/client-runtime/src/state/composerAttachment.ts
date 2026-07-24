import type { UploadChatImageAttachment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Self-contained persisted shape of a composer image attachment. The dataUrl
 * carries the full payload so a queued message can round-trip through storage
 * and back into a platform composer without live File/blob handles.
 */
export const DraftComposerImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});

export interface DraftComposerImageAttachment extends UploadChatImageAttachment {
  readonly id: string;
  readonly previewUri: string;
}

/** Wire shape for startTurn: pure uploads without client draft id / previewUri. */
export function toUploadChatImageAttachments(
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): ReadonlyArray<UploadChatImageAttachment> {
  return attachments.map((attachment) => ({
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    dataUrl: attachment.dataUrl,
  }));
}
