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
import { isServerThreadDraftKey } from "../lib/scopedEntities";
import type { ModelSelection } from "@t3tools/contracts";

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
let expoCryptoPromise: Promise<typeof import("expo-crypto")> | null = null;
let expoFileSystemPromise: Promise<typeof import("expo-file-system")> | null = null;

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
      "quarantine",
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

export class ComposerDraftBatchPersistenceError extends Error {
  readonly failures: ReadonlyMap<string, unknown>;

  constructor(failures: ReadonlyMap<string, unknown>) {
    super(`Failed to persist ${failures.size} composer draft${failures.size === 1 ? "" : "s"}.`);
    this.name = "ComposerDraftBatchPersistenceError";
    this.failures = failures;
  }

  get failedDraftKeys(): ReadonlySet<string> {
    return new Set(this.failures.keys());
  }
}

const ComposerDraftWorkspaceSelectionSchema = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["local", "worktree"])),
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

/**
 * importedShareIds are share-import receipts: a contentless draft carrying one
 * is not discardable, or the same native share would re-import after restart.
 */
function isDiscardableDraft(draft: ComposerDraft): boolean {
  return isEmptyDraft(draft) && (draft.importedShareIds?.length ?? 0) === 0;
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

function composerDraftForPersistence(draftKey: string, draft: ComposerDraft): ComposerDraft {
  if (!isServerThreadDraftKey(draftKey)) {
    return draft;
  }
  const {
    modelSelection: _modelSelection,
    runtimeMode: _runtimeMode,
    interactionMode: _interactionMode,
    ...stripped
  } = draft;
  return stripped;
}

export function decodePersistedComposerDrafts(value: unknown): Record<string, ComposerDraft> {
  const parsed = decodeLegacyComposerDraftsDocument(value);
  return Object.fromEntries(
    Object.entries(parsed.drafts).filter(([, draft]) => !isDiscardableDraft(draft)),
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

  const persistedDraft = composerDraftForPersistence(draftKey, draft);
  return {
    record: {
      schemaVersion: RECORD_SCHEMA_VERSION,
      draftKey,
      draft: {
        ...persistedDraft,
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

async function loadExpoFileSystem(): Promise<typeof import("expo-file-system")> {
  if (expoFileSystemPromise) {
    return expoFileSystemPromise;
  }
  const loading = import("expo-file-system");
  expoFileSystemPromise = loading;
  try {
    return await loading;
  } catch (error) {
    if (expoFileSystemPromise === loading) {
      expoFileSystemPromise = null;
    }
    throw error;
  }
}

async function getStorageDirectories() {
  const { Directory, Paths } = await loadExpoFileSystem();
  const root = new Directory(Paths.document, COMPOSER_DRAFTS_DIRECTORY);
  root.create({ idempotent: true, intermediates: true });
  const records = new Directory(root, COMPOSER_DRAFT_RECORDS_DIRECTORY);
  records.create({ idempotent: true, intermediates: true });
  const attachments = new Directory(root, COMPOSER_DRAFT_ATTACHMENTS_DIRECTORY);
  attachments.create({ idempotent: true, intermediates: true });
  return { root, records, attachments };
}

async function loadExpoCrypto(): Promise<typeof import("expo-crypto")> {
  if (expoCryptoPromise) {
    return expoCryptoPromise;
  }
  const loading = import("expo-crypto");
  expoCryptoPromise = loading;
  try {
    return await loading;
  } catch (error) {
    if (expoCryptoPromise === loading) {
      expoCryptoPromise = null;
    }
    throw error;
  }
}

async function hashAttachmentContent(content: string): Promise<string> {
  try {
    const { CryptoDigestAlgorithm, digestStringAsync } = await loadExpoCrypto();
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
  void hash.catch(() => {
    if (attachmentContentHashes.get(attachment) === hash) {
      attachmentContentHashes.delete(attachment);
    }
  });
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
      if (!(entry instanceof File)) {
        continue;
      }
      if (entry.name.endsWith(TEMP_FILE_SUFFIX)) {
        try {
          entry.delete();
        } catch (cause) {
          console.warn(
            "[composer-drafts] failed to remove temporary draft record",
            new ComposerDraftPersistenceError({
              operation: "sweep",
              directory: `${COMPOSER_DRAFTS_DIRECTORY}/${COMPOSER_DRAFT_RECORDS_DIRECTORY}`,
              fileName: entry.name,
              cause,
            }),
          );
        }
        continue;
      }
      if (!entry.name.endsWith(DRAFT_RECORD_SUFFIX)) {
        continue;
      }
      let raw: string;
      try {
        raw = await entry.text();
      } catch (cause) {
        throw new ComposerDraftPersistenceError({
          operation: "read",
          directory: `${COMPOSER_DRAFTS_DIRECTORY}/${COMPOSER_DRAFT_RECORDS_DIRECTORY}`,
          fileName: entry.name,
          cause,
        });
      }
      try {
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
    if (cause instanceof ComposerDraftPersistenceError) {
      throw cause;
    }
    throw new ComposerDraftPersistenceError({
      operation,
      directory: `${COMPOSER_DRAFTS_DIRECTORY}/${COMPOSER_DRAFT_RECORDS_DIRECTORY}`,
      fileName: "*",
      cause,
    });
  }
}

type AttachmentHydrationState = "ok" | "corrupt" | "unavailable";

type HydratedAttachment =
  | { readonly state: "ok"; readonly attachment: DraftComposerImageAttachment }
  | { readonly state: "corrupt" }
  | { readonly state: "unavailable" };

interface HydratedComposerDraftRecord {
  readonly draft: ComposerDraft;
  readonly state: AttachmentHydrationState;
  readonly repairedRecord: PersistedComposerDraftRecord | null;
}

function warnAttachmentHydrationFailure(message: string, fileName: string, cause: unknown): void {
  console.warn(
    message,
    new ComposerDraftPersistenceError({
      operation: "hydrate",
      directory: `${COMPOSER_DRAFTS_DIRECTORY}/${COMPOSER_DRAFT_ATTACHMENTS_DIRECTORY}`,
      fileName,
      cause,
    }),
  );
}

async function hydrateAttachment(
  attachment: PersistedAttachmentReference,
  attachmentDirectory: ExpoDirectory,
): Promise<HydratedAttachment> {
  const { File } = await loadExpoFileSystem();
  const fileName = attachmentFileName(attachment.contentHash);
  let file: InstanceType<typeof File>;
  try {
    file = new File(attachmentDirectory, fileName);
    if (!file.exists) {
      warnAttachmentHydrationFailure(
        "[composer-drafts] ignored corrupt persisted attachment",
        fileName,
        new Error("Attachment content file is missing."),
      );
      return { state: "corrupt" };
    }
  } catch (cause) {
    warnAttachmentHydrationFailure(
      "[composer-drafts] persisted attachment is temporarily unavailable",
      fileName,
      cause,
    );
    return { state: "unavailable" };
  }

  let dataUrl: string;
  try {
    dataUrl = await file.text();
  } catch (cause) {
    warnAttachmentHydrationFailure(
      "[composer-drafts] persisted attachment is temporarily unavailable",
      fileName,
      cause,
    );
    return { state: "unavailable" };
  }

  let contentHash: string;
  try {
    contentHash = await hashAttachmentContent(dataUrl);
  } catch (cause) {
    warnAttachmentHydrationFailure(
      "[composer-drafts] persisted attachment is temporarily unavailable",
      fileName,
      cause,
    );
    return { state: "unavailable" };
  }
  if (contentHash !== attachment.contentHash) {
    warnAttachmentHydrationFailure(
      "[composer-drafts] ignored corrupt persisted attachment",
      fileName,
      new Error("Attachment content did not match its persisted hash."),
    );
    return { state: "corrupt" };
  }

  return {
    state: "ok",
    attachment: {
      id: attachment.id,
      type: attachment.type,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataUrl,
      previewUri: dataUrl,
    },
  };
}

async function hydrateRecord(
  record: PersistedComposerDraftRecord,
  attachmentDirectory: ExpoDirectory,
): Promise<HydratedComposerDraftRecord> {
  const results: HydratedAttachment[] = [];
  for (const attachment of record.draft.attachments) {
    results.push(await hydrateAttachment(attachment, attachmentDirectory));
  }
  const attachments = results.flatMap((result) =>
    result.state === "ok" ? [result.attachment] : [],
  );
  const hasUnavailableAttachment = results.some((result) => result.state === "unavailable");
  const hasCorruptAttachment = results.some((result) => result.state === "corrupt");
  const repairedAttachments = record.draft.attachments.filter(
    (_, index) => results[index]?.state !== "corrupt",
  );
  return {
    draft: {
      ...record.draft,
      attachments,
    },
    state: hasUnavailableAttachment ? "unavailable" : hasCorruptAttachment ? "corrupt" : "ok",
    repairedRecord: hasCorruptAttachment
      ? {
          ...record,
          draft: {
            ...record.draft,
            attachments: repairedAttachments,
          },
        }
      : null,
  };
}

async function mapWithConcurrency<Input, Output>(
  values: ReadonlyArray<Input>,
  concurrency: number,
  map: (value: Input) => Promise<Output>,
): Promise<ReadonlyArray<Output>> {
  const results = new Map<number, { readonly value: Output }>();
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results.set(index, { value: await map(values[index]!) });
    }
  });
  await Promise.all(workers);
  return values.map((_, index) => results.get(index)!.value);
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
    const quarantineFileName = `drafts.corrupt-${Date.now()}.json`;
    try {
      file.moveSync(new File(root, quarantineFileName));
      return { drafts: {}, exists: false, valid: false };
    } catch (quarantineCause) {
      console.warn(
        "[composer-drafts] failed to quarantine invalid legacy draft document",
        new ComposerDraftPersistenceError({
          operation: "quarantine",
          directory: COMPOSER_DRAFTS_DIRECTORY,
          fileName: quarantineFileName,
          cause: quarantineCause,
        }),
      );
      return { drafts: {}, exists: true, valid: false };
    }
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
    // Expo's iOS overwrite path removes the destination immediately before the
    // move rather than using an atomic replace. We accept that narrow crash
    // window here: records are isolated per draft and attachment payloads land
    // first, while outbox/share transfer boundaries still require verification.
    temporary.moveSync(destination, { overwrite: true });
    moved = true;
  } finally {
    if (!moved) {
      try {
        if (temporary.exists) {
          temporary.delete();
        }
      } catch (cause) {
        console.warn(
          "[composer-drafts] failed to remove temporary persistence file",
          new ComposerDraftPersistenceError({
            operation: "remove",
            directory: directory.uri,
            fileName: temporary.name,
            cause,
          }),
        );
      }
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
    if (!file.exists) {
      await writeFileAtomically(attachments, fileName, content);
    }
    if (verify) {
      let persisted = await file.text();
      if (persisted !== content) {
        await writeFileAtomically(attachments, fileName, content);
        persisted = await file.text();
      }
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
    if (cause instanceof ComposerDraftPersistenceError) {
      throw cause;
    }
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
  const failures = new Map<string, unknown>();
  for (const draftKey of draftKeys) {
    try {
      const draft = drafts[draftKey];
      if (!draft || isDiscardableDraft(draft)) {
        await removeDraftRecord(draftKey);
        continue;
      }
      const split = await splitComposerDraftForPersistence(
        draftKey,
        draft,
        cachedAttachmentContentHash,
      );
      if (isEmptyPersistedDraft(split.record.draft)) {
        await removeDraftRecord(draftKey);
        continue;
      }
      await writeAttachmentContents(split.attachmentContents, options?.verify === true);
      await writeDraftRecord(split.record, options?.verify === true);
    } catch (error) {
      failures.set(draftKey, error);
    }
  }
  if (options?.sweepAttachments === true) {
    try {
      await sweepOrphanComposerDraftAttachments();
    } catch (error) {
      console.warn("[composer-drafts] failed to sweep orphan attachments", error);
    }
  }
  if (failures.size > 0) {
    throw new ComposerDraftBatchPersistenceError(failures);
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

function isEmptyPersistedDraft(draft: PersistedComposerDraftRecord["draft"]): boolean {
  return (
    draft.text.length === 0 &&
    draft.inputOrigin === undefined &&
    draft.attachments.length === 0 &&
    // Share-import receipts must survive persistence, or an interrupted
    // handoff re-imports the same native share after restart.
    (draft.importedShareIds?.length ?? 0) === 0 &&
    draft.modelSelection === undefined &&
    draft.runtimeMode === undefined &&
    draft.interactionMode === undefined &&
    draft.workspaceSelection === undefined
  );
}

async function repairCorruptRecord(hydrated: HydratedComposerDraftRecord): Promise<void> {
  const repairedRecord = hydrated.repairedRecord;
  if (!repairedRecord) {
    return;
  }
  if (isEmptyPersistedDraft(repairedRecord.draft)) {
    await removeDraftRecord(repairedRecord.draftKey);
    return;
  }
  await writeDraftRecord(repairedRecord, true);
}

export type PersistedComposerDraftHydration =
  | { readonly state: "ready"; readonly draft: ComposerDraft }
  | { readonly state: "unavailable" }
  | { readonly state: "missing" };

export async function hydratePersistedComposerDraftKey(
  draftKey: string,
): Promise<PersistedComposerDraftHydration> {
  const { File } = await loadExpoFileSystem();
  const { records, attachments } = await getStorageDirectories();
  const file = new File(records, draftRecordFileName(draftKey));
  if (!file.exists) {
    return { state: "missing" };
  }
  const raw = await file.text();
  let record: PersistedComposerDraftRecord;
  try {
    record = decodeComposerDraftRecordDocument(JSON.parse(raw) as unknown);
  } catch {
    return { state: "missing" };
  }
  const hydrated = await hydrateRecord(record, attachments);
  if (hydrated.repairedRecord !== null) {
    await repairCorruptRecord(hydrated);
  }
  return hydrated.state === "unavailable"
    ? { state: "unavailable" }
    : { state: "ready", draft: hydrated.draft };
}

export interface LoadedComposerDraftState {
  readonly drafts: Record<string, ComposerDraft>;
  readonly unavailableDraftKeys: ReadonlySet<string>;
}

export async function loadPersistedComposerDraftState(): Promise<LoadedComposerDraftState> {
  const records = await loadRecordDocuments();
  const { attachments: attachmentDirectory } = await getStorageDirectories();
  const hydratedRecords = await mapWithConcurrency(records, 2, async (record) => ({
    draftKey: record.draftKey,
    hydrated: await hydrateRecord(record, attachmentDirectory),
  }));
  const recordDrafts: Record<string, HydratedComposerDraftRecord> = {};
  for (const { draftKey, hydrated } of hydratedRecords) {
    if (!isDiscardableDraft(hydrated.draft) || hydrated.state !== "ok") {
      recordDrafts[draftKey] = hydrated;
    }
  }

  const legacy = await loadLegacyDrafts();
  const drafts: Record<string, ComposerDraft> = { ...legacy.drafts };
  for (const [draftKey, hydrated] of Object.entries(recordDrafts)) {
    if (
      !isDiscardableDraft(hydrated.draft) &&
      (hydrated.state === "ok" || drafts[draftKey] === undefined)
    ) {
      drafts[draftKey] = hydrated.draft;
    }
  }

  const unavailableRecordKeys = new Set(
    Object.entries(recordDrafts)
      .filter(([, hydrated]) => hydrated.state === "unavailable")
      .map(([draftKey]) => draftKey),
  );
  if (legacy.exists && legacy.valid) {
    try {
      const migrationKeys = Object.keys(drafts).filter(
        (draftKey) => !unavailableRecordKeys.has(draftKey),
      );
      if (migrationKeys.length > 0) {
        await persistComposerDraftKeys(drafts, new Set(migrationKeys), { verify: true });
      }
      const hasUnavailableLegacyDraft = Object.keys(legacy.drafts).some((draftKey) =>
        unavailableRecordKeys.has(draftKey),
      );
      if (!hasUnavailableLegacyDraft) {
        await removeLegacyDraftsFile();
      }
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

  for (const hydrated of Object.values(recordDrafts)) {
    const canRepairDirectly =
      hydrated.repairedRecord !== null &&
      (!legacy.exists ||
        !legacy.valid ||
        hydrated.state === "unavailable" ||
        legacy.drafts[hydrated.repairedRecord.draftKey] === undefined);
    if (!canRepairDirectly) {
      continue;
    }
    try {
      await repairCorruptRecord(hydrated);
    } catch (error) {
      console.warn("[composer-drafts] failed to repair corrupt draft record", error);
    }
  }

  if (unavailableRecordKeys.size === 0) {
    try {
      await sweepOrphanComposerDraftAttachments();
    } catch (error) {
      console.warn("[composer-drafts] failed to sweep orphan attachments on load", error);
    }
  }
  return { drafts, unavailableDraftKeys: unavailableRecordKeys };
}

export async function loadPersistedComposerDrafts(): Promise<Record<string, ComposerDraft>> {
  return (await loadPersistedComposerDraftState()).drafts;
}

const STICKY_MODEL_SELECTION_FILE = "sticky-model-selection.json";

const StickyModelSelectionDocumentSchema = Schema.Struct({
  stickyModelSelection: ModelSelectionSchema,
});

const decodeStickyModelSelectionDocument = Schema.decodeUnknownSync(
  StickyModelSelectionDocumentSchema,
);

/**
 * The device-level "last used model", persisted beside the draft records. It is
 * a single value with no per-draft identity, so it gets its own small document
 * rather than a slot in the record store.
 */
export async function loadStickyComposerModelSelection(): Promise<ModelSelection | null> {
  try {
    const { File } = await loadExpoFileSystem();
    const { root } = await getStorageDirectories();
    const file = new File(root, STICKY_MODEL_SELECTION_FILE);
    if (!file.exists) {
      return null;
    }
    const raw = await file.text();
    return decodeStickyModelSelectionDocument(JSON.parse(raw) as unknown).stickyModelSelection;
  } catch (cause) {
    console.warn(
      "[composer-drafts] ignored persisted sticky model selection failure",
      new ComposerDraftPersistenceError({
        operation: "read",
        directory: COMPOSER_DRAFTS_DIRECTORY,
        fileName: STICKY_MODEL_SELECTION_FILE,
        cause,
      }),
    );
    return null;
  }
}

export async function saveStickyComposerModelSelection(
  modelSelection: ModelSelection,
): Promise<void> {
  try {
    const { root } = await getStorageDirectories();
    await writeFileAtomically(
      root,
      STICKY_MODEL_SELECTION_FILE,
      JSON.stringify({
        stickyModelSelection: modelSelection,
      }),
    );
  } catch (cause) {
    throw new ComposerDraftPersistenceError({
      operation: "write",
      directory: COMPOSER_DRAFTS_DIRECTORY,
      fileName: STICKY_MODEL_SELECTION_FILE,
      cause,
    });
  }
}
