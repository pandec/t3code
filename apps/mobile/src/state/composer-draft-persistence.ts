import {
  ModelSelection as ModelSelectionSchema,
  ProviderInteractionMode as ProviderInteractionModeSchema,
  RuntimeMode as RuntimeModeSchema,
  MessageInputOrigin,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { Directory as ExpoDirectory } from "expo-file-system";

import { DraftComposerImageAttachmentSchema } from "../lib/composer-image-schema";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import type { ComposerDraft } from "./use-composer-drafts";

const LEGACY_SCHEMA_VERSION = 1;
const RECORD_SCHEMA_VERSION = 2;
const COMPOSER_DRAFTS_DIRECTORY = "composer-drafts";
const COMPOSER_DRAFT_RECORDS_DIRECTORY = "drafts";
const COMPOSER_DRAFT_ATTACHMENTS_DIRECTORY = "attachments";
const LEGACY_COMPOSER_DRAFTS_FILE = "drafts.json";
const DRAFT_RECORD_SUFFIX = ".json";
const ATTACHMENT_FILE_SUFFIX = ".attachment";
const TEMP_FILE_SUFFIX = ".tmp";
const attachmentContentHashes = new WeakMap<DraftComposerImageAttachment, Promise<string>>();

export class ComposerDraftPersistenceError extends Schema.TaggedErrorClass<ComposerDraftPersistenceError>()(
  "ComposerDraftPersistenceError",
  {
    operation: Schema.Literals([
      "open",
      "list",
      "read",
      "decode",
      "encode",
      "hash",
      "write",
      "verify",
      "remove",
      "migrate",
      "sweep",
      "hydrate",
    ]),
    directory: Schema.String,
    fileName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Composer draft persistence operation ${this.operation} failed for ${this.directory}/${this.fileName}.`;
  }
}

const ComposerDraftWorkspaceSelectionSchema = Schema.Struct({
  mode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const LegacyComposerDraftSchema = Schema.Struct({
  text: Schema.String,
  inputOrigin: Schema.optional(MessageInputOrigin),
  attachments: Schema.Array(DraftComposerImageAttachmentSchema),
  importedShareIds: Schema.optional(Schema.Array(Schema.String)),
  modelSelection: Schema.optional(ModelSelectionSchema),
  runtimeMode: Schema.optional(RuntimeModeSchema),
  interactionMode: Schema.optional(ProviderInteractionModeSchema),
  workspaceSelection: Schema.optional(ComposerDraftWorkspaceSelectionSchema),
});

const LegacyComposerDraftsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(LEGACY_SCHEMA_VERSION),
  drafts: Schema.Record(Schema.String, LegacyComposerDraftSchema),
});

const PersistedAttachmentReferenceSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  contentHash: Schema.String,
});

const PersistedComposerDraftSchema = Schema.Struct({
  text: Schema.String,
  inputOrigin: Schema.optional(MessageInputOrigin),
  attachments: Schema.Array(PersistedAttachmentReferenceSchema),
  importedShareIds: Schema.optional(Schema.Array(Schema.String)),
  modelSelection: Schema.optional(ModelSelectionSchema),
  runtimeMode: Schema.optional(RuntimeModeSchema),
  interactionMode: Schema.optional(ProviderInteractionModeSchema),
  workspaceSelection: Schema.optional(ComposerDraftWorkspaceSelectionSchema),
});

const PersistedComposerDraftRecordSchema = Schema.Struct({
  schemaVersion: Schema.Literal(RECORD_SCHEMA_VERSION),
  draftKey: Schema.String,
  draft: PersistedComposerDraftSchema,
});

const decodeLegacyComposerDraftsDocument = Schema.decodeUnknownSync(LegacyComposerDraftsSchema);
const decodeComposerDraftRecordDocument = Schema.decodeUnknownSync(
  PersistedComposerDraftRecordSchema,
);

type PersistedComposerDraftRecord = Schema.Schema.Type<typeof PersistedComposerDraftRecordSchema>;
type PersistedAttachmentReference = Schema.Schema.Type<typeof PersistedAttachmentReferenceSchema>;

export interface SplitComposerDraftRecord {
  readonly record: PersistedComposerDraftRecord;
  readonly attachmentContents: ReadonlyMap<string, string>;
}

function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    draft.text.length === 0 &&
    draft.inputOrigin === undefined &&
    draft.attachments.length === 0 &&
    draft.modelSelection === undefined &&
    draft.runtimeMode === undefined &&
    draft.interactionMode === undefined &&
    draft.workspaceSelection === undefined
  );
}

export function decodePersistedComposerDrafts(value: unknown): Record<string, ComposerDraft> {
  const parsed = decodeLegacyComposerDraftsDocument(value);
  return Object.fromEntries(
    Object.entries(parsed.drafts).filter(([, draft]) => !isEmptyDraft(draft)),
  );
}

function attachmentReference(
  attachment: DraftComposerImageAttachment,
  contentHash: string,
): PersistedAttachmentReference {
  return {
    id: attachment.id,
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    contentHash,
  };
}

export async function splitComposerDraftForPersistence(
  draftKey: string,
  draft: ComposerDraft,
  hashContent: (content: string, attachment: DraftComposerImageAttachment) => Promise<string>,
): Promise<SplitComposerDraftRecord> {
  const attachmentContents = new Map<string, string>();
  const attachments: PersistedAttachmentReference[] = [];
  for (const attachment of draft.attachments) {
    const contentHash = await hashContent(attachment.dataUrl, attachment);
    const existing = attachmentContents.get(contentHash);
    if (existing !== undefined && existing !== attachment.dataUrl) {
      throw new Error(`Composer attachment hash collision for ${contentHash}.`);
    }
    attachmentContents.set(contentHash, attachment.dataUrl);
    attachments.push(attachmentReference(attachment, contentHash));
  }

  return {
    record: {
      schemaVersion: RECORD_SCHEMA_VERSION,
      draftKey,
      draft: {
        ...draft,
        attachments,
      },
    },
    attachmentContents,
  };
}

export function composerDraftAttachmentReferenceCounts(
  records: ReadonlyArray<PersistedComposerDraftRecord>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const attachment of record.draft.attachments) {
      counts.set(attachment.contentHash, (counts.get(attachment.contentHash) ?? 0) + 1);
    }
  }
  return counts;
}

export function orphanComposerDraftAttachmentFileNames(
  attachmentFileNames: ReadonlyArray<string>,
  records: ReadonlyArray<PersistedComposerDraftRecord>,
): ReadonlyArray<string> {
  const references = composerDraftAttachmentReferenceCounts(records);
  return attachmentFileNames.filter((fileName) => {
    if (fileName.endsWith(TEMP_FILE_SUFFIX)) {
      return true;
    }
    if (!fileName.endsWith(ATTACHMENT_FILE_SUFFIX)) {
      return false;
    }
    const contentHash = fileName.slice(0, -ATTACHMENT_FILE_SUFFIX.length);
    return !references.has(contentHash);
  });
}

function draftRecordFileName(draftKey: string): string {
  return `${encodeURIComponent(draftKey)}${DRAFT_RECORD_SUFFIX}`;
}

function attachmentFileName(contentHash: string): string {
  return `${contentHash}${ATTACHMENT_FILE_SUFFIX}`;
}

async function getStorageDirectories() {
  const { Directory, Paths } = await import("expo-file-system");
  const root = new Directory(Paths.document, COMPOSER_DRAFTS_DIRECTORY);
  root.create({ idempotent: true, intermediates: true });
  const records = new Directory(root, COMPOSER_DRAFT_RECORDS_DIRECTORY);
  records.create({ idempotent: true, intermediates: true });
  const attachments = new Directory(root, COMPOSER_DRAFT_ATTACHMENTS_DIRECTORY);
  attachments.create({ idempotent: true, intermediates: true });
  return { root, records, attachments };
}

async function hashAttachmentContent(content: string): Promise<string> {
  try {
    const { CryptoDigestAlgorithm, digestStringAsync } = await import("expo-crypto");
    return await digestStringAsync(CryptoDigestAlgorithm.SHA256, content);
  } catch (cause) {
    throw new ComposerDraftPersistenceError({
      operation: "hash",
      directory: `${COMPOSER_DRAFTS_DIRECTORY}/${COMPOSER_DRAFT_ATTACHMENTS_DIRECTORY}`,
      fileName: "content",
      cause,
    });
  }
}

function cachedAttachmentContentHash(
  content: string,
  attachment: DraftComposerImageAttachment,
): Promise<string> {
  const cached = attachmentContentHashes.get(attachment);
  if (cached) {
    return cached;
  }
  const hash = hashAttachmentContent(content);
  attachmentContentHashes.set(attachment, hash);
  return hash;
}

async function loadRecordDocuments(): Promise<ReadonlyArray<PersistedComposerDraftRecord>> {
  let operation: ComposerDraftPersistenceError["operation"] = "open";
  try {
    const { File } = await import("expo-file-system");
    const { records } = await getStorageDirectories();
    operation = "list";
    const documents: PersistedComposerDraftRecord[] = [];
    for (const entry of records.list()) {
      if (!(entry instanceof File) || !entry.name.endsWith(DRAFT_RECORD_SUFFIX)) {
        continue;
      }
      try {
        const raw = await entry.text();
        documents.push(decodeComposerDraftRecordDocument(JSON.parse(raw) as unknown));
      } catch (cause) {
        console.warn(
          "[composer-drafts] ignored invalid persisted draft record",
          new ComposerDraftPersistenceError({
            operation: "decode",
            directory: `${COMPOSER_DRAFTS_DIRECTORY}/${COMPOSER_DRAFT_RECORDS_DIRECTORY}`,
            fileName: entry.name,
            cause,
          }),
        );
      }
    }
    return documents;
  } catch (cause) {
    throw new ComposerDraftPersistenceError({
      operation,
      directory: `${COMPOSER_DRAFTS_DIRECTORY}/${COMPOSER_DRAFT_RECORDS_DIRECTORY}`,
      fileName: "*",
      cause,
    });
  }
}

async function hydrateRecord(record: PersistedComposerDraftRecord): Promise<ComposerDraft> {
  const { File } = await import("expo-file-system");
  const { attachments: attachmentDirectory } = await getStorageDirectories();
  const attachments: DraftComposerImageAttachment[] = [];
  for (const attachment of record.draft.attachments) {
    const fileName = attachmentFileName(attachment.contentHash);
    try {
      const file = new File(attachmentDirectory, fileName);
      if (!file.exists) {
        throw new Error("Attachment content file is missing.");
      }
      const dataUrl = await file.text();
      attachments.push({
        id: attachment.id,
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl,
        previewUri: dataUrl,
      });
    } catch (cause) {
      console.warn(
        "[composer-drafts] ignored missing persisted attachment",
        new ComposerDraftPersistenceError({
          operation: "hydrate",
          directory: `${COMPOSER_DRAFTS_DIRECTORY}/${COMPOSER_DRAFT_ATTACHMENTS_DIRECTORY}`,
          fileName,
          cause,
        }),
      );
    }
  }
  return {
    ...record.draft,
    attachments,
  };
}

async function loadLegacyDrafts(): Promise<{
  readonly drafts: Record<string, ComposerDraft>;
  readonly exists: boolean;
  readonly valid: boolean;
}> {
  const { File } = await import("expo-file-system");
  const { root } = await getStorageDirectories();
  const file = new File(root, LEGACY_COMPOSER_DRAFTS_FILE);
  if (!file.exists) {
    return { drafts: {}, exists: false, valid: true };
  }
  try {
    return {
      drafts: decodePersistedComposerDrafts(JSON.parse(await file.text()) as unknown),
      exists: true,
      valid: true,
    };
  } catch (cause) {
    console.warn(
      "[composer-drafts] ignored invalid legacy draft document",
      new ComposerDraftPersistenceError({
        operation: "decode",
        directory: COMPOSER_DRAFTS_DIRECTORY,
        fileName: LEGACY_COMPOSER_DRAFTS_FILE,
        cause,
      }),
    );
    return { drafts: {}, exists: true, valid: false };
  }
}

async function writeFileAtomically(
  directory: ExpoDirectory,
  fileName: string,
  content: string,
): Promise<void> {
  const { File } = await import("expo-file-system");
  const destination = new File(directory, fileName);
  const temporary = new File(directory, `${fileName}.${Date.now()}${TEMP_FILE_SUFFIX}`);
  let moved = false;
  try {
    temporary.create({ intermediates: true, overwrite: true });
    temporary.write(content);
    temporary.moveSync(destination, { overwrite: true });
    moved = true;
  } finally {
    if (!moved && temporary.exists) {
      temporary.delete();
    }
  }
}

async function writeAttachmentContents(
  attachmentContents: ReadonlyMap<string, string>,
  verify: boolean,
): Promise<void> {
  const { File } = await import("expo-file-system");
  const { attachments } = await getStorageDirectories();
  for (const [contentHash, content] of attachmentContents) {
    const fileName = attachmentFileName(contentHash);
    const file = new File(attachments, fileName);
    const wrote = !file.exists;
    if (wrote) {
      await writeFileAtomically(attachments, fileName, content);
    }
    if (verify && wrote) {
      const persisted = await file.text();
      if (persisted !== content) {
        throw new ComposerDraftPersistenceError({
          operation: "verify",
          directory: `${COMPOSER_DRAFTS_DIRECTORY}/${COMPOSER_DRAFT_ATTACHMENTS_DIRECTORY}`,
          fileName,
          cause: new Error("Persisted composer attachment did not match its content hash."),
        });
      }
    }
  }
}

async function writeDraftRecord(
  record: PersistedComposerDraftRecord,
  verify: boolean,
): Promise<void> {
  const { File } = await import("expo-file-system");
  const { records } = await getStorageDirectories();
  const fileName = draftRecordFileName(record.draftKey);
  const file = new File(records, fileName);
  const encoded = JSON.stringify(record);
  await writeFileAtomically(records, fileName, encoded);
  if (verify) {
    const persisted = await file.text();
    if (persisted !== encoded) {
      throw new ComposerDraftPersistenceError({
        operation: "verify",
        directory: `${COMPOSER_DRAFTS_DIRECTORY}/${COMPOSER_DRAFT_RECORDS_DIRECTORY}`,
        fileName,
        cause: new Error("Persisted composer draft record did not match the requested write."),
      });
    }
  }
}

async function removeDraftRecord(draftKey: string): Promise<void> {
  const { File } = await import("expo-file-system");
  const { records } = await getStorageDirectories();
  const file = new File(records, draftRecordFileName(draftKey));
  if (file.exists) {
    file.delete();
  }
}

export async function sweepOrphanComposerDraftAttachments(): Promise<void> {
  let operation: ComposerDraftPersistenceError["operation"] = "sweep";
  try {
    const { File } = await import("expo-file-system");
    const { attachments } = await getStorageDirectories();
    operation = "list";
    const files = attachments
      .list()
      .filter((entry): entry is InstanceType<typeof File> => entry instanceof File);
    const records = await loadRecordDocuments();
    const orphanNames = new Set(
      orphanComposerDraftAttachmentFileNames(
        files.map((file) => file.name),
        records,
      ),
    );
    operation = "remove";
    for (const file of files) {
      if (orphanNames.has(file.name)) {
        file.delete();
      }
    }
  } catch (cause) {
    throw new ComposerDraftPersistenceError({
      operation,
      directory: `${COMPOSER_DRAFTS_DIRECTORY}/${COMPOSER_DRAFT_ATTACHMENTS_DIRECTORY}`,
      fileName: "*",
      cause,
    });
  }
}

export async function persistComposerDraftKeys(
  drafts: Record<string, ComposerDraft>,
  draftKeys: ReadonlySet<string>,
  options?: { readonly verify?: boolean; readonly sweepAttachments?: boolean },
): Promise<void> {
  for (const draftKey of draftKeys) {
    const draft = drafts[draftKey];
    if (!draft || isEmptyDraft(draft)) {
      await removeDraftRecord(draftKey);
      continue;
    }
    const split = await splitComposerDraftForPersistence(
      draftKey,
      draft,
      cachedAttachmentContentHash,
    );
    await writeAttachmentContents(split.attachmentContents, options?.verify === true);
    await writeDraftRecord(split.record, options?.verify === true);
  }
  if (options?.sweepAttachments === true) {
    try {
      await sweepOrphanComposerDraftAttachments();
    } catch (error) {
      console.warn("[composer-drafts] failed to sweep orphan attachments", error);
    }
  }
}

async function removeLegacyDraftsFile(): Promise<void> {
  const { File } = await import("expo-file-system");
  const { root } = await getStorageDirectories();
  const file = new File(root, LEGACY_COMPOSER_DRAFTS_FILE);
  if (file.exists) {
    file.delete();
  }
}

export async function loadPersistedComposerDrafts(): Promise<Record<string, ComposerDraft>> {
  const records = await loadRecordDocuments();
  const recordDrafts: Record<string, ComposerDraft> = {};
  for (const record of records) {
    const draft = await hydrateRecord(record);
    if (!isEmptyDraft(draft)) {
      recordDrafts[record.draftKey] = draft;
    }
  }

  const legacy = await loadLegacyDrafts();
  const drafts = {
    ...legacy.drafts,
    ...recordDrafts,
  };
  if (legacy.exists && legacy.valid) {
    try {
      if (Object.keys(drafts).length > 0) {
        await persistComposerDraftKeys(drafts, new Set(Object.keys(drafts)), {
          verify: true,
        });
      }
      await removeLegacyDraftsFile();
    } catch (cause) {
      console.warn(
        "[composer-drafts] legacy migration will retry on next load",
        new ComposerDraftPersistenceError({
          operation: "migrate",
          directory: COMPOSER_DRAFTS_DIRECTORY,
          fileName: LEGACY_COMPOSER_DRAFTS_FILE,
          cause,
        }),
      );
    }
  }
  try {
    await sweepOrphanComposerDraftAttachments();
  } catch (error) {
    console.warn("[composer-drafts] failed to sweep orphan attachments on load", error);
  }
  return drafts;
}
