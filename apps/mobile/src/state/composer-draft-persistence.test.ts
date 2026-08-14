import { afterEach, describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { vi } from "vite-plus/test";

const persistedFiles = new Map<string, string>();
const failNextHash = { value: false };
const corruptWritesRemaining = { value: 0 };
const failWritePathFragments = new Set<string>();
const failReadPathFragments = new Set<string>();
const failMovePathFragments = new Set<string>();
const failDeletePathFragments = new Set<string>();
const hashMetrics = { calls: 0, active: 0, maxActive: 0 };

function testContentHash(value: string): string {
  return [...value]
    .reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0)
    .toString(16)
    .padStart(64, "0");
}

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
      if ([...failWritePathFragments].some((fragment) => this.uri.includes(fragment))) {
        throw new Error(`write failed: ${this.uri}`);
      }
      if (corruptWritesRemaining.value > 0) {
        corruptWritesRemaining.value -= 1;
        persistedFiles.set(this.uri, `${value}!`);
        return;
      }
      persistedFiles.set(this.uri, value);
    }

    delete(): void {
      if ([...failDeletePathFragments].some((fragment) => this.uri.includes(fragment))) {
        throw new Error(`delete failed: ${this.uri}`);
      }
      persistedFiles.delete(this.uri);
    }

    moveSync(destination: { uri: string }, options?: { readonly overwrite?: boolean }): void {
      if ([...failMovePathFragments].some((fragment) => destination.uri.includes(fragment))) {
        throw new Error(`move failed: ${destination.uri}`);
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
    hashMetrics.calls += 1;
    hashMetrics.active += 1;
    hashMetrics.maxActive = Math.max(hashMetrics.maxActive, hashMetrics.active);
    try {
      await Promise.resolve();
      if (failNextHash.value) {
        failNextHash.value = false;
        throw new Error("hash failed");
      }
      return testContentHash(value);
    } finally {
      hashMetrics.active -= 1;
    }
  },
}));

import {
  ComposerDraftBatchPersistenceError,
  composerDraftAttachmentReferenceCounts,
  decodePersistedComposerDrafts,
  hydratePersistedComposerDraftKey,
  loadPersistedComposerDrafts,
  orphanComposerDraftAttachmentFileNames,
  persistComposerDraftKeys,
  splitComposerDraftForPersistence,
  sweepOrphanComposerDraftAttachments,
} from "./composer-draft-persistence";
import type { ComposerDraft } from "./use-composer-drafts";

const DATA_URL = "data:image/png;base64,YWJj";

function image(id: string) {
  return {
    id,
    type: "image" as const,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 3,
    dataUrl: DATA_URL,
    previewUri: DATA_URL,
  };
}

function draftRecordPath(draftKey: string): string {
  return `file:///document/composer-drafts/drafts/${encodeURIComponent(draftKey)}.json`;
}

function attachmentPath(contentHash: string): string {
  return `file:///document/composer-drafts/attachments/${contentHash}.attachment`;
}

function splitRecord(draftKey: string, contentHash: string, text = "draft") {
  return {
    schemaVersion: 2,
    draftKey,
    draft: {
      text,
      attachments: [
        {
          id: `${draftKey}:image`,
          type: "image",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 3,
          contentHash,
        },
      ],
    },
  };
}

afterEach(() => {
  persistedFiles.clear();
  failNextHash.value = false;
  corruptWritesRemaining.value = 0;
  failWritePathFragments.clear();
  failReadPathFragments.clear();
  failMovePathFragments.clear();
  failDeletePathFragments.clear();
  hashMetrics.calls = 0;
  hashMetrics.active = 0;
  hashMetrics.maxActive = 0;
});

describe("composer draft record split", () => {
  it("stores attachment payloads once and keeps only content references in each record", async () => {
    const split = await splitComposerDraftForPersistence(
      "environment-1:thread-1",
      { text: "draft", attachments: [image("first"), image("second")] },
      async () => "shared-content-hash",
    );

    expect(split.attachmentContents).toEqual(new Map([["shared-content-hash", DATA_URL]]));
    expect(split.record.draft.attachments).toEqual([
      {
        id: "first",
        type: "image",
        name: "first.png",
        mimeType: "image/png",
        sizeBytes: 3,
        contentHash: "shared-content-hash",
      },
      {
        id: "second",
        type: "image",
        name: "second.png",
        mimeType: "image/png",
        sizeBytes: 3,
        contentHash: "shared-content-hash",
      },
    ]);
  });

  it("keeps legacy setting fields decodable", () => {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    };
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": {
            text: "legacy draft",
            attachments: [],
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "plan",
          },
        },
      }),
    ).toEqual({
      "environment-1:thread-1": {
        text: "legacy draft",
        attachments: [],
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      },
    });
  });

  it("omits setting fields from existing-thread records but retains new-task settings", async () => {
    const settings = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
    };
    const serverSplit = await splitComposerDraftForPersistence(
      "environment-1:thread-1",
      { text: "draft", attachments: [], ...settings },
      async () => "unused",
    );
    const newTaskSplit = await splitComposerDraftForPersistence(
      "new-task:environment-1:project-1",
      { text: "draft", attachments: [], ...settings },
      async () => "unused",
    );

    expect(serverSplit.record.draft).toEqual({ text: "draft", attachments: [] });
    expect(newTaskSplit.record.draft).toEqual({
      text: "draft",
      attachments: [],
      ...settings,
    });
  });

  it("keeps record and attachment destinations after temporary file handles move", async () => {
    const draftKey = "environment-1:thread-atomic";
    const draft: ComposerDraft = { text: "atomic draft", attachments: [image("atomic")] };

    await persistComposerDraftKeys({ [draftKey]: draft }, new Set([draftKey]), { verify: true });

    const recordPath = `file:///document/composer-drafts/drafts/${encodeURIComponent(draftKey)}.json`;
    const record = JSON.parse(persistedFiles.get(recordPath) ?? "null") as {
      readonly draft?: { readonly attachments?: ReadonlyArray<{ readonly contentHash?: string }> };
    } | null;
    expect(record).toMatchObject({
      schemaVersion: 2,
      draftKey,
      draft: { text: "atomic draft" },
    });
    const contentHash = record?.draft?.attachments?.[0]?.contentHash;
    expect(contentHash).toBeDefined();
    expect(
      persistedFiles.get(
        `file:///document/composer-drafts/attachments/${contentHash ?? "missing"}.attachment`,
      ),
    ).toBe(DATA_URL);
    expect([...persistedFiles.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("keeps a move failure observable when temporary cleanup also fails", async () => {
    const draftKey = "environment-1:thread-cleanup-failure";
    const pathFragment = encodeURIComponent(draftKey);
    failMovePathFragments.add(pathFragment);
    failDeletePathFragments.add(pathFragment);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await persistComposerDraftKeys(
        { [draftKey]: { text: "draft", attachments: [] } },
        new Set([draftKey]),
      );
      throw new Error("Expected persistence to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ComposerDraftBatchPersistenceError);
      const failure =
        error instanceof ComposerDraftBatchPersistenceError
          ? error.failures.get(draftKey)
          : undefined;
      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof Error ? failure.message : "").toContain("move failed");
    } finally {
      warn.mockRestore();
    }
  });

  it("retries an attachment hash after a cached hash promise rejects", async () => {
    const draftKey = "environment-1:thread-hash-retry";
    const attachment = image("retry");
    const drafts = { [draftKey]: { text: "draft", attachments: [attachment] } };
    failNextHash.value = true;

    await expect(persistComposerDraftKeys(drafts, new Set([draftKey]))).rejects.toThrow();
    await expect(persistComposerDraftKeys(drafts, new Set([draftKey]))).resolves.toBeUndefined();
  });

  it("attempts every draft in a batch before rejecting the first failure", async () => {
    const failedKey = "environment-1:thread-failed";
    const persistedKey = "environment-1:thread-persisted";
    failWritePathFragments.add(encodeURIComponent(failedKey));

    await expect(
      persistComposerDraftKeys(
        {
          [failedKey]: { text: "failed", attachments: [] },
          [persistedKey]: { text: "persisted", attachments: [] },
        },
        new Set([failedKey, persistedKey]),
      ),
    ).rejects.toThrow();

    const persistedPath = `file:///document/composer-drafts/drafts/${encodeURIComponent(persistedKey)}.json`;
    expect(persistedFiles.has(persistedPath)).toBe(true);
  });

  it("repairs corrupt attachment content before committing a verified record", async () => {
    const draftKey = "environment-1:thread-corrupt-attachment";
    const draft: ComposerDraft = { text: "draft", attachments: [image("corrupt")] };
    await persistComposerDraftKeys({ [draftKey]: draft }, new Set([draftKey]));
    const attachmentPath = [...persistedFiles.keys()].find((path) =>
      path.startsWith("file:///document/composer-drafts/attachments/"),
    );
    expect(attachmentPath).toBeDefined();
    persistedFiles.set(attachmentPath!, "corrupt");
    corruptWritesRemaining.value = 1;

    await expect(
      persistComposerDraftKeys({ [draftKey]: draft }, new Set([draftKey]), { verify: true }),
    ).rejects.toThrow();
    expect(persistedFiles.get(attachmentPath!)).not.toBe(DATA_URL);

    await expect(
      persistComposerDraftKeys({ [draftKey]: draft }, new Set([draftKey]), { verify: true }),
    ).resolves.toBeUndefined();
    expect(persistedFiles.get(attachmentPath!)).toBe(DATA_URL);
  });

  it("migrates the legacy aggregate document without dropping draft content", async () => {
    const draft: ComposerDraft = {
      text: "legacy draft",
      attachments: [image("legacy")],
      runtimeMode: "approval-required",
    };
    persistedFiles.set(
      "file:///document/composer-drafts/drafts.json",
      JSON.stringify({
        schemaVersion: 1,
        drafts: { "environment-1:thread-legacy": draft },
      }),
    );

    await expect(loadPersistedComposerDrafts()).resolves.toEqual({
      "environment-1:thread-legacy": draft,
    });
    expect(persistedFiles.has("file:///document/composer-drafts/drafts.json")).toBe(false);
    expect(
      [...persistedFiles.keys()].filter((path) =>
        path.startsWith("file:///document/composer-drafts/drafts/"),
      ),
    ).toHaveLength(1);
    expect(
      [...persistedFiles.keys()].filter((path) =>
        path.startsWith("file:///document/composer-drafts/attachments/"),
      ),
    ).toHaveLength(1);
    await expect(loadPersistedComposerDrafts()).resolves.toEqual({
      "environment-1:thread-legacy": {
        text: draft.text,
        attachments: draft.attachments,
      },
    });
  });

  it("prefers valid legacy content over a split record with a corrupt attachment", async () => {
    const draftKey = "environment-1:thread-incomplete-split";
    const legacyDraft: ComposerDraft = {
      text: "legacy survives",
      attachments: [image("legacy")],
    };
    persistedFiles.set(
      "file:///document/composer-drafts/drafts.json",
      JSON.stringify({ schemaVersion: 1, drafts: { [draftKey]: legacyDraft } }),
    );
    persistedFiles.set(
      `file:///document/composer-drafts/drafts/${encodeURIComponent(draftKey)}.json`,
      JSON.stringify({
        schemaVersion: 2,
        draftKey,
        draft: {
          text: "incomplete split",
          attachments: [
            {
              id: "split",
              type: "image",
              name: "split.png",
              mimeType: "image/png",
              sizeBytes: 3,
              contentHash: "wrong-hash",
            },
          ],
        },
      }),
    );
    persistedFiles.set(
      "file:///document/composer-drafts/attachments/wrong-hash.attachment",
      "corrupt",
    );

    await expect(loadPersistedComposerDrafts()).resolves.toEqual({ [draftKey]: legacyDraft });
    expect(persistedFiles.has("file:///document/composer-drafts/drafts.json")).toBe(false);
    await expect(loadPersistedComposerDrafts()).resolves.toEqual({ [draftKey]: legacyDraft });
  });

  it("accepts valid unpadded base64 with a non-canonical data URL prefix", async () => {
    const draftKey = "environment-1:thread-data-url-variation";
    const dataUrl = "data:image/png;charset=utf-8;base64,YWI";
    const contentHash = testContentHash(dataUrl);
    const record = splitRecord(draftKey, contentHash);
    record.draft.attachments[0]!.sizeBytes = 2;
    persistedFiles.set(draftRecordPath(draftKey), JSON.stringify(record));
    persistedFiles.set(attachmentPath(contentHash), dataUrl);

    await expect(loadPersistedComposerDrafts()).resolves.toEqual({
      [draftKey]: {
        text: "draft",
        attachments: [
          expect.objectContaining({
            sizeBytes: 2,
            dataUrl,
            previewUri: dataUrl,
          }),
        ],
      },
    });

    expect(hashMetrics.calls).toBe(1);
    expect(JSON.parse(persistedFiles.get(draftRecordPath(draftKey)) ?? "null")).toEqual(record);
  });

  it("preserves unavailable attachment references and suppresses the load-time sweep", async () => {
    const draftKey = "environment-1:thread-unavailable";
    const contentHash = testContentHash(DATA_URL);
    const record = splitRecord(draftKey, contentHash);
    const orphanPath = attachmentPath("orphan");
    persistedFiles.set(draftRecordPath(draftKey), JSON.stringify(record));
    persistedFiles.set(attachmentPath(contentHash), DATA_URL);
    persistedFiles.set(orphanPath, DATA_URL);
    failReadPathFragments.add(`${contentHash}.attachment`);

    await expect(loadPersistedComposerDrafts()).resolves.toEqual({
      [draftKey]: { text: "draft", attachments: [] },
    });

    expect(JSON.parse(persistedFiles.get(draftRecordPath(draftKey)) ?? "null")).toEqual(record);
    expect(persistedFiles.has(attachmentPath(contentHash))).toBe(true);
    expect(persistedFiles.has(orphanPath)).toBe(true);
  });

  it("repairs proven corruption without dropping unavailable references", async () => {
    const draftKey = "environment-1:thread-mixed-hydration";
    const corruptHash = testContentHash("different");
    const unavailableHash = testContentHash(DATA_URL);
    const record = splitRecord(draftKey, corruptHash);
    record.draft.attachments.push({
      ...record.draft.attachments[0]!,
      id: `${draftKey}:unavailable`,
      contentHash: unavailableHash,
    });
    persistedFiles.set(draftRecordPath(draftKey), JSON.stringify(record));
    persistedFiles.set(attachmentPath(corruptHash), `${DATA_URL}!`);
    persistedFiles.set(attachmentPath(unavailableHash), DATA_URL);
    failReadPathFragments.add(`${unavailableHash}.attachment`);

    await expect(loadPersistedComposerDrafts()).resolves.toEqual({
      [draftKey]: { text: "draft", attachments: [] },
    });

    const repaired = JSON.parse(persistedFiles.get(draftRecordPath(draftKey)) ?? "null") as {
      readonly draft?: {
        readonly attachments?: ReadonlyArray<{ readonly contentHash?: string }>;
      };
    } | null;
    expect(repaired?.draft?.attachments).toEqual([
      expect.objectContaining({ contentHash: unavailableHash }),
    ]);
    expect(persistedFiles.has(attachmentPath(unavailableHash))).toBe(true);
  });

  it("keeps legacy data until an unavailable split draft can be verified", async () => {
    const unavailableKey = "environment-1:thread-unavailable-migration";
    const safeKey = "environment-1:thread-safe-migration";
    const contentHash = testContentHash(DATA_URL);
    const unavailableRecord = splitRecord(unavailableKey, contentHash, "split draft");
    const unavailableLegacyDraft: ComposerDraft = {
      text: "legacy draft",
      attachments: [image("legacy")],
    };
    const safeLegacyDraft: ComposerDraft = { text: "safe draft", attachments: [] };
    const legacyPath = "file:///document/composer-drafts/drafts.json";
    persistedFiles.set(draftRecordPath(unavailableKey), JSON.stringify(unavailableRecord));
    persistedFiles.set(attachmentPath(contentHash), DATA_URL);
    persistedFiles.set(
      legacyPath,
      JSON.stringify({
        schemaVersion: 1,
        drafts: {
          [unavailableKey]: unavailableLegacyDraft,
          [safeKey]: safeLegacyDraft,
        },
      }),
    );
    failReadPathFragments.add(`${contentHash}.attachment`);

    await expect(loadPersistedComposerDrafts()).resolves.toEqual({
      [unavailableKey]: unavailableLegacyDraft,
      [safeKey]: safeLegacyDraft,
    });

    expect(persistedFiles.has(legacyPath)).toBe(true);
    expect(JSON.parse(persistedFiles.get(draftRecordPath(unavailableKey)) ?? "null")).toEqual(
      unavailableRecord,
    );
    expect(persistedFiles.has(draftRecordPath(safeKey))).toBe(true);
  });

  it("hydrates attachment records with at most two concurrent hashes", async () => {
    const contentHash = testContentHash(DATA_URL);
    persistedFiles.set(attachmentPath(contentHash), DATA_URL);
    const expected: Record<string, ComposerDraft> = {};
    for (let index = 0; index < 5; index += 1) {
      const draftKey = `environment-1:thread-concurrency-${index}`;
      persistedFiles.set(
        draftRecordPath(draftKey),
        JSON.stringify(splitRecord(draftKey, contentHash)),
      );
      expected[draftKey] = {
        text: "draft",
        attachments: [
          {
            id: `${draftKey}:image`,
            type: "image",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 3,
            dataUrl: DATA_URL,
            previewUri: DATA_URL,
          },
        ],
      };
    }

    await expect(loadPersistedComposerDrafts()).resolves.toEqual(expected);

    expect(hashMetrics.calls).toBe(5);
    expect(hashMetrics.maxActive).toBeGreaterThan(1);
    expect(hashMetrics.maxActive).toBeLessThanOrEqual(2);
  });

  it("treats an invalid split record as missing during targeted rehydration", async () => {
    const draftKey = "environment-1:thread-invalid-targeted-record";
    persistedFiles.set(draftRecordPath(draftKey), "{invalid json");

    await expect(hydratePersistedComposerDraftKey(draftKey)).resolves.toEqual({
      state: "missing",
    });
  });

  it("quarantines corrupt legacy JSON without deleting its payload", async () => {
    const legacyPath = "file:///document/composer-drafts/drafts.json";
    const corruptPayload = "{not valid json";
    persistedFiles.set(legacyPath, corruptPayload);

    await expect(loadPersistedComposerDrafts()).resolves.toEqual({});

    expect(persistedFiles.has(legacyPath)).toBe(false);
    const quarantined = [...persistedFiles.entries()].find(([path]) =>
      path.includes("/composer-drafts/drafts.corrupt-"),
    );
    expect(quarantined?.[1]).toBe(corruptPayload);
  });

  it("sweeps stale temporary draft records during load", async () => {
    const temporaryPath =
      "file:///document/composer-drafts/drafts/environment-1%3Athread-1.json.123.tmp";
    persistedFiles.set(temporaryPath, "partial record");

    await expect(loadPersistedComposerDrafts()).resolves.toEqual({});

    expect(persistedFiles.has(temporaryPath)).toBe(false);
  });
});

describe("composer draft attachment sweep", () => {
  it("aborts without deleting attachments when a draft record cannot be read", async () => {
    const draftKey = "environment-1:thread-unreadable-record";
    const contentHash = testContentHash(DATA_URL);
    const referencedPath = attachmentPath(contentHash);
    const orphanPath = attachmentPath("orphan");
    persistedFiles.set(
      draftRecordPath(draftKey),
      JSON.stringify(splitRecord(draftKey, contentHash)),
    );
    persistedFiles.set(referencedPath, DATA_URL);
    persistedFiles.set(orphanPath, DATA_URL);
    failReadPathFragments.add(`${encodeURIComponent(draftKey)}.json`);

    await expect(sweepOrphanComposerDraftAttachments()).rejects.toMatchObject({
      operation: "read",
    });

    expect(persistedFiles.has(referencedPath)).toBe(true);
    expect(persistedFiles.has(orphanPath)).toBe(true);
  });

  it("counts shared references and removes only unreferenced attachment files", async () => {
    const first = await splitComposerDraftForPersistence(
      "environment-1:thread-1",
      { text: "first", attachments: [image("first")] },
      async () => "shared",
    );
    const second = await splitComposerDraftForPersistence(
      "environment-1:thread-2",
      { text: "second", attachments: [image("second")] },
      async () => "shared",
    );

    expect(composerDraftAttachmentReferenceCounts([first.record, second.record])).toEqual(
      new Map([["shared", 2]]),
    );
    expect(
      orphanComposerDraftAttachmentFileNames(
        ["shared.attachment", "orphan.attachment", "ignored.txt"],
        [first.record, second.record],
      ),
    ).toEqual(["orphan.attachment"]);

    persistedFiles.set(
      "file:///document/composer-drafts/drafts/first.json",
      JSON.stringify(first.record),
    );
    persistedFiles.set(
      "file:///document/composer-drafts/drafts/second.json",
      JSON.stringify(second.record),
    );
    persistedFiles.set("file:///document/composer-drafts/attachments/shared.attachment", DATA_URL);
    persistedFiles.set("file:///document/composer-drafts/attachments/orphan.attachment", DATA_URL);

    await sweepOrphanComposerDraftAttachments();

    expect(
      persistedFiles.has("file:///document/composer-drafts/attachments/shared.attachment"),
    ).toBe(true);
    expect(
      persistedFiles.has("file:///document/composer-drafts/attachments/orphan.attachment"),
    ).toBe(false);
  });

  it("keeps shared content until the last draft reference is cleared", async () => {
    const firstKey = "environment-1:thread-1";
    const secondKey = "environment-1:thread-2";
    const drafts: Record<string, ComposerDraft> = {
      [firstKey]: { text: "first", attachments: [image("first")] },
      [secondKey]: { text: "second", attachments: [image("second")] },
    };
    await persistComposerDraftKeys(drafts, new Set([firstKey, secondKey]));
    const attachmentPath = [...persistedFiles.keys()].find((path) =>
      path.startsWith("file:///document/composer-drafts/attachments/"),
    );
    expect(attachmentPath).toBeDefined();

    const afterFirstClear = { [secondKey]: drafts[secondKey]! };
    await persistComposerDraftKeys(afterFirstClear, new Set([firstKey]), {
      sweepAttachments: true,
    });
    expect(persistedFiles.has(attachmentPath!)).toBe(true);

    await persistComposerDraftKeys({}, new Set([secondKey]), { sweepAttachments: true });
    expect(persistedFiles.has(attachmentPath!)).toBe(false);
  });
});
