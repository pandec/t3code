import { afterEach, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { vi } from "vite-plus/test";

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

import { appAtomRegistry } from "./atom-registry";
import {
  appendedComposerDraftText,
  appendComposerDraftContentDurably,
  clearComposerDraft,
  clearComposerDraftContentIfUnchangedState,
  clearComposerDraftContentState,
  composerDraftStillContainsAppend,
  composerDraftsAtom,
  decodePersistedComposerDrafts,
  ensureComposerDraftsLoaded,
  flushComposerDrafts,
  type ComposerDraft,
  getComposerDraftSnapshot,
  mergeComposerDraftContentState,
  removeComposerDraftAttachment,
  removeComposerDraftsForEnvironment,
  replaceComposerDraftAttachments,
  resetComposerDraftPersistenceForTests,
  revertComposerDraftAppend,
  restoreComposerDraftSnapshot,
  restoreComposerDraftSnapshotState,
  setComposerDraftText,
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
  appAtomRegistry.set(composerDraftsAtom, {});
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
});

describe("mobile composer drafts", () => {
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

  it("clears sent content without clearing the selected model or workspace", () => {
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
      workspaceSelection: {
        mode: "worktree",
        branch: "main",
        worktreePath: null,
      },
    };

    expect(clearComposerDraftContentState({ [draftKey]: draft }, draftKey)).toEqual({
      [draftKey]: {
        modelSelection: draft.modelSelection,
        workspaceSelection: draft.workspaceSelection,
        text: "",
        attachments: [],
      },
    });
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

  it("drops the workspace selection when clearing a sent new-task draft", () => {
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
        clearWorkspaceSelection: true,
      }),
    ).toEqual({
      [draftKey]: {
        modelSelection: draft.modelSelection,
        text: "",
        attachments: [],
      },
    });
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
});
