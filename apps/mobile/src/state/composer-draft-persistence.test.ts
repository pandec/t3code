import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const persistedFiles = new Map<string, string>();

vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    readonly name: string;

    constructor(directory: { uri: string }, name: string) {
      this.uri = `${directory.uri}/${name}`;
      this.name = name;
    }

    get exists(): boolean {
      return persistedFiles.has(this.uri);
    }

    create(): void {
      persistedFiles.set(this.uri, "");
    }

    write(value: string): void {
      persistedFiles.set(this.uri, value);
    }

    delete(): void {
      persistedFiles.delete(this.uri);
    }

    moveSync(destination: { uri: string }): void {
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
  digestStringAsync: async (_algorithm: string, value: string) =>
    [...value]
      .reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0)
      .toString(16)
      .padStart(64, "0"),
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
