import {
  EnvironmentId,
  type EnvironmentId as EnvironmentIdType,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());

const DraftComposerImageAttachmentBaseFields = {
  id: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  uploadedAttachmentId: Schema.optional(Schema.String),
  uploadEnvironmentId: Schema.optional(EnvironmentId),
};

const InlineDraftComposerImageAttachmentFields = {
  ...DraftComposerImageAttachmentBaseFields,
  dataUrl: NonEmptyString,
  fileUri: Schema.optional(NonEmptyString),
};

const FileBackedDraftComposerImageAttachmentFields = {
  ...DraftComposerImageAttachmentBaseFields,
  dataUrl: Schema.optional(NonEmptyString),
  fileUri: NonEmptyString,
};

export const DraftComposerImageAttachmentSchema = Schema.Union([
  Schema.Struct({
    ...InlineDraftComposerImageAttachmentFields,
    previewUri: Schema.String,
  }),
  Schema.Struct({
    ...FileBackedDraftComposerImageAttachmentFields,
    previewUri: Schema.String,
  }),
]);

export const DraftComposerFileAttachmentSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("file"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  fileUri: NonEmptyString,
  uploadedAttachmentId: Schema.optional(Schema.String),
  uploadEnvironmentId: Schema.optional(EnvironmentId),
});

export const DraftComposerAttachmentSchema = Schema.Union([
  DraftComposerImageAttachmentSchema,
  DraftComposerFileAttachmentSchema,
]);

// Outbox rows omit duplicate previews for inline images. File-backed images
// retain previewUri because their bytes cannot reconstruct it until delivery.
export const PersistedDraftComposerImageAttachmentSchema = Schema.Union([
  Schema.Struct({
    ...InlineDraftComposerImageAttachmentFields,
    previewUri: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...FileBackedDraftComposerImageAttachmentFields,
    previewUri: Schema.optional(Schema.String),
  }),
]);

export const PersistedDraftComposerAttachmentSchema = Schema.Union([
  PersistedDraftComposerImageAttachmentSchema,
  DraftComposerFileAttachmentSchema,
]);

interface DraftComposerImageAttachmentBase extends Omit<UploadChatImageAttachment, "dataUrl"> {
  readonly id: string;
  readonly previewUri: string;
  readonly uploadedAttachmentId?: string | undefined;
  readonly uploadEnvironmentId?: EnvironmentIdType | undefined;
}

export type DraftComposerImageAttachment =
  | (DraftComposerImageAttachmentBase & {
      readonly dataUrl: string;
      readonly fileUri?: string | undefined;
    })
  | (DraftComposerImageAttachmentBase & {
      readonly dataUrl?: string | undefined;
      readonly fileUri: string;
    });

export interface DraftComposerFileAttachment {
  readonly id: string;
  readonly type: "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly fileUri: string;
  readonly uploadedAttachmentId?: string | undefined;
  readonly uploadEnvironmentId?: EnvironmentIdType | undefined;
}

export type DraftComposerAttachment = DraftComposerImageAttachment | DraftComposerFileAttachment;

/** Any composer attachment whose bytes live in a local file. */
export type FileBackedComposerAttachment = DraftComposerAttachment & { readonly fileUri: string };

export function isFileBackedComposerAttachment(
  attachment: DraftComposerAttachment,
): attachment is FileBackedComposerAttachment {
  return attachment.fileUri !== undefined;
}

/** Wire shape for startTurn: pure inline images without draft-only fields. */
export function toUploadChatImageAttachments(
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): ReadonlyArray<UploadChatImageAttachment> {
  return attachments.map((attachment) => {
    if (attachment.dataUrl === undefined) {
      throw new Error(`'${attachment.name}' must be materialized before sending.`);
    }
    return {
      type: attachment.type,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataUrl: attachment.dataUrl,
    };
  });
}
