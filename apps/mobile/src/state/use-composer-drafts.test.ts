import { afterEach, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { vi } from "vite-plus/test";

const persistedFiles = new Map<string, string>();
const corruptNextWrite = { value: false };

vi.mock("expo-file-system", () => ({
  Paths: { document: "file:///document" },
  Directory: class {
    readonly uri: string;

    constructor(base: string, name: string) {
      this.uri = `${base}/${name}`;
    }

    create(): void {}
  },
  File: class {
    readonly uri: string;

    constructor(directory: { uri: string }, name: string) {
      this.uri = `${directory.uri}/${name}`;
    }

    get exists(): boolean {
      return persistedFiles.has(this.uri);
    }

    create(): void {
      persistedFiles.set(this.uri, "");
    }

    write(value: string): void {
      persistedFiles.set(this.uri, corruptNextWrite.value ? `${value.slice(0, 8)}!` : value);
      corruptNextWrite.value = false;
    }

    async text(): Promise<string> {
      return persistedFiles.get(this.uri) ?? "";
    }
  },
}));

import { appAtomRegistry } from "./atom-registry";
import {
  appendedComposerDraftText,
  appendComposerDraftContentDurably,
  clearComposerDraftContentIfUnchangedState,
  clearComposerDraftContentState,
  composerDraftStillContainsAppend,
  composerDraftsAtom,
  decodePersistedComposerDrafts,
  type ComposerDraft,
  getComposerDraftSnapshot,
  mergeComposerDraftContentState,
  removeComposerDraftsForEnvironment,
  revertComposerDraftAppend,
  restoreComposerDraftSnapshotState,
} from "./use-composer-drafts";

const DRAFT: ComposerDraft = {
  text: "hello",
  attachments: [],
};

afterEach(() => {
  appAtomRegistry.set(composerDraftsAtom, {});
  persistedFiles.clear();
  corruptNextWrite.value = false;
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
