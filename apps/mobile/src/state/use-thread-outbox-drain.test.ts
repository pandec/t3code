import {
  threadOutboxFlushBatchIds,
  type ThreadOutboxDispatchResult,
} from "@t3tools/client-runtime/state/thread-outbox-delivery";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PreparedTurnAttachments } from "../lib/attachmentUpload";
import {
  resolveThreadOutboxDeliveryAction,
  selectNextQueuedThreadDispatch,
} from "./thread-outbox-model";

const harness = vi.hoisted(() => ({
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
  removePersistedFile: vi.fn(async () => undefined),
  removeOutboxMessage: vi.fn(async (_message: QueuedThreadMessage) => undefined),
  prepareTurnAttachments: vi.fn<typeof import("../lib/attachmentUpload").prepareTurnAttachments>(),
  setPendingConnectionError: vi.fn(),
  draftFile: (() => {
    const files = new Map<string, string>();
    let writeError: Error | null = null;

    class Directory {
      readonly uri: string;

      constructor(base: string | { readonly uri: string }, name: string) {
        this.uri = `${typeof base === "string" ? base : base.uri}/${name}`;
      }

      create() {}

      list(): ReadonlyArray<File> {
        const prefix = `${this.uri}/`;
        return [...files.keys()]
          .filter((uri) => uri.startsWith(prefix) && !uri.slice(prefix.length).includes("/"))
          .map((uri) => new File(this, uri.slice(prefix.length)));
      }
    }

    class File {
      uri: string;
      parentDirectory = null;

      constructor(directory: { readonly uri: string }, name: string) {
        this.uri = `${directory.uri}/${name}`;
      }

      get exists(): boolean {
        return files.has(this.uri);
      }

      get name(): string {
        return this.uri.slice(this.uri.lastIndexOf("/") + 1);
      }

      create() {
        files.set(this.uri, "");
      }

      delete() {
        files.delete(this.uri);
      }

      moveSync(destination: { readonly uri: string }) {
        const value = files.get(this.uri) ?? "";
        files.delete(this.uri);
        files.set(destination.uri, value);
        this.uri = destination.uri;
      }

      async text() {
        return files.get(this.uri) ?? "";
      }

      write(value: string) {
        if (writeError) {
          throw writeError;
        }
        files.set(this.uri, value);
      }
    }

    return {
      setDocument(value: unknown) {
        files.clear();
        files.set("/documents/composer-drafts/drafts.json", JSON.stringify(value));
      },
      setWriteError(error: Error | null) {
        writeError = error;
      },
      Directory,
      File,
    };
  })(),
}));

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("expo-file-system", () => ({
  Directory: harness.draftFile.Directory,
  File: harness.draftFile.File,
  Paths: { document: "/documents" },
}));

vi.mock("../lib/composerImages", () => ({
  removePersistedComposerAttachmentFile: harness.removePersistedFile,
  toUploadChatImageAttachments: () => [],
}));

vi.mock("../lib/uuid", () => ({
  uuidv4: () => "00000000-0000-4000-8000-000000000000",
  randomHex: () => "abcd",
}));

vi.mock("../lib/attachmentUpload", () => ({
  prepareTurnAttachments: harness.prepareTurnAttachments,
}));

vi.mock("../features/archive/useArchivedThreadSnapshots", () => ({
  refreshArchivedThreadsForEnvironment: vi.fn(),
}));

vi.mock("./thread-steer-pending", () => ({
  noteThreadSteerDispatch: vi.fn(),
}));

vi.mock("./entities", () => ({
  useProjects: () => [],
  useServerConfigs: () => new Map(),
  useThreadShells: () => [],
}));

vi.mock("./server", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { serverEnvironment: { configValueAtom: Atom.family(() => Atom.make(null)) } };
});

vi.mock("./threads", () => ({
  threadEnvironment: {},
}));

vi.mock("./use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));

vi.mock("./use-mobile-preferences", () => ({
  useMobilePreferencesHydrated: () => true,
  useSteerGraceWindowMs: () => 0,
}));

vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    editingQueuedMessageIdsAtom: Atom.make<Record<string, boolean>>({}).pipe(Atom.keepAlive),
    useThreadOutboxMessages: () => ({}),
    useThreadOutboxShellStatuses: () => new Map(),
  };
});

vi.mock("./use-remote-environment-registry", () => ({
  setPendingConnectionError: harness.setPendingConnectionError,
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));

vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  harness.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: async () => undefined,
      remove: (message) => harness.removeOutboxMessage(message),
    },
  });
  const manager = harness.manager;
  return {
    threadOutboxManager: manager,
    flushThreadOutbox: async () => undefined,
    ensureThreadOutboxLoaded: () => undefined,
    confirmThreadOutboxMessageQueued: (message: never) => manager.confirmQueued(message),
    updateThreadOutboxMessage: (message: never, expectedRevision?: number) =>
      manager.update(message, expectedRevision),
    threadOutboxRevision: (messageId: never) => manager.revisionOf(messageId),
  };
});

import { appAtomRegistry } from "./atom-registry";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import * as composerDrafts from "./use-composer-drafts";
import { editingQueuedMessageIdsAtom } from "./use-thread-outbox";
import {
  completeQueuedMessageDelivery,
  prepareQueuedMessageAttachments,
  recoverEditedCreationAfterDelivery,
  removeAcknowledgedExistingThreadMessage,
  restoreRejectedQueuedMessage,
} from "./use-thread-outbox-drain";

function queuedMessage(input: {
  readonly messageId: string;
  readonly text: string;
  readonly fileUri?: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.text,
    attachments: input.fileUri
      ? [
          {
            id: `file-${input.messageId}`,
            type: "file",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
            fileUri: input.fileUri,
          },
        ]
      : [],
    createdAt: "2026-08-24T12:00:00.000Z",
  };
}

function withReusedFileUpload(
  message: QueuedThreadMessage,
  attachmentId: string,
): QueuedThreadMessage {
  return {
    ...message,
    attachments: message.attachments.map((attachment) =>
      attachment.type === "file"
        ? {
            ...attachment,
            uploadedAttachmentId: attachmentId,
            uploadEnvironmentId: message.environmentId,
          }
        : attachment,
    ),
  };
}

function remainingMessages(): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom)).flat();
}

beforeEach(() => {
  harness.draftFile.setDocument({ schemaVersion: 1, drafts: {} });
});

afterEach(() => {
  composerDrafts.resetComposerDraftPersistenceForTests();
  composerDrafts.resetComposerDraftsLoadState();
  appAtomRegistry.set(harness.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(composerDrafts.composerDraftsAtom, {});
  appAtomRegistry.set(composerDrafts.composerCloudDraftsAtom, { accountId: null, signedOut: {} });
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
  harness.draftFile.setWriteError(null);
  harness.removePersistedFile.mockClear();
  harness.removeOutboxMessage.mockClear();
  harness.prepareTurnAttachments.mockReset();
  harness.setPendingConnectionError.mockClear();
});

describe("thread outbox attachment preparation", () => {
  it("abandons reused uploads when an editor saves changed text during verification", async () => {
    const message = withReusedFileUpload(
      queuedMessage({
        messageId: "message-reused-upload-race",
        text: "original text",
        fileUri: "file:///documents/t3-composer-attachments/reused.pdf",
      }),
      "pending-reused-upload",
    );
    const preparationStarted = Promise.withResolvers<void>();
    const preparationBarrier = Promise.withResolvers<PreparedTurnAttachments>();
    harness.prepareTurnAttachments.mockImplementationOnce(async () => {
      preparationStarted.resolve();
      return preparationBarrier.promise;
    });
    await harness.manager.enqueue(message);
    appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });

    const preparation = prepareQueuedMessageAttachments(message);
    await preparationStarted.promise;
    const edited = { ...message, text: "saved editor text" };
    await harness.manager.update(edited);
    appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
    preparationBarrier.resolve({
      status: "ready",
      attachments: [],
      draftAttachments: message.attachments,
      pendingAttachmentIds: ["pending-reused-upload"],
    });

    await expect(preparation).resolves.toEqual({ status: "deferred" });
    expect(remainingMessages()).toEqual([edited]);
  });

  it("keeps an unchanged queued payload ready after attachment reuse", async () => {
    const message = withReusedFileUpload(
      queuedMessage({
        messageId: "message-reused-upload-current",
        text: "unchanged text",
        fileUri: "file:///documents/t3-composer-attachments/current.pdf",
      }),
      "pending-reused-upload",
    );
    harness.prepareTurnAttachments.mockResolvedValueOnce({
      status: "ready",
      attachments: [],
      draftAttachments: message.attachments,
      pendingAttachmentIds: ["pending-reused-upload"],
    });
    await harness.manager.enqueue(message);
    const revision = harness.manager.revisionOf(message.messageId);
    appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });

    await expect(prepareQueuedMessageAttachments(message)).resolves.toMatchObject({
      status: "ready",
      persistedMessage: message,
      deliveryRevision: revision,
    });
  });

  it("reuses an uploaded image when image uploads are supported", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    const image = {
      id: "image-reused-upload",
      type: "image" as const,
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
      previewUri: "file:///documents/photo.png",
      uploadedAttachmentId: "pending-image-upload",
      uploadEnvironmentId: environmentId,
    };
    const message: QueuedThreadMessage = {
      ...queuedMessage({ messageId: "message-reused-image", text: "send this photo" }),
      environmentId,
      attachments: [image],
    };
    harness.prepareTurnAttachments.mockImplementationOnce(async (input) => {
      expect(input.supportsImageUploads).toBe(true);
      expect(input.attachments).toEqual([image]);
      return {
        status: "ready",
        attachments: [],
        draftAttachments: [image],
        pendingAttachmentIds: ["pending-image-upload"],
      };
    });
    await harness.manager.enqueue(message);

    await expect(prepareQueuedMessageAttachments(message, true)).resolves.toMatchObject({
      status: "ready",
      persistedMessage: message,
    });
  });

  it("uses the known next revision after persisting uploaded references", async () => {
    const message = queuedMessage({
      messageId: "message-new-upload-revision",
      text: "upload this file",
      fileUri: "file:///documents/t3-composer-attachments/new.pdf",
    });
    const uploadedAttachments = message.attachments.map((attachment) =>
      attachment.type === "file"
        ? {
            ...attachment,
            uploadedAttachmentId: "pending-new-upload",
            uploadEnvironmentId: message.environmentId,
          }
        : attachment,
    );
    harness.prepareTurnAttachments.mockImplementationOnce(async (input) => {
      expect(await input.persistUploadedReferences?.(uploadedAttachments)).toBe("persisted");
      return {
        status: "ready",
        attachments: [],
        draftAttachments: uploadedAttachments,
        pendingAttachmentIds: ["pending-new-upload"],
      };
    });
    await harness.manager.enqueue(message);
    const revision = harness.manager.revisionOf(message.messageId);

    const result = await prepareQueuedMessageAttachments(message);

    expect(result).toMatchObject({
      status: "ready",
      persistedMessage: { attachments: uploadedAttachments },
      deliveryRevision: revision + 1,
    });
    expect(harness.manager.revisionOf(message.messageId)).toBe(revision + 1);
  });

  it("does not prepare a payload that was already replaced", async () => {
    const message = queuedMessage({ messageId: "message-stale-before-upload", text: "old" });
    await harness.manager.enqueue(message);
    const edited = { ...message, text: "new" };
    await harness.manager.update(edited);

    await expect(prepareQueuedMessageAttachments(message)).resolves.toEqual({
      status: "removed",
    });
    expect(harness.prepareTurnAttachments).not.toHaveBeenCalled();
    expect(remainingMessages()).toEqual([edited]);
  });
});

describe("thread outbox drain delivery cleanup", () => {
  it("removes an acknowledged outbox item even when the sign-out archive write fails", async () => {
    const message = queuedMessage({ messageId: "archive-write-failure", text: "Delivered" });
    await harness.manager.enqueue(message);
    await composerDrafts.archiveCloudComposerDrafts("account-a", new Set([message.environmentId]));
    harness.draftFile.setWriteError(new Error("Draft storage unavailable"));

    await expect(
      completeQueuedMessageDelivery(message, harness.manager.revisionOf(message.messageId)),
    ).resolves.toBe("removed");
    expect(remainingMessages()).toEqual([]);

    harness.draftFile.setWriteError(null);
    await composerDrafts.flushComposerDrafts();
    appAtomRegistry.set(composerDrafts.composerCloudDraftsAtom, { accountId: null, signedOut: {} });
    composerDrafts.resetComposerDraftsLoadState();
    await composerDrafts.restoreCloudComposerDrafts("account-a");
    expect(remainingMessages()).toEqual([]);
  });

  it.each([false, true])(
    "does not restore a message delivered after the sign-out snapshot (outbox already cleared: %s)",
    async (cleared) => {
      const message = queuedMessage({
        messageId: "delivered-during-sign-out",
        text: "Already delivered",
      });
      await harness.manager.enqueue(message);
      const deliveryRevision = harness.manager.revisionOf(message.messageId);
      await composerDrafts.archiveCloudComposerDrafts(
        "account-a",
        new Set([message.environmentId]),
      );
      expect(
        appAtomRegistry.get(composerDrafts.composerCloudDraftsAtom).signedOut["account-a"]
          ?.queuedMessages,
      ).toEqual([message]);

      if (cleared) await harness.manager.clearEnvironment(message.environmentId);
      await expect(completeQueuedMessageDelivery(message, deliveryRevision)).resolves.toBe(
        cleared ? "edited" : "removed",
      );

      // Restart before signing back in: the archived copy must be removed on disk too.
      appAtomRegistry.set(composerDrafts.composerCloudDraftsAtom, {
        accountId: null,
        signedOut: {},
      });
      composerDrafts.resetComposerDraftsLoadState();
      await composerDrafts.restoreCloudComposerDrafts("account-a");
      expect(remainingMessages()).toEqual([]);
    },
  );

  it("preserves an archived edit when an older payload finishes delivery", async () => {
    const message = queuedMessage({ messageId: "edited-during-sign-out", text: "Original" });
    await harness.manager.enqueue(message);
    const deliveryRevision = harness.manager.revisionOf(message.messageId);
    const edited = { ...message, text: "Keep this edit" };
    await harness.manager.update(edited);
    await composerDrafts.archiveCloudComposerDrafts("account-a", new Set([message.environmentId]));
    await harness.manager.clearEnvironment(message.environmentId);
    await expect(completeQueuedMessageDelivery(message, deliveryRevision)).resolves.toBe("edited");
    await composerDrafts.restoreCloudComposerDrafts("account-a");
    expect(remainingMessages()).toEqual([edited]);
  });

  it("skips acknowledged cleanup while an editor owns the row", async () => {
    const message = queuedMessage({ messageId: "message-acknowledged-held", text: "delivered" });
    await harness.manager.enqueue(message);
    const deliveryRevision = harness.manager.revisionOf(message.messageId);
    const acknowledged = new Map([[message.messageId, deliveryRevision]]);
    appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });

    await expect(removeAcknowledgedExistingThreadMessage(message, acknowledged)).resolves.toBe(
      "held",
    );
    expect(remainingMessages()).toEqual([message]);
    expect(acknowledged).toEqual(new Map([[message.messageId, deliveryRevision]]));
    expect(harness.removeOutboxMessage).not.toHaveBeenCalled();
  });

  it("drops the acknowledgement instead of removing a revised row", async () => {
    const message = queuedMessage({ messageId: "message-acknowledged-edited", text: "delivered" });
    await harness.manager.enqueue(message);
    const deliveryRevision = harness.manager.revisionOf(message.messageId);
    const acknowledged = new Map([[message.messageId, deliveryRevision]]);
    const edited = { ...message, text: "not delivered" };
    await harness.manager.update(edited);

    await expect(removeAcknowledgedExistingThreadMessage(edited, acknowledged)).resolves.toBe(
      "edited",
    );
    expect(remainingMessages()).toEqual([edited]);
    expect(acknowledged).toEqual(new Map());
    expect(harness.removeOutboxMessage).not.toHaveBeenCalled();
  });

  it("retries revision-checked cleanup for an unchanged acknowledged row", async () => {
    const message = queuedMessage({ messageId: "message-acknowledged", text: "delivered" });
    harness.removeOutboxMessage.mockRejectedValueOnce(new Error("storage unavailable"));
    await harness.manager.enqueue(message);
    const deliveryRevision = harness.manager.revisionOf(message.messageId);
    const acknowledged = new Map([[message.messageId, deliveryRevision]]);

    await expect(removeAcknowledgedExistingThreadMessage(message, acknowledged)).resolves.toBe(
      "failed",
    );
    expect(remainingMessages()).toEqual([message]);
    expect(acknowledged).toEqual(new Map([[message.messageId, deliveryRevision]]));

    await expect(removeAcknowledgedExistingThreadMessage(message, acknowledged)).resolves.toBe(
      "removed",
    );
    expect(remainingMessages()).toEqual([]);
    expect(acknowledged).toEqual(new Map());
  });

  it("keeps an edited message and its files when delivery cleanup loses the revision race", async () => {
    const message = queuedMessage({
      messageId: "message-edited",
      text: "original",
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    });
    await harness.manager.enqueue(message);
    const deliveryRevision = harness.manager.revisionOf(message.messageId);
    const edited = { ...message, text: "edited while the turn delivered" };
    await harness.manager.update(edited);

    await expect(completeQueuedMessageDelivery(message, deliveryRevision)).resolves.toBe("edited");

    expect(remainingMessages()).toEqual([edited]);
    expect(harness.removePersistedFile).not.toHaveBeenCalled();
  });

  it("removes the delivered message when no edit was accepted", async () => {
    const message = queuedMessage({ messageId: "message-clean", text: "hello" });
    await harness.manager.enqueue(message);
    const deliveryRevision = harness.manager.revisionOf(message.messageId);

    await expect(completeQueuedMessageDelivery(message, deliveryRevision)).resolves.toBe("removed");

    expect(remainingMessages()).toEqual([]);
  });

  it("keeps a delivered message when its editor opens during storage removal", async () => {
    const message = queuedMessage({
      messageId: "message-editor-removal-race",
      text: "keep editor changes",
      fileUri: "file:///documents/t3-composer-attachments/editor-race.pdf",
    });
    const removeStarted = Promise.withResolvers<void>();
    const removeBarrier = Promise.withResolvers<void>();
    harness.removeOutboxMessage.mockImplementationOnce(async () => {
      removeStarted.resolve();
      await removeBarrier.promise;
    });
    await harness.manager.enqueue(message);
    const deliveryRevision = harness.manager.revisionOf(message.messageId);

    const cleanup = completeQueuedMessageDelivery(message, deliveryRevision);
    await removeStarted.promise;
    appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });
    removeBarrier.resolve();

    await expect(cleanup).resolves.toBe("edited");
    expect(remainingMessages()).toEqual([message]);
    expect(harness.removePersistedFile).not.toHaveBeenCalled();
  });
});

describe("thread outbox delivered creation recovery", () => {
  it("keeps an edit accepted while the older payload is persisted to the draft", async () => {
    const message = queuedMessage({
      messageId: "message-recovery-race",
      text: "original queued text",
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    });
    const originalMergeComposerDraftContent = composerDrafts.mergeComposerDraftContent;
    const mergeCompleted = Promise.withResolvers<void>();
    const releaseRecovery = Promise.withResolvers<void>();
    const mergeSpy = vi
      .spyOn(composerDrafts, "mergeComposerDraftContent")
      .mockImplementation(async (draftKey, content) => {
        const result = await originalMergeComposerDraftContent(draftKey, content);
        mergeCompleted.resolve();
        await releaseRecovery.promise;
        return result;
      });

    try {
      await harness.manager.enqueue(message);
      const recovery = recoverEditedCreationAfterDelivery(message);
      await mergeCompleted.promise;

      const newer = { ...message, text: "edited while recovery persisted the draft" };
      await harness.manager.update(newer);

      releaseRecovery.resolve();
      await expect(recovery).resolves.toBe("deferred");

      expect(remainingMessages()).toEqual([newer]);
      expect(
        composerDrafts.getComposerDraftSnapshot(`${message.environmentId}:${message.threadId}`),
      ).toMatchObject({ text: message.text, attachments: [] });
      expect(harness.removePersistedFile).not.toHaveBeenCalled();
    } finally {
      releaseRecovery.resolve();
      mergeSpy.mockRestore();
    }
  });

  it("leaves recovery to an editor that opens while the draft persists", async () => {
    const message = queuedMessage({
      messageId: "message-recovery-editor",
      text: "recover this text",
      fileUri: "file:///documents/t3-composer-attachments/editor.pdf",
    });
    const originalMergeComposerDraftContent = composerDrafts.mergeComposerDraftContent;
    const mergeCompleted = Promise.withResolvers<void>();
    const releaseRecovery = Promise.withResolvers<void>();
    const mergeSpy = vi
      .spyOn(composerDrafts, "mergeComposerDraftContent")
      .mockImplementation(async (draftKey, content) => {
        const result = await originalMergeComposerDraftContent(draftKey, content);
        mergeCompleted.resolve();
        await releaseRecovery.promise;
        return result;
      });

    try {
      await harness.manager.enqueue(message);
      const recovery = recoverEditedCreationAfterDelivery(message);
      await mergeCompleted.promise;
      appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });

      releaseRecovery.resolve();
      await expect(recovery).resolves.toBe("deferred");

      expect(remainingMessages()).toEqual([message]);
      expect(
        composerDrafts.getComposerDraftSnapshot(`${message.environmentId}:${message.threadId}`),
      ).toMatchObject({ text: message.text, attachments: [] });
      expect(harness.removePersistedFile).not.toHaveBeenCalled();
    } finally {
      releaseRecovery.resolve();
      mergeSpy.mockRestore();
    }
  });

  it("retries a failed removal without duplicating recovered draft content", async () => {
    const message = queuedMessage({
      messageId: "message-recovery-removal",
      text: "recover once",
      fileUri: "file:///documents/t3-composer-attachments/retry.pdf",
    });
    const draftKey = `${message.environmentId}:${message.threadId}`;
    const removeSpy = vi
      .spyOn(harness.manager, "remove")
      .mockRejectedValueOnce(new Error("storage unavailable"));

    try {
      await harness.manager.enqueue(message);

      await expect(recoverEditedCreationAfterDelivery(message)).resolves.toBe("failed");
      expect(remainingMessages()).toEqual([message]);

      await expect(recoverEditedCreationAfterDelivery(message)).resolves.toBe("removed");

      const draft = composerDrafts.getComposerDraftSnapshot(draftKey);
      expect(draft.text).toBe(message.text);
      expect(draft.attachments).toEqual(message.attachments);
      expect(remainingMessages()).toEqual([]);
      expect(harness.removePersistedFile).not.toHaveBeenCalled();
    } finally {
      removeSpy.mockRestore();
    }
  });

  it("keeps the queue entry when the recovered draft cannot persist", async () => {
    const message = queuedMessage({
      messageId: "message-recovery-persistence",
      text: "recover after persistence returns",
    });
    await harness.manager.enqueue(message);
    harness.draftFile.setWriteError(new Error("disk full"));

    await expect(recoverEditedCreationAfterDelivery(message)).resolves.toBe("failed");

    expect(remainingMessages()).toEqual([message]);
  });
});

describe("thread outbox recovery rollback", () => {
  it("restores a rejected new task into its durable project draft", async () => {
    const message: QueuedThreadMessage = {
      ...queuedMessage({ messageId: "message-creation-restore", text: "new task text" }),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
      },
    };
    await harness.manager.enqueue(message);

    await expect(restoreRejectedQueuedMessage(message, "rejected by server")).resolves.toBe(
      "restored",
    );

    expect(
      composerDrafts.getComposerDraftSnapshot(
        `new-task:${message.environmentId}:${message.creation!.projectId}`,
      ),
    ).toMatchObject({
      text: message.text,
      attachments: message.attachments,
      modelSelection: message.modelSelection,
    });
    expect(remainingMessages()).toEqual([]);
    expect(harness.setPendingConnectionError).toHaveBeenCalledWith("rejected by server");
  });

  it("rolls a failed recovery merge back so the retry cannot duplicate the text", async () => {
    const message = queuedMessage({ messageId: "message-restore", text: "queued text" });
    const draftKey = `${message.environmentId}:${message.threadId}`;
    appAtomRegistry.set(composerDrafts.composerDraftsAtom, {
      [draftKey]: { text: "typed offline", attachments: [] },
    });
    await harness.manager.enqueue(message);

    harness.draftFile.setWriteError(new Error("disk full"));
    await expect(restoreRejectedQueuedMessage(message, "too large")).resolves.toBe("retry");

    // The merge was rolled back and the message stayed queued for the retry.
    expect(composerDrafts.getComposerDraftSnapshot(draftKey).text).toBe("typed offline");
    expect(remainingMessages()).toEqual([message]);

    harness.draftFile.setWriteError(null);
    await expect(restoreRejectedQueuedMessage(message, "too large")).resolves.toBe("restored");

    // The recovered text landed exactly once and the message left the queue.
    expect(composerDrafts.getComposerDraftSnapshot(draftKey).text).toBe(
      "typed offline\n\nqueued text",
    );
    expect(remainingMessages()).toEqual([]);
    expect(harness.setPendingConnectionError).toHaveBeenCalledWith("too large");
  });
});

describe("mobile thread outbox flush batches", () => {
  it("keeps later rows behind a leader deferred after confirmation", () => {
    const leader = queuedMessage({ messageId: "mobile-race-leader", text: "leader" });
    const follower = queuedMessage({ messageId: "mobile-race-follower", text: "follower" });
    const queue = [leader, follower];
    const resolveAction = (threadStatus: "idle" | "running") =>
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadStatus,
        deliveryIntent: "queue",
      });
    const selected = selectNextQueuedThreadDispatch(queue, {
      isHeld: () => false,
      resolveAction: () => resolveAction("idle"),
    });
    expect(selected).toEqual({ message: leader, action: "send" });

    // Another client starts a turn while confirmQueued is pending.
    const freshAction = resolveAction("running");
    const result: ThreadOutboxDispatchResult =
      freshAction === selected?.action
        ? {
            outcome: "delivered",
            context: {
              sessionBaselineKnown: true,
              sessionStatus: "running",
              sessionUpdatedAt: null,
              latestTurnId: null,
            },
          }
        : { outcome: "deferred" };

    expect(result).toEqual({ outcome: "deferred" });
    expect(threadOutboxFlushBatchIds(queue, leader, { result, action: "send" }).size).toBe(0);
    expect(
      selectNextQueuedThreadDispatch(queue, {
        isHeld: () => false,
        resolveAction: () => freshAction,
      }),
    ).toBeNull();
  });
});
