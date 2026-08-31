import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { onTestFinished, vi } from "vite-plus/test";

const persistedFiles = new Map<string, string>();
const corruptNextWrite = { value: false };
const failNextMove = { value: false };
const failMovePathFragments = new Set<string>();
const failReadPathFragments = new Set<string>();
const moveAttempts = new Map<string, number>();
const readGate: {
  uri: string | null;
  promise: Promise<void> | null;
  notifyStarted: (() => void) | null;
} = { uri: null, promise: null, notifyStarted: null };
const hashGate: {
  promise: Promise<void> | null;
  notifyStarted: (() => void) | null;
} = { promise: null, notifyStarted: null };

vi.mock("expo-file-system", () => {
  class File {
    uri: string;

    constructor(directory: { uri: string }, name: string) {
      this.uri = `${directory.uri}/${name}`;
    }

    get name(): string {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }

    get exists(): boolean {
      return persistedFiles.has(this.uri);
    }

    get size(): number {
      return persistedFiles.get(this.uri)?.length ?? 0;
    }

    create(options?: { readonly overwrite?: boolean }): void {
      if (this.exists && options?.overwrite !== true) {
        throw new Error(`file already exists: ${this.uri}`);
      }
      persistedFiles.set(this.uri, "");
    }

    write(value: string): void {
      persistedFiles.set(this.uri, corruptNextWrite.value ? `${value.slice(0, 8)}!` : value);
      corruptNextWrite.value = false;
    }

    delete(): void {
      persistedFiles.delete(this.uri);
    }

    moveSync(destination: { uri: string }, options?: { readonly overwrite?: boolean }): void {
      moveAttempts.set(destination.uri, (moveAttempts.get(destination.uri) ?? 0) + 1);
      if (
        failNextMove.value ||
        [...failMovePathFragments].some((fragment) => destination.uri.includes(fragment))
      ) {
        failNextMove.value = false;
        throw new Error("move failed");
      }
      if (persistedFiles.has(destination.uri) && options?.overwrite !== true) {
        throw new Error(`destination already exists: ${destination.uri}`);
      }
      const content = persistedFiles.get(this.uri) ?? "";
      persistedFiles.delete(this.uri);
      persistedFiles.set(destination.uri, content);
      this.uri = destination.uri;
    }

    async text(): Promise<string> {
      if ([...failReadPathFragments].some((fragment) => this.uri.includes(fragment))) {
        throw new Error(`read failed: ${this.uri}`);
      }
      if (readGate.uri === this.uri) {
        readGate.notifyStarted?.();
        if (readGate.promise) {
          await readGate.promise;
        }
      }
      return persistedFiles.get(this.uri) ?? "";
    }
  }

  class Directory {
    uri: string;

    constructor(base: string | { uri: string }, name: string) {
      this.uri = `${typeof base === "string" ? base : base.uri}/${name}`;
    }

    create(): void {}

    list(): ReadonlyArray<File> {
      const prefix = `${this.uri}/`;
      return [...persistedFiles.keys()]
        .filter((uri) => uri.startsWith(prefix) && !uri.slice(prefix.length).includes("/"))
        .map((uri) => new File(this, uri.slice(prefix.length)));
    }
  }

  return {
    Paths: { document: "file:///document" },
    Directory,
    File,
  };
});

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, value: string) => {
    hashGate.notifyStarted?.();
    if (hashGate.promise) {
      await hashGate.promise;
    }
    return [...value]
      .reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0)
      .toString(16)
      .padStart(64, "0");
  },
}));

const composerAttachmentCleanupMocks = vi.hoisted(() => ({
  remove: vi.fn(async () => undefined),
  releaseUploads: vi.fn(async () => undefined),
}));

const incomingShareStorageMocks = vi.hoisted(() => ({
  load: vi.fn<typeof import("../features/sharing/incoming-share-storage").loadIncomingShareDrafts>(
    async () => [],
  ),
}));

vi.mock("../lib/composerImages", () => ({
  removePersistedComposerAttachmentFile: composerAttachmentCleanupMocks.remove,
}));

vi.mock("../lib/attachmentUpload", () => ({
  releasePendingAttachmentUploads: composerAttachmentCleanupMocks.releaseUploads,
}));

vi.mock("../features/sharing/incoming-share-storage", () => ({
  loadIncomingShareDrafts: incomingShareStorageMocks.load,
}));

import { appAtomRegistry } from "./atom-registry";
import { threadOutboxManager } from "./thread-outbox";
import {
  appendedComposerDraftText,
  appendComposerDraftAttachments,
  appendComposerDraftContentDurably,
  clearComposerDraft,
  clearComposerDraftContentIfUnchangedState,
  clearComposerDraftContentState,
  composerDraftStillContainsAppend,
  composerDraftsAtom,
  copyComposerDraftContentIfEmpty,
  copyComposerDraftContentState,
  decodePersistedComposerDrafts,
  ensureComposerDraftsLoaded,
  flushComposerDrafts,
  type ComposerDraft,
  getComposerDraftSnapshot,
  hasUnpersistedComposerDrafts,
  mergeComposerDraftContentState,
  mergeHydratedComposerDrafts,
  releaseUnusedComposerAttachmentFiles,
  removeComposerDraftAttachment,
  removeComposerDraftsForEnvironment,
  replaceComposerDraftAttachments,
  resetComposerDraftPersistenceForTests,
  resetComposerDraftsLoadState,
  revertComposerDraftAppend,
  restoreComposerDraftSnapshot,
  restoreComposerDraftSnapshotState,
  setComposerDraftText,
  setStickyComposerModelSelection,
  stickyComposerModelSelectionAtom,
  undoComposerDraftMerge,
  undoComposerDraftMergeState,
} from "./use-composer-drafts";

const DRAFT: ComposerDraft = {
  text: "hello",
  attachments: [],
};

function testContentHash(value: string): string {
  return [...value]
    .reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0)
    .toString(16)
    .padStart(64, "0");
}

function testImage(id: string, dataUrl: string) {
  return {
    id,
    type: "image" as const,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 3,
    dataUrl,
    previewUri: dataUrl,
  };
}

function draftRecordPath(draftKey: string): string {
  return `file:///document/composer-drafts/drafts/${encodeURIComponent(draftKey)}.json`;
}

function attachmentPath(contentHash: string): string {
  return `file:///document/composer-drafts/attachments/${contentHash}.attachment`;
}

function seedPartiallyAvailableDraft(draftKey: string): {
  readonly available: ReturnType<typeof testImage>;
  readonly unavailable: ReturnType<typeof testImage>;
  readonly recordPath: string;
  readonly unavailablePath: string;
} {
  const available = testImage("available", "data:image/png;base64,YWJj");
  const unavailable = testImage("unavailable", "data:image/png;base64,ZGVm");
  const availableHash = testContentHash(available.dataUrl);
  const unavailableHash = testContentHash(unavailable.dataUrl);
  const recordPath = draftRecordPath(draftKey);
  const unavailablePath = attachmentPath(unavailableHash);
  persistedFiles.set(
    recordPath,
    JSON.stringify({
      schemaVersion: 2,
      draftKey,
      draft: {
        text: "draft",
        attachments: [
          {
            id: available.id,
            type: available.type,
            name: available.name,
            mimeType: available.mimeType,
            sizeBytes: available.sizeBytes,
            contentHash: availableHash,
          },
          {
            id: unavailable.id,
            type: unavailable.type,
            name: unavailable.name,
            mimeType: unavailable.mimeType,
            sizeBytes: unavailable.sizeBytes,
            contentHash: unavailableHash,
          },
        ],
      },
    }),
  );
  persistedFiles.set(attachmentPath(availableHash), available.dataUrl);
  persistedFiles.set(unavailablePath, unavailable.dataUrl);
  failReadPathFragments.add(`${unavailableHash}.attachment`);
  return { available, unavailable, recordPath, unavailablePath };
}

function persistedAttachmentIds(recordPath: string): ReadonlyArray<string> {
  const record = JSON.parse(persistedFiles.get(recordPath) ?? "null") as {
    readonly draft?: { readonly attachments?: ReadonlyArray<{ readonly id?: string }> };
  } | null;
  return (
    record?.draft?.attachments?.flatMap((attachment) =>
      attachment.id === undefined ? [] : [attachment.id],
    ) ?? []
  );
}

afterEach(() => {
  resetComposerDraftPersistenceForTests();
  resetComposerDraftsLoadState();
  vi.useRealTimers();
  appAtomRegistry.set(composerDraftsAtom, {});
  appAtomRegistry.set(stickyComposerModelSelectionAtom, null);
  persistedFiles.clear();
  corruptNextWrite.value = false;
  failNextMove.value = false;
  failMovePathFragments.clear();
  failReadPathFragments.clear();
  moveAttempts.clear();
  readGate.uri = null;
  readGate.promise = null;
  readGate.notifyStarted = null;
  hashGate.promise = null;
  hashGate.notifyStarted = null;
  appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
  composerAttachmentCleanupMocks.remove.mockClear();
  composerAttachmentCleanupMocks.releaseUploads.mockReset();
  composerAttachmentCleanupMocks.releaseUploads.mockResolvedValue(undefined);
  incomingShareStorageMocks.load.mockReset();
  incomingShareStorageMocks.load.mockResolvedValue([]);
});

describe("mobile composer drafts", () => {
  it("hydrates generic file attachments from their saved local paths", () => {
    const file = {
      id: "file-1",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/report.pdf",
    };

    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": { text: "Review this file", attachments: [file] },
        },
      }),
    ).toEqual({
      "environment-1:thread-1": { text: "Review this file", attachments: [file] },
    });
  });

  it("releases videos rejected by the live draft limit and keeps accepted files", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const cleanup = Promise.withResolvers<void>();
    composerAttachmentCleanupMocks.remove.mockImplementationOnce(async () => {
      cleanup.resolve();
    });
    const makeAttachment = (id: string) => ({
      id,
      type: "file" as const,
      name: `${id}.mov`,
      mimeType: "video/quicktime",
      sizeBytes: 42,
      fileUri: `file:///documents/t3-composer-attachments/${id}.mov`,
    });
    const draftKey = "new-task:environment-1:project-cap";
    const existing = Array.from({ length: 7 }, (_, index) => makeAttachment(`held-${index}`));
    appAtomRegistry.set(composerDraftsAtom, {
      [draftKey]: { text: "send this", attachments: existing },
    });

    const rejected = appendComposerDraftAttachments(draftKey, [
      makeAttachment("incoming-1"),
      makeAttachment("incoming-2"),
    ]);

    expect(rejected).toBe(1);
    const draft = appAtomRegistry.get(composerDraftsAtom)[draftKey];
    expect(draft?.attachments).toHaveLength(8);
    expect(draft?.attachments.at(-1)?.id).toBe("incoming-1");
    await cleanup.promise;
    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledExactlyOnceWith(
      makeAttachment("incoming-2").fileUri,
    );

    // Restore paths bypass the cap so a failed send never drops its files.
    const overflowRejected = appendComposerDraftAttachments(
      draftKey,
      [makeAttachment("restored-1")],
      { allowOverflow: true },
    );
    expect(overflowRejected).toBe(0);
    expect(appAtomRegistry.get(composerDraftsAtom)[draftKey]?.attachments).toHaveLength(9);
  });

  it("keeps shared attachment files until every draft releases them", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const file = {
      id: "file-1",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    appAtomRegistry.set(composerDraftsAtom, {
      source: { text: "First draft", attachments: [file] },
      copied: { text: "Second draft", attachments: [file] },
    });

    await releaseUnusedComposerAttachmentFiles([file]);
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

    appAtomRegistry.set(composerDraftsAtom, {
      copied: { text: "Second draft", attachments: [file] },
    });
    await releaseUnusedComposerAttachmentFiles([file]);
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

    appAtomRegistry.set(composerDraftsAtom, {});
    await releaseUnusedComposerAttachmentFiles([file]);
    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(file.fileUri);
  });

  it("keeps a failed-send draft's pending upload for retry", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const file = {
      id: "file-failed-send",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/failed-send.pdf",
      uploadedAttachmentId: "pending-failed-send",
      uploadEnvironmentId: EnvironmentId.make("environment-1"),
    };
    appAtomRegistry.set(composerDraftsAtom, {
      "environment-1:thread-1": { text: "Retry this send", attachments: [file] },
    });

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    expect(composerAttachmentCleanupMocks.releaseUploads).not.toHaveBeenCalled();
  });

  it("removes an unreferenced local file and its pending upload", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const environmentId = EnvironmentId.make("environment-1");
    const file = {
      id: "file-discarded",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/discarded.pdf",
      uploadedAttachmentId: "pending-discarded",
      uploadEnvironmentId: environmentId,
    };

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(file.fileUri);
    expect(composerAttachmentCleanupMocks.releaseUploads).toHaveBeenCalledWith(environmentId, [
      "pending-discarded",
    ]);
  });

  it("keeps a pending upload referenced through another local file", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const environmentId = EnvironmentId.make("environment-1");
    const discarded = {
      id: "file-discarded-copy",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/discarded-copy.pdf",
      uploadedAttachmentId: "pending-shared",
      uploadEnvironmentId: environmentId,
    };
    const retained = {
      ...discarded,
      id: "file-retained-copy",
      fileUri: "file:///documents/t3-composer-attachments/retained-copy.pdf",
    };
    appAtomRegistry.set(composerDraftsAtom, {
      "environment-1:thread-1": { text: "Keep this copy", attachments: [retained] },
    });

    await releaseUnusedComposerAttachmentFiles([discarded]);

    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(discarded.fileUri);
    expect(composerAttachmentCleanupMocks.releaseUploads).not.toHaveBeenCalled();
  });

  it("completes local cleanup when pending upload deletion fails", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    onTestFinished(() => warning.mockRestore());
    composerAttachmentCleanupMocks.releaseUploads.mockRejectedValueOnce(
      new Error("environment disconnected"),
    );
    const file = {
      id: "file-delete-failed",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/delete-failed.pdf",
      uploadedAttachmentId: "pending-delete-failed",
      uploadEnvironmentId: EnvironmentId.make("environment-1"),
    };

    await expect(releaseUnusedComposerAttachmentFiles([file])).resolves.toBeUndefined();

    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(file.fileUri);
    expect(warning).toHaveBeenCalledWith(
      "[composer-attachments] could not remove pending upload",
      expect.objectContaining({ attachmentId: "pending-delete-failed" }),
    );
  });

  it("keeps local attachment files while an outbox message still needs them", async () => {
    const file = {
      id: "file-queued",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
      "environment-1:thread-1": [
        {
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          commandId: CommandId.make("command-1"),
          text: "Review the report",
          attachments: [file],
          createdAt: "2026-08-24T12:00:00.000Z",
        },
      ],
    });

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
  });

  it("loads persisted outbox messages before deciding an attachment file is unused", async () => {
    const file = {
      id: "file-persisted",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    const load = vi.spyOn(threadOutboxManager, "load").mockImplementation(async () => {
      appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
        "environment-1:thread-1": [
          {
            environmentId: EnvironmentId.make("environment-1"),
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("message-persisted"),
            commandId: CommandId.make("command-persisted"),
            text: "Review the report",
            attachments: [file],
            createdAt: "2026-08-24T12:00:00.000Z",
          },
        ],
      });
      return true;
    });

    try {
      await releaseUnusedComposerAttachmentFiles([file]);

      expect(load).toHaveBeenCalledOnce();
      expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it("keeps a file until its incoming share is consumed", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const file = {
      id: "file-incoming",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/incoming.pdf",
    };
    incomingShareStorageMocks.load
      .mockResolvedValueOnce([
        {
          schemaVersion: 1,
          id: "share-1",
          createdAt: "2026-08-28T12:00:00.000Z",
          text: "Review this file",
          attachments: [file],
          warnings: [],
        },
      ])
      .mockResolvedValueOnce([]);

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(incomingShareStorageMocks.load).toHaveBeenLastCalledWith({ strict: true });
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(incomingShareStorageMocks.load).toHaveBeenCalledTimes(2);
    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(file.fileUri);
  });

  it("does not delete files when incoming share ownership cannot be loaded", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const file = {
      id: "file-incoming-unknown",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/incoming-unknown.pdf",
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    incomingShareStorageMocks.load.mockRejectedValueOnce(new Error("inbox unavailable"));
    onTestFinished(() => warning.mockRestore());

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(incomingShareStorageMocks.load).toHaveBeenCalledWith({ strict: true });
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
  });

  it.each(["draft", "outbox", "inbox"] as const)(
    "preserves relocated files still referenced by a persisted %s",
    async (owner) => {
      const fileName = "33333333-3333-4333-8333-333333333333-report.pdf";
      const oldFile = {
        id: "file-relocated",
        type: "file" as const,
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        fileUri: `file:///private/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/${fileName}`,
      };
      const currentFile = {
        ...oldFile,
        fileUri: `file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents/t3-composer-attachments/${fileName}`,
      };
      const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
      onTestFinished(() => outboxLoad.mockRestore());
      if (owner === "draft") {
        const draftKey = "environment-1:thread-1";
        persistedFiles.set(
          draftRecordPath(draftKey),
          JSON.stringify({
            schemaVersion: 2,
            draftKey,
            draft: { text: "Saved draft", attachments: [oldFile] },
          }),
        );
        resetComposerDraftsLoadState();
      } else if (owner === "outbox") {
        outboxLoad.mockImplementation(async () => {
          appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
            "environment-1:thread-1": [
              {
                environmentId: EnvironmentId.make("environment-1"),
                threadId: ThreadId.make("thread-1"),
                messageId: MessageId.make("message-relocated"),
                commandId: CommandId.make("command-relocated"),
                text: "Queued draft",
                attachments: [oldFile],
                createdAt: "2026-08-28T12:00:00.000Z",
              },
            ],
          });
          return true;
        });
      } else {
        incomingShareStorageMocks.load.mockResolvedValue([
          {
            schemaVersion: 1,
            id: "share-relocated",
            createdAt: "2026-08-28T12:00:00.000Z",
            text: "Incoming file",
            attachments: [oldFile],
            warnings: [],
          },
        ]);
      }

      await releaseUnusedComposerAttachmentFiles([currentFile]);

      expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

      appAtomRegistry.set(composerDraftsAtom, {});
      appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
      outboxLoad.mockResolvedValue(true);
      incomingShareStorageMocks.load.mockResolvedValue([]);
      await releaseUnusedComposerAttachmentFiles([currentFile]);

      expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(currentFile.fileUri);
    },
  );

  it("does not delete attachment files when the draft removal cannot be saved", async () => {
    const file = {
      id: "file-unsaved",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    const draftKey = "environment-1:thread-1";
    failMovePathFragments.add(encodeURIComponent(draftKey));
    setComposerDraftText(draftKey, "Unsaved draft");

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(hasUnpersistedComposerDrafts()).toBe(true);
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    failMovePathFragments.clear();
  });

  it("hydrates selector state even when the message content is empty", () => {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "new-task:environment-1:project-1": {
            text: "",
            attachments: [],
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "xhigh" }],
            },
            runtimeMode: "approval-required",
            interactionMode: "plan",
            workspaceSelection: {
              mode: "worktree",
              branch: "main",
              worktreePath: null,
            },
          },
        },
      }),
    ).toEqual({
      "new-task:environment-1:project-1": {
        text: "",
        attachments: [],
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        workspaceSelection: {
          mode: "worktree",
          branch: "main",
          worktreePath: null,
        },
      },
    });
  });

  it("strips legacy setting fields from hydrated existing-thread drafts", () => {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    };

    expect(
      mergeHydratedComposerDrafts(
        {
          "environment-1:thread-with-content": {
            text: "legacy content",
            attachments: [],
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "plan",
          },
          "environment-1:thread-settings-only": {
            text: "",
            attachments: [],
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "plan",
          },
          // A model beside another selector setting is a deliberate
          // configuration; only a BARE model is the stale seed the
          // hydration strip removes (covered by its own test above).
          "new-task:environment-1:project-1": {
            text: "",
            attachments: [],
            modelSelection,
            runtimeMode: "approval-required",
          },
        },
        {},
        new Set(),
      ),
    ).toEqual({
      "environment-1:thread-with-content": {
        text: "legacy content",
        attachments: [],
      },
      "new-task:environment-1:project-1": {
        text: "",
        attachments: [],
        modelSelection,
        runtimeMode: "approval-required",
      },
    });
  });

  it("keeps legacy content-only drafts and rejects invalid selector state", () => {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": DRAFT,
        },
      }),
    ).toEqual({
      "environment-1:thread-1": DRAFT,
    });

    expect(() =>
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": {
            ...DRAFT,
            runtimeMode: "sometimes-safe",
          },
        },
      }),
    ).toThrow();
  });

  it("keeps share-import receipts on otherwise contentless drafts at hydration", () => {
    const receiptDraft: ComposerDraft = {
      text: "",
      attachments: [],
      importedShareIds: ["share-1"],
    };
    // The empty-draft filter must keep receipt-bearing drafts — or the same
    // native share would re-import after restart.
    expect(
      mergeHydratedComposerDrafts(
        { "new-task:environment-1:project-1": receiptDraft },
        {},
        new Set(),
      ),
    ).toEqual({ "new-task:environment-1:project-1": receiptDraft });
  });

  it("strips a stale bare model selection from hydrated new-task drafts", () => {
    // Builds before the model-precedence fix left contentless new-task drafts
    // carrying only a modelSelection; hydration re-resolves defaults instead.
    const bare: ComposerDraft = {
      text: "",
      attachments: [],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    };
    expect(
      mergeHydratedComposerDrafts({ "new-task:environment-1:project-1": bare }, {}, new Set()),
    ).toEqual({});

    const configured: ComposerDraft = { ...bare, runtimeMode: "approval-required" };
    expect(
      mergeHydratedComposerDrafts(
        { "new-task:environment-1:project-1": configured },
        {},
        new Set(),
      ),
    ).toEqual({ "new-task:environment-1:project-1": configured });
  });

  it("persists and hydrates the sticky model selection", async () => {
    setStickyComposerModelSelection({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    });
    await flushComposerDrafts();

    appAtomRegistry.set(stickyComposerModelSelectionAtom, null);
    resetComposerDraftPersistenceForTests();
    resetComposerDraftsLoadState();
    ensureComposerDraftsLoaded();
    await flushComposerDrafts();

    expect(appAtomRegistry.get(stickyComposerModelSelectionAtom)).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("clears sent content and staged setting fields for an existing thread", () => {
    const draftKey = "environment-1:thread-1";
    const draft: ComposerDraft = {
      text: "send this",
      attachments: [],
      importedShareIds: ["share-1"],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      workspaceSelection: {
        mode: "worktree",
        branch: "main",
        worktreePath: null,
      },
    };

    expect(clearComposerDraftContentState({ [draftKey]: draft }, draftKey)).toEqual({
      [draftKey]: {
        workspaceSelection: draft.workspaceSelection,
        text: "",
        attachments: [],
      },
    });
  });

  it("retains setting fields for new-task and pending-task drafts", () => {
    const settings = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
    };

    for (const draftKey of ["new-task:environment-1:project-1", "pending-task:message-1"]) {
      expect(
        clearComposerDraftContentState(
          {
            [draftKey]: {
              text: "send this",
              attachments: [],
              ...settings,
            },
          },
          draftKey,
        ),
      ).toEqual({
        [draftKey]: {
          ...settings,
          text: "",
          attachments: [],
        },
      });
    }
  });

  it("clears content only while it still matches the submitted snapshot", () => {
    const draftKey = "environment-1:thread-1";
    const submitted: ComposerDraft = { text: "/t3-rename New title", attachments: [] };
    const newer: ComposerDraft = { ...submitted, text: "A newer message" };
    const attachmentsChanged: ComposerDraft = { ...submitted, attachments: [] };

    expect(
      clearComposerDraftContentIfUnchangedState({ [draftKey]: submitted }, draftKey, submitted),
    ).toEqual({});
    expect(
      clearComposerDraftContentIfUnchangedState({ [draftKey]: newer }, draftKey, submitted),
    ).toEqual({ [draftKey]: newer });
    expect(
      clearComposerDraftContentIfUnchangedState(
        { [draftKey]: attachmentsChanged },
        draftKey,
        submitted,
      ),
    ).toEqual({ [draftKey]: attachmentsChanged });
  });

  it("drops draft-local model and workspace selections after sending a new task", () => {
    const draftKey = "new-task:environment-1:project-1";
    const draft: ComposerDraft = {
      text: "send this",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      workspaceSelection: {
        mode: "worktree",
        branch: "main",
        worktreePath: null,
        startFromOrigin: false,
      },
    };

    expect(
      clearComposerDraftContentState({ [draftKey]: draft }, draftKey, {
        clearModelSelection: true,
        clearWorkspaceSelection: true,
      }),
    ).toEqual({});
  });

  it("reads the latest selector state synchronously for send", () => {
    const draftKey = "environment-1:thread-1";
    const selectedDraft: ComposerDraft = {
      text: "send this",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    };
    appAtomRegistry.set(composerDraftsAtom, { [draftKey]: selectedDraft });

    expect(getComposerDraftSnapshot(draftKey)).toEqual(selectedDraft);
  });

  it("carries unfinished content to a newly selected project without overwriting its settings", () => {
    const sourceKey = "new-task:environment-1:project-1";
    const targetKey = "new-task:environment-1:project-2";
    const source: ComposerDraft = {
      text: "Keep this task",
      attachments: [],
      importedShareIds: ["share-1"],
      workspaceSelection: {
        mode: "worktree",
        branch: "feature/source",
        worktreePath: null,
      },
    };
    const target: ComposerDraft = {
      text: "",
      attachments: [],
      runtimeMode: "approval-required",
    };

    expect(
      copyComposerDraftContentState(
        { [sourceKey]: source, [targetKey]: target },
        sourceKey,
        targetKey,
      ),
    ).toEqual({
      [sourceKey]: source,
      [targetKey]: {
        ...target,
        text: source.text,
        attachments: source.attachments,
        importedShareIds: source.importedShareIds,
      },
    });
  });

  it("does not overwrite unfinished content already stored for the selected project", () => {
    const sourceKey = "new-task:environment-1:project-1";
    const targetKey = "new-task:environment-1:project-2";
    const drafts: Record<string, ComposerDraft> = {
      [sourceKey]: { text: "Source task", attachments: [] },
      [targetKey]: { text: "Target task", attachments: [] },
    };

    expect(copyComposerDraftContentState(drafts, sourceKey, targetKey)).toBe(drafts);
  });

  it("merges shared content into a project draft without duplicating retries", () => {
    const draftKey = "new-task:environment-1:project-1";
    const sharedAttachment = {
      id: "share-1:image:0",
      type: "image" as const,
      name: "Screenshot.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
      previewUri: "data:image/png;base64,YWJj",
    };
    const existing: Record<string, ComposerDraft> = {
      [draftKey]: { text: "Existing context", attachments: [] },
    };
    const content = {
      text: "Shared note",
      attachments: [sharedAttachment],
      sourceShareId: "share-1",
    };

    const merged = mergeComposerDraftContentState(existing, draftKey, content);
    expect(merged[draftKey]).toMatchObject({
      text: "Existing context\n\nShared note",
      attachments: [sharedAttachment],
      importedShareIds: ["share-1"],
    });
    expect(mergeComposerDraftContentState(merged, draftKey, content)).toBe(merged);

    const edited = {
      ...merged,
      [draftKey]: { ...merged[draftKey]!, text: "User edited the imported context" },
    };
    expect(mergeComposerDraftContentState(edited, draftKey, content)).toBe(edited);
  });

  it("preserves existing images when shared content exceeds the draft attachment limit", () => {
    const draftKey = "new-task:environment-1:project-1";
    const image = (id: string) => ({
      id,
      type: "image" as const,
      name: `${id}.png`,
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
      previewUri: "data:image/png;base64,YWJj",
    });
    const existingImage = image("existing");
    const sharedImages = Array.from({ length: 8 }, (_, index) => image(`shared-${index}`));

    const merged = mergeComposerDraftContentState(
      { [draftKey]: { text: "", attachments: [existingImage] } },
      draftKey,
      { text: "", attachments: sharedImages },
    );

    expect(merged[draftKey]?.attachments).toHaveLength(8);
    expect(merged[draftKey]?.attachments[0]).toEqual(existingImage);
    expect(merged[draftKey]?.attachments.at(-1)?.id).toBe("shared-6");
  });

  it("restores the exact draft captured before an interrupted share import", () => {
    const draftKey = "new-task:environment-1:project-1";
    const beforeImport: ComposerDraft = {
      text: "Existing context",
      attachments: [],
      runtimeMode: "approval-required",
    };
    const imported: ComposerDraft = {
      ...beforeImport,
      text: "Existing context\n\nShared note",
      importedShareIds: ["share-1"],
    };

    expect(
      restoreComposerDraftSnapshotState({ [draftKey]: imported }, draftKey, beforeImport),
    ).toEqual({ [draftKey]: beforeImport });
    expect(
      restoreComposerDraftSnapshotState({ [draftKey]: imported }, draftKey, {
        text: "",
        attachments: [],
      }),
    ).toEqual({});
  });

  it("removes only drafts owned by the selected environment", () => {
    const environmentId = EnvironmentId.make("environment-cloud");
    const retainedEnvironmentId = EnvironmentId.make("environment-local");

    expect(
      removeComposerDraftsForEnvironment(
        {
          [`${environmentId}:thread-cloud`]: DRAFT,
          [`new-task:${environmentId}:project-cloud`]: DRAFT,
          [`${retainedEnvironmentId}:thread-local`]: DRAFT,
          [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
        },
        environmentId,
      ),
    ).toEqual({
      [`${retainedEnvironmentId}:thread-local`]: DRAFT,
      [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
    });
  });

  it("preserves unavailable attachment references across text edits until recovery", async () => {
    const draftKey = "environment-1:thread-partial-edit";
    const dataUrl = "data:image/png;base64,YWJj";
    const contentHash = testContentHash(dataUrl);
    const recordPath = `file:///document/composer-drafts/drafts/${encodeURIComponent(draftKey)}.json`;
    const attachmentPath = `file:///document/composer-drafts/attachments/${contentHash}.attachment`;
    const record = {
      schemaVersion: 2,
      draftKey,
      draft: {
        text: "before",
        attachments: [
          {
            id: "persisted-image",
            type: "image",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 3,
            contentHash,
          },
        ],
      },
    };
    persistedFiles.set(recordPath, JSON.stringify(record));
    persistedFiles.set(attachmentPath, dataUrl);
    failReadPathFragments.add(`${contentHash}.attachment`);

    ensureComposerDraftsLoaded();
    await flushComposerDrafts();
    expect(getComposerDraftSnapshot(draftKey)).toEqual({ text: "before", attachments: [] });

    setComposerDraftText(draftKey, "edited while unavailable");
    await flushComposerDrafts();
    expect(JSON.parse(persistedFiles.get(recordPath) ?? "null")).toEqual(record);

    failReadPathFragments.clear();
    await flushComposerDrafts();

    expect(getComposerDraftSnapshot(draftKey)).toEqual({
      text: "edited while unavailable",
      attachments: [
        {
          id: "persisted-image",
          type: "image",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataUrl,
          previewUri: dataUrl,
        },
      ],
    });
    expect(JSON.parse(persistedFiles.get(recordPath) ?? "null")).toMatchObject({
      draft: {
        text: "edited while unavailable",
        attachments: [{ contentHash }],
      },
    });
  });

  it("keeps an unavailable attachment when a different attachment is removed", async () => {
    const draftKey = "environment-1:thread-partial-remove";
    const seeded = seedPartiallyAvailableDraft(draftKey);

    ensureComposerDraftsLoaded();
    await flushComposerDrafts();
    expect(getComposerDraftSnapshot(draftKey).attachments).toEqual([seeded.available]);

    removeComposerDraftAttachment(draftKey, seeded.available.id);
    await flushComposerDrafts();
    expect(persistedAttachmentIds(seeded.recordPath)).toEqual([
      seeded.available.id,
      seeded.unavailable.id,
    ]);
    expect(persistedFiles.has(seeded.unavailablePath)).toBe(true);

    failReadPathFragments.clear();
    await flushComposerDrafts();
    expect(getComposerDraftSnapshot(draftKey).attachments).toEqual([seeded.unavailable]);
    expect(persistedAttachmentIds(seeded.recordPath)).toEqual([seeded.unavailable.id]);
    expect(persistedFiles.has(seeded.unavailablePath)).toBe(true);
  });

  it("recovers unavailable attachments around replace, revert, and restore operations", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly mutate: (
        draftKey: string,
        available: ReturnType<typeof testImage>,
        replacement: ReturnType<typeof testImage>,
      ) => Promise<void>;
    }> = [
      {
        name: "replace",
        mutate: async (draftKey, _available, replacement) => {
          replaceComposerDraftAttachments(draftKey, [replacement]);
          await flushComposerDrafts();
        },
      },
      {
        name: "revert",
        mutate: async (draftKey) => {
          const available = getComposerDraftSnapshot(draftKey).attachments[0]!;
          await revertComposerDraftAppend(draftKey, {
            before: { text: "draft", attachments: [] },
            appended: { text: "draft", attachments: [available] },
          });
        },
      },
      {
        name: "restore",
        mutate: async (draftKey, _available, replacement) => {
          await expect(
            restoreComposerDraftSnapshot(draftKey, {
              text: "restored",
              attachments: [replacement],
            }),
          ).rejects.toThrow();
        },
      },
    ];

    for (const testCase of cases) {
      resetComposerDraftPersistenceForTests();
      appAtomRegistry.set(composerDraftsAtom, {});
      persistedFiles.clear();
      failReadPathFragments.clear();
      const draftKey = `environment-1:thread-partial-${testCase.name}`;
      const seeded = seedPartiallyAvailableDraft(draftKey);
      const replacement = testImage(
        `replacement-${testCase.name}`,
        `data:image/png;base64,${testCase.name}`,
      );

      ensureComposerDraftsLoaded();
      await flushComposerDrafts();
      await testCase.mutate(draftKey, seeded.available, replacement);
      expect(persistedAttachmentIds(seeded.recordPath)).toEqual([
        seeded.available.id,
        seeded.unavailable.id,
      ]);
      expect(persistedFiles.has(seeded.unavailablePath)).toBe(true);

      failReadPathFragments.clear();
      await flushComposerDrafts();
      expect(
        getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
      ).toEqual([seeded.unavailable.id, ...(testCase.name === "revert" ? [] : [replacement.id])]);
      expect(persistedAttachmentIds(seeded.recordPath)).toEqual([
        seeded.unavailable.id,
        ...(testCase.name === "revert" ? [] : [replacement.id]),
      ]);
    }
  });

  it("caps recovered attachments while preserving eight user-visible attachments", async () => {
    const draftKey = "environment-1:thread-partial-cap";
    const seeded = seedPartiallyAvailableDraft(draftKey);
    const replacements = Array.from({ length: 8 }, (_, index) =>
      testImage(`replacement-${index}`, `data:image/png;base64,replacement-${index}`),
    );

    ensureComposerDraftsLoaded();
    await flushComposerDrafts();
    replaceComposerDraftAttachments(draftKey, replacements);
    await flushComposerDrafts();

    failReadPathFragments.clear();
    await flushComposerDrafts();

    expect(getComposerDraftSnapshot(draftKey).attachments).toEqual(replacements);
    expect(persistedAttachmentIds(seeded.recordPath)).toEqual(
      replacements.map((attachment) => attachment.id),
    );
    expect(persistedFiles.has(seeded.unavailablePath)).toBe(false);
  });

  it("allows an explicit clear to remove unavailable attachment references", async () => {
    const draftKey = "environment-1:thread-partial-clear";
    const dataUrl = "data:image/png;base64,YWJj";
    const contentHash = testContentHash(dataUrl);
    const recordPath = `file:///document/composer-drafts/drafts/${encodeURIComponent(draftKey)}.json`;
    persistedFiles.set(
      recordPath,
      JSON.stringify({
        schemaVersion: 2,
        draftKey,
        draft: {
          text: "clear me",
          attachments: [
            {
              id: "persisted-image",
              type: "image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 3,
              contentHash,
            },
          ],
        },
      }),
    );
    persistedFiles.set(
      `file:///document/composer-drafts/attachments/${contentHash}.attachment`,
      dataUrl,
    );
    failReadPathFragments.add(`${contentHash}.attachment`);

    ensureComposerDraftsLoaded();
    await flushComposerDrafts();
    clearComposerDraft(draftKey);
    await flushComposerDrafts();

    expect(persistedFiles.has(recordPath)).toBe(false);
  });

  it("does not resurrect a draft cleared while hydration is reading it", async () => {
    const draftKey = "environment-1:thread-hydrating";
    const legacyPath = "file:///document/composer-drafts/drafts.json";
    persistedFiles.set(
      legacyPath,
      JSON.stringify({ schemaVersion: 1, drafts: { [draftKey]: DRAFT } }),
    );
    let releaseRead: () => void = () => undefined;
    readGate.uri = legacyPath;
    readGate.promise = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      readGate.notifyStarted = resolve;
    });

    ensureComposerDraftsLoaded();
    await readStarted;
    clearComposerDraft(draftKey);
    releaseRead();
    await flushComposerDrafts();

    expect(appAtomRegistry.get(composerDraftsAtom)[draftKey]).toBeUndefined();
    expect(
      persistedFiles.has(
        `file:///document/composer-drafts/drafts/${encodeURIComponent(draftKey)}.json`,
      ),
    ).toBe(false);
  });

  it("waits for persisted drafts before copying content between projects", async () => {
    const sourceKey = "new-task:environment-1:project-1";
    const targetKey = "new-task:environment-1:project-2";
    const unrelatedKey = "environment-1:thread-1";
    const source = { text: "Current task", attachments: [] } satisfies ComposerDraft;
    const target = { text: "Persisted target", attachments: [] } satisfies ComposerDraft;
    const unrelated = { text: "Keep me", attachments: [] } satisfies ComposerDraft;
    const legacyPath = "file:///document/composer-drafts/drafts.json";
    persistedFiles.set(
      legacyPath,
      JSON.stringify({
        schemaVersion: 1,
        drafts: {
          [targetKey]: target,
          [unrelatedKey]: unrelated,
        },
      }),
    );
    let releaseRead: () => void = () => undefined;
    readGate.uri = legacyPath;
    readGate.promise = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      readGate.notifyStarted = resolve;
    });
    appAtomRegistry.set(composerDraftsAtom, { [sourceKey]: source });

    const copy = copyComposerDraftContentIfEmpty(sourceKey, targetKey);
    await readStarted;
    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({ [sourceKey]: source });

    releaseRead();
    await copy;

    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({
      [sourceKey]: source,
      [targetKey]: target,
      [unrelatedKey]: unrelated,
    });
  });
});

describe("appendedComposerDraftText", () => {
  it("separates an addition from existing text with a blank line", () => {
    expect(appendedComposerDraftText("hello", "queued")).toBe("hello\n\nqueued");
  });

  it("keeps an existing trailing newline as the separator", () => {
    expect(appendedComposerDraftText("hello\n", "queued")).toBe("hello\nqueued");
  });

  it("adds no separator to blank existing text", () => {
    expect(appendedComposerDraftText("", "queued")).toBe("queued");
    expect(appendedComposerDraftText("   ", "queued")).toBe("   queued");
  });

  it("leaves existing text untouched when there is nothing to add", () => {
    expect(appendedComposerDraftText("hello", "")).toBe("hello");
  });

  it("grows the text even when the addition repeats what is already there", () => {
    // The queued-message edit verifies its append by comparing against this
    // result, so re-editing identical text must not look like a no-op.
    expect(appendedComposerDraftText("queued", "queued")).toBe("queued\n\nqueued");
  });
});

describe("appendComposerDraftContentDurably", () => {
  it("retries only failed batch keys during the flush final attempt", async () => {
    const firstKey = "environment-1:thread-retry-first";
    const secondKey = "environment-1:thread-retry-second";
    setComposerDraftText(firstKey, "first");
    setComposerDraftText(secondKey, "second");
    failNextMove.value = true;

    await flushComposerDrafts();

    const firstPath = `file:///document/composer-drafts/drafts/${encodeURIComponent(firstKey)}.json`;
    const secondPath = `file:///document/composer-drafts/drafts/${encodeURIComponent(secondKey)}.json`;
    expect(persistedFiles.has(firstPath)).toBe(true);
    expect(persistedFiles.has(secondPath)).toBe(true);
    expect(moveAttempts.get(firstPath)).toBe(2);
    expect(moveAttempts.get(secondPath)).toBe(1);
  });

  it("reports unwritten drafts after a failed flush so a restart can hold off", async () => {
    const draftKey = "environment-1:thread-flush-unwritten";
    failMovePathFragments.add(encodeURIComponent(draftKey));
    setComposerDraftText(draftKey, "draft");

    await flushComposerDrafts();
    expect(hasUnpersistedComposerDrafts()).toBe(true);

    failMovePathFragments.clear();
    await flushComposerDrafts();
    expect(hasUnpersistedComposerDrafts()).toBe(false);
  });

  it("keeps a failed flush queued after its final immediate attempt", async () => {
    vi.useFakeTimers();
    try {
      const draftKey = "environment-1:thread-flush-retry";
      const path = `file:///document/composer-drafts/drafts/${encodeURIComponent(draftKey)}.json`;
      failMovePathFragments.add(encodeURIComponent(draftKey));
      setComposerDraftText(draftKey, "draft");

      await flushComposerDrafts();
      expect(moveAttempts.get(path)).toBe(2);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(moveAttempts.get(path)).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(moveAttempts.get(path)).toBe(3);
    } finally {
      resetComposerDraftPersistenceForTests();
      vi.useRealTimers();
    }
  });

  it("preserves per-key backoff across durable requeues and retries every 30 seconds", async () => {
    vi.useFakeTimers();
    try {
      const draftKey = "environment-1:thread-long-retry";
      const path = `file:///document/composer-drafts/drafts/${encodeURIComponent(draftKey)}.json`;
      failMovePathFragments.add(encodeURIComponent(draftKey));

      for (let index = 0; index < 5; index += 1) {
        await appendComposerDraftContentDurably(draftKey, {
          text: `attempt-${index}`,
          attachments: [],
        });
      }
      expect(moveAttempts.get(path)).toBe(5);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(moveAttempts.get(path)).toBe(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(moveAttempts.get(path)).toBe(6);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(moveAttempts.get(path)).toBe(7);
    } finally {
      resetComposerDraftPersistenceForTests();
      vi.useRealTimers();
    }
  });

  it("flushes continuously edited drafts within the maximum delay", async () => {
    vi.useFakeTimers();
    try {
      const firstKey = "environment-1:thread-max-delay-first";
      const secondKey = "environment-1:thread-max-delay-second";
      setComposerDraftText(firstKey, "first");
      for (let elapsed = 900; elapsed < 5_000; elapsed += 900) {
        await vi.advanceTimersByTimeAsync(900);
        setComposerDraftText(secondKey, `second-${elapsed}`);
      }
      await vi.advanceTimersByTimeAsync(500);

      const firstPath = `file:///document/composer-drafts/drafts/${encodeURIComponent(firstKey)}.json`;
      const secondPath = `file:///document/composer-drafts/drafts/${encodeURIComponent(secondKey)}.json`;
      expect(persistedFiles.has(firstPath)).toBe(true);
      expect(persistedFiles.has(secondPath)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads debounced draft state only when its queued write starts", async () => {
    const blockingDraftKey = "environment-1:thread-blocking";
    const pendingDraftKey = "environment-1:thread-pending";
    let releaseHash: () => void = () => undefined;
    hashGate.promise = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    const hashStarted = new Promise<void>((resolve) => {
      hashGate.notifyStarted = resolve;
    });
    const durableWrite = appendComposerDraftContentDurably(blockingDraftKey, {
      text: "blocking",
      attachments: [
        {
          id: "blocking",
          type: "image",
          name: "blocking.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataUrl: "data:image/png;base64,YWJj",
          previewUri: "data:image/png;base64,YWJj",
        },
      ],
    });
    await hashStarted;

    setComposerDraftText(pendingDraftKey, "queued snapshot");
    const flush = flushComposerDrafts();
    setComposerDraftText(pendingDraftKey, "latest snapshot");
    releaseHash();

    await durableWrite;
    await flush;
    await flushComposerDrafts();
    const recordPath = `file:///document/composer-drafts/drafts/${encodeURIComponent(pendingDraftKey)}.json`;
    const record = JSON.parse(persistedFiles.get(recordPath) ?? "null") as {
      readonly draft?: { readonly text?: string };
    } | null;
    expect(record?.draft?.text).toBe("latest snapshot");
  });

  it("rejects a non-throwing partial write after readback", async () => {
    const draftKey = "environment-1:thread-durable";
    corruptNextWrite.value = true;

    const result = await appendComposerDraftContentDurably(draftKey, {
      text: "queued",
      attachments: [],
    });

    expect(result.status).toBe("persist-failed");
    expect(getComposerDraftSnapshot(draftKey).text).toBe("queued");
  });
});

describe("revertComposerDraftAppend", () => {
  const draftKey = "environment-1:thread-1";
  const image = (id: string) => ({
    id,
    type: "image" as const,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 3,
    dataUrl: "data:image/png;base64,YWJj",
    previewUri: "data:image/png;base64,YWJj",
  });

  it("restores an untouched append exactly", async () => {
    const existing = image("existing");
    const queued = image("queued");
    const before: ComposerDraft = {
      text: "draft",
      inputOrigin: "voice-transcription",
      attachments: [existing],
    };
    const appended: ComposerDraft = {
      ...before,
      text: "draft\n\nqueued",
      attachments: [existing, queued],
    };
    appAtomRegistry.set(composerDraftsAtom, { [draftKey]: appended });

    await expect(revertComposerDraftAppend(draftKey, { before, appended })).resolves.toEqual({
      fullyReverted: true,
      persisted: true,
    });
    expect(getComposerDraftSnapshot(draftKey)).toEqual(before);
  });

  it("keeps newer text and attachments while removing only this append's image", async () => {
    const existing = image("existing");
    const queued = image("queued");
    const newer = image("newer");
    const before: ComposerDraft = { text: "draft", attachments: [existing] };
    const appended: ComposerDraft = {
      ...before,
      text: "draft\n\nqueued",
      attachments: [existing, queued],
    };
    appAtomRegistry.set(composerDraftsAtom, {
      [draftKey]: {
        ...appended,
        text: "draft\n\nqueued plus my edit",
        attachments: [existing, queued, newer],
      },
    });

    await expect(revertComposerDraftAppend(draftKey, { before, appended })).resolves.toEqual({
      fullyReverted: false,
      persisted: true,
    });
    expect(getComposerDraftSnapshot(draftKey)).toMatchObject({
      text: "draft\n\nqueued plus my edit",
      attachments: [existing, newer],
    });
  });

  it("removes only the later occurrence when the same image object already existed", async () => {
    const repeated = image("same");
    const before: ComposerDraft = { text: "", attachments: [repeated] };
    const appended: ComposerDraft = { text: "", attachments: [repeated, repeated] };
    appAtomRegistry.set(composerDraftsAtom, { [draftKey]: appended });

    await expect(revertComposerDraftAppend(draftKey, { before, appended })).resolves.toEqual({
      fullyReverted: true,
      persisted: true,
    });
    expect(getComposerDraftSnapshot(draftKey).attachments).toEqual([repeated]);
  });
});

describe("composerDraftStillContainsAppend", () => {
  const image = {
    id: "queued",
    type: "image" as const,
    name: "queued.png",
    mimeType: "image/png",
    sizeBytes: 3,
    dataUrl: "data:image/png;base64,YWJj",
    previewUri: "data:image/png;base64,YWJj",
  };
  const before: ComposerDraft = { text: "draft", attachments: [] };
  const appended: ComposerDraft = {
    text: "draft\n\nqueued",
    attachments: [image],
  };

  it("accepts an untouched live append", () => {
    expect(composerDraftStillContainsAppend(appended, { before, appended })).toBe(true);
  });

  it("rejects text or attachments consumed while persistence was pending", () => {
    expect(composerDraftStillContainsAppend({ ...appended, text: "" }, { before, appended })).toBe(
      false,
    );
    expect(
      composerDraftStillContainsAppend({ ...appended, attachments: [] }, { before, appended }),
    ).toBe(false);
  });

  it("restores the pre-merge snapshot when the draft is untouched since the merge", () => {
    const draftKey = "environment-1:thread-1";
    const snapshot: ComposerDraft = { text: "typed before", attachments: [] };
    const merged: ComposerDraft = {
      text: "typed before\n\nqueued text",
      attachments: [],
      runtimeMode: "approval-required",
    };

    expect(undoComposerDraftMergeState({ [draftKey]: merged }, draftKey, snapshot, merged)).toEqual(
      { [draftKey]: snapshot },
    );
    expect(
      undoComposerDraftMergeState(
        { [draftKey]: merged },
        draftKey,
        { text: "", attachments: [] },
        merged,
      ),
    ).toEqual({});
  });

  it("persists an async merge rollback through the per-draft record", async () => {
    const draftKey = "environment-1:thread-1";
    const snapshot: ComposerDraft = { text: "typed before", attachments: [] };
    const merged: ComposerDraft = {
      text: "typed before\n\nqueued text",
      attachments: [],
    };
    persistedFiles.set(
      draftRecordPath(draftKey),
      JSON.stringify({ schemaVersion: 2, draftKey, draft: merged }),
    );

    await undoComposerDraftMerge(draftKey, snapshot, merged);

    expect(JSON.parse(persistedFiles.get(draftRecordPath(draftKey)) ?? "null")).toEqual({
      schemaVersion: 2,
      draftKey,
      draft: snapshot,
    });
  });

  it("returns merge-written settings to the snapshot but keeps user-edited ones", () => {
    const draftKey = "environment-1:thread-1";
    const snapshot: ComposerDraft = {
      text: "typed before",
      attachments: [],
      runtimeMode: "approval-required",
      interactionMode: "default",
    };
    const merged: ComposerDraft = {
      text: "typed before\n\nqueued text",
      attachments: [],
      runtimeMode: "full-access",
      interactionMode: "default",
    };
    // The user edited the text (forcing the partial undo) and also switched
    // interaction mode, but never touched the merge-written runtime mode.
    const edited: ComposerDraft = {
      text: "typed EDITED before\n\nqueued text",
      attachments: [],
      runtimeMode: "full-access",
      interactionMode: "plan",
    };

    expect(undoComposerDraftMergeState({ [draftKey]: edited }, draftKey, snapshot, merged)).toEqual(
      {
        [draftKey]: {
          text: "typed EDITED before",
          attachments: [],
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      },
    );
  });

  it("takes out only what the merge inserted when the user edited during it", () => {
    const draftKey = "environment-1:thread-1";
    const keptAttachment = {
      id: "kept",
      type: "file" as const,
      name: "kept.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      fileUri: "file:///documents/t3-composer-attachments/kept.pdf",
    };
    const insertedAttachment = {
      id: "inserted",
      type: "file" as const,
      name: "inserted.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      fileUri: "file:///documents/t3-composer-attachments/inserted.pdf",
    };
    const userAttachment = { ...keptAttachment, id: "user-added" };
    const snapshot: ComposerDraft = { text: "typed before", attachments: [keptAttachment] };
    const merged: ComposerDraft = {
      text: "typed before\n\nqueued text",
      attachments: [keptAttachment, insertedAttachment],
    };
    // The user rewrote the leading text and attached a file mid-recovery.
    const edited: ComposerDraft = {
      text: "typed EDITED before\n\nqueued text",
      attachments: [keptAttachment, insertedAttachment, userAttachment],
    };

    expect(undoComposerDraftMergeState({ [draftKey]: edited }, draftKey, snapshot, merged)).toEqual(
      {
        [draftKey]: {
          text: "typed EDITED before",
          attachments: [keptAttachment, userAttachment],
        },
      },
    );

    // Edits that broke the merged suffix keep their text untouched; only the
    // inserted attachments still come out.
    const rewritten: ComposerDraft = {
      text: "totally rewritten",
      attachments: [insertedAttachment],
    };
    expect(
      undoComposerDraftMergeState({ [draftKey]: rewritten }, draftKey, snapshot, merged),
    ).toEqual({
      [draftKey]: { text: "totally rewritten", attachments: [] },
    });
  });

  it("keeps text appended after a merge when rolling it back", () => {
    const draftKey = "environment-1:thread-1";
    const snapshot: ComposerDraft = { text: "typed before", attachments: [] };
    const content = { text: "queued text", attachments: [] };
    const merged = mergeComposerDraftContentState({ [draftKey]: snapshot }, draftKey, content)[
      draftKey
    ]!;
    const edited: ComposerDraft = {
      ...merged,
      text: `${merged.text}\n\nuser follow-up`,
    };

    const rolledBack = undoComposerDraftMergeState(
      { [draftKey]: edited },
      draftKey,
      snapshot,
      merged,
    );

    expect(rolledBack[draftKey]?.text).toBe("typed before\n\nuser follow-up");
    const retried = mergeComposerDraftContentState(rolledBack, draftKey, content);
    expect(retried[draftKey]?.text.match(/queued text/g)).toHaveLength(1);
  });

  it("spares a file re-owned between the sweep's scan and its deletion", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const fileFor = (id: string) => ({
      id,
      type: "file" as const,
      name: `${id}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: `file:///documents/t3-composer-attachments/${id}.pdf`,
    });
    const first = fileFor("file-first");
    const reowned = fileFor("file-reowned");
    // A restore re-owns the second file while the first deletion is in
    // flight, after the sweep already decided both were unused.
    composerAttachmentCleanupMocks.remove.mockImplementationOnce(async () => {
      appAtomRegistry.set(composerDraftsAtom, {
        "environment-1:thread-1": { text: "restored", attachments: [reowned] },
      });
    });

    await releaseUnusedComposerAttachmentFiles([first, reowned]);

    expect(composerAttachmentCleanupMocks.remove.mock.calls).toEqual([[first.fileUri]]);
  });

  // Uses a fresh module instance (hydration is one-shot), so it stays last.
  it("hydrates persisted drafts before a cold-start sweep deletes their files", async () => {
    const file = {
      id: "file-cold-start",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    const draftKey = "environment-1:thread-1";
    persistedFiles.set(
      draftRecordPath(draftKey),
      JSON.stringify({
        schemaVersion: 2,
        draftKey,
        draft: { text: "Persisted draft", attachments: [file] },
      }),
    );
    vi.resetModules();
    const fresh = await import("./use-composer-drafts");
    const freshRegistry = (await import("./atom-registry")).appAtomRegistry;

    await fresh.releaseUnusedComposerAttachmentFiles([file]);

    expect(freshRegistry.get(fresh.composerDraftsAtom)).toEqual({
      "environment-1:thread-1": { text: "Persisted draft", attachments: [file] },
    });
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
  });
});
