import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const persistedFiles = new Map<string, string>();
const failNextHash = { value: false };
const corruptWritesRemaining = { value: 0 };
const failWritePathFragments = new Set<string>();

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
      persistedFiles.delete(this.uri);
    }

    moveSync(destination: { uri: string }, options?: { readonly overwrite?: boolean }): void {
      if (persistedFiles.has(destination.uri) && options?.overwrite !== true) {
        throw new Error(`destination already exists: ${destination.uri}`);
      }
      const content = persistedFiles.get(this.uri) ?? "";
      persistedFiles.delete(this.uri);
      persistedFiles.set(destination.uri, content);
      this.uri = destination.uri;
    }

    async text(): Promise<string> {
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
    if (failNextHash.value) {
      failNextHash.value = false;
      throw new Error("hash failed");
    }
    return [...value]
      .reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0)
      .toString(16)
      .padStart(64, "0");
  },
}));

import {
  composerDraftAttachmentReferenceCounts,
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

afterEach(() => {
  persistedFiles.clear();
  failNextHash.value = false;
  corruptWritesRemaining.value = 0;
  failWritePathFragments.clear();
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

  it("keeps the destination payload after the temporary file handle moves", async () => {
    const draftKey = "environment-1:thread-atomic";
    const draft: ComposerDraft = { text: "atomic draft", attachments: [] };

    await persistComposerDraftKeys({ [draftKey]: draft }, new Set([draftKey]), { verify: true });

    const recordPath = `file:///document/composer-drafts/drafts/${encodeURIComponent(draftKey)}.json`;
    expect(JSON.parse(persistedFiles.get(recordPath) ?? "null")).toMatchObject({
      schemaVersion: 2,
      draftKey,
      draft: { text: "atomic draft" },
    });
    expect([...persistedFiles.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
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
      "environment-1:thread-legacy": draft,
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
