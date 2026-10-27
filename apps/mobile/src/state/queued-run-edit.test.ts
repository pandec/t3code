import { describe, expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import {
  ChatAttachmentId,
  ComposerContextId,
  MessageId,
  ProviderInstanceId,
  RunId,
  type ChatAttachment,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";

const harness = vi.hoisted(() => ({
  shells: new Map<string, unknown>(),
  details: new Map<string, unknown>(),
}));

vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
    list() {
      return [];
    }
  },
  File: class {
    exists = false;
    parentDirectory = null;
    create() {}
    moveSync() {}
    async text() {
      return JSON.stringify({ schemaVersion: 1, drafts: {} });
    }
    write() {}
  },
  Paths: { document: { uri: "file:///documents" } },
}));

vi.mock("../lib/composerContextClipboard", () => ({
  downloadServerAttachmentToDraft: vi.fn(async () => {
    throw new Error("offline");
  }),
}));

vi.mock("../lib/uuid", () => {
  let next = 0;
  return { uuidv4: () => `uuid-${++next}`, randomHex: () => "0000" };
});

vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const key = (ref: { environmentId: string; threadId: string }) =>
    `${ref.environmentId}:${ref.threadId}`;
  return {
    environmentThreadShells: {
      quietThreadShellAtom: (ref: { environmentId: string; threadId: string }) =>
        Atom.make(harness.shells.get(key(ref)) ?? null),
    },
    environmentThreadDetails: {
      quietThreadAtom: (ref: { environmentId: string; threadId: string }) =>
        Atom.make(harness.details.get(key(ref)) ?? null),
    },
  };
});

import { appAtomRegistry } from "./atom-registry";
import {
  activeComposerDraftKey,
  beginQueuedRunEdit,
  getQueuedRunEdit,
  queuedEditDraftKey,
  rebindQueuedEditContext,
  removeQueuedRunEditAttachment,
  resolveQueuedEditPayload,
  type QueuedRunEdit,
} from "./queued-run-edit";
import { threadComposerErrorsAtom } from "./thread-composer-error";
import { getComposerDraftSnapshot, setComposerDraftText } from "./use-composer-drafts";
import { getStagedThreadSettings } from "./use-thread-staged-settings";

const image = (id: string): ChatAttachment => ({
  type: "image",
  id: ChatAttachmentId.make(id),
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 10,
});

function edit(attachments: ReadonlyArray<ChatAttachment>): QueuedRunEdit {
  return {
    runId: RunId.make("run-1"),
    messageId: MessageId.make("message-1"),
    originalText: "original",
    existingAttachments: attachments,
  };
}

function context(attachmentIds: ReadonlyArray<string>): OrchestrationMessageContext {
  return {
    version: 1,
    records: attachmentIds.map((attachmentId, index) => ({
      version: 1,
      kind: "image",
      contextId: ComposerContextId.make(`ctx-${index}`),
      label: `${attachmentId}.png`,
      attachmentId,
      name: `${attachmentId}.png`,
      mimeType: "image/png",
      sizeBytes: 10,
    })),
  };
}

function queuedRuns(runId: RunId) {
  return Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
    { id: runId, status: "queued" },
  ]);
}

/** Resolves with the next composer notice set for the thread. */
function nextComposerError(threadKey: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const cancel = appAtomRegistry.subscribe(threadComposerErrorsAtom, (errors) => {
      const message = errors[threadKey]?.message;
      if (message === undefined) return;
      cancel();
      resolve(message);
    });
  });
}

describe("resolveQueuedEditPayload", () => {
  it("resends the kept server attachments ahead of the newly uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([image("kept")]),
      draftContext: undefined,
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept", "uploaded"]);
  });

  it("rebinds context records from the draft's ids to the uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([]),
      draftContext: context(["draft-1"]),
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.context?.records).toEqual([
      expect.objectContaining({ attachmentId: "uploaded" }),
    ]);
  });

  it("drops the record of an attachment the user removed", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([image("kept")]),
      draftContext: context(["kept", "gone"]),
      draftAttachments: [],
      uploaded: [],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept"]);
    expect(payload.context?.records).toEqual([expect.objectContaining({ attachmentId: "kept" })]);
  });
});

describe("rebindQueuedEditContext", () => {
  it("points saved-attachment chips at the rescued copies and leaves the rest alone", () => {
    const rebound = rebindQueuedEditContext(
      context(["saved-1", "new-draft"]),
      new Map([["saved-1", "local-1"]]),
    );
    expect(
      rebound?.records.map((record) => ("attachmentId" in record ? record.attachmentId : null)),
    ).toEqual(["local-1", "new-draft"]);
    expect(rebindQueuedEditContext(undefined, new Map([["saved-1", "local-1"]]))).toBeUndefined();
  });
});

describe("beginQueuedRunEdit", () => {
  it("appends a changed edit to an occupied draft and stages its model, without the composer mounted", async () => {
    const threadKey = "env-exit:thread-exit";
    const runId = RunId.make("run-1");
    const threadModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
    const runModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
    harness.shells.set(threadKey, {
      modelSelection: threadModel,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    harness.details.set(threadKey, {
      projection: { runs: [{ id: runId, modelSelection: runModel }] },
    });
    const runs = queuedRuns(runId);
    setComposerDraftText(threadKey, "other work");
    beginQueuedRunEdit(threadKey, { ...edit([]), inputOrigin: "voice-transcription" }, runs);
    setComposerDraftText(queuedEditDraftKey(threadKey, runId), "changed");
    const notice = nextComposerError(threadKey);

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(await notice).toBe(
      "That message is no longer queued. Your edit is back in the composer.",
    );
    const draft = getComposerDraftSnapshot(threadKey);
    expect(draft.text).toContain("other work");
    expect(draft.text).toContain("changed");
    expect(getStagedThreadSettings(threadKey)?.modelSelection).toEqual({
      value: runModel,
      baseline: threadModel,
    });
  });

  it("brings saved attachments back and reports the ones it could not download", async () => {
    const threadKey = "env-exit:thread-saved";
    const runId = RunId.make("run-1");
    const runs = queuedRuns(runId);
    beginQueuedRunEdit(threadKey, edit([image("kept")]), runs);
    setComposerDraftText(queuedEditDraftKey(threadKey, runId), "changed");
    const notice = nextComposerError(threadKey);

    appAtomRegistry.set(runs, [{ id: runId, status: "cancelled" }]);

    expect(await notice).toBe(
      "That message is no longer queued. Your edit is back in the composer without 1 saved attachment that could not be downloaded.",
    );
  });

  it("discards an edit cleared to nothing when the run starts", () => {
    const threadKey = "env-exit:thread-cleared";
    const runId = RunId.make("run-1");
    const runs = queuedRuns(runId);
    beginQueuedRunEdit(threadKey, edit([]), runs);
    setComposerDraftText(queuedEditDraftKey(threadKey, runId), "");

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("");
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toBe(
      "That message is no longer queued, so the edit was discarded.",
    );
  });

  it("closes an untouched edit silently", () => {
    const threadKey = "env-exit:thread-untouched";
    const runId = RunId.make("run-1");
    const runs = queuedRuns(runId);
    beginQueuedRunEdit(threadKey, edit([]), runs);

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]).toBeUndefined();
  });

  it("treats a removed server attachment as a change when the run starts", async () => {
    const threadKey = "env-exit:thread-removed";
    const runId = RunId.make("run-1");
    const runs = queuedRuns(runId);
    beginQueuedRunEdit(threadKey, edit([image("kept"), image("other")]), runs);
    removeQueuedRunEditAttachment(threadKey, "kept");
    const notice = nextComposerError(threadKey);

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(await notice).toContain("Your edit is back in the composer");
  });
});

describe("activeComposerDraftKey", () => {
  const threadKey = "env:thread";
  const editKey = queuedEditDraftKey(threadKey, RunId.make("run-1"));

  it("keeps a queued edit's draft while that edit is open", () => {
    expect(activeComposerDraftKey(threadKey, editKey, edit([]))).toBe(editKey);
  });

  it("falls back to the thread's draft once the edit has ended", () => {
    expect(activeComposerDraftKey(threadKey, editKey, null)).toBe(threadKey);
  });
});
