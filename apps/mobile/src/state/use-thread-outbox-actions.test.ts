import { afterEach, describe, expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { vi } from "vite-plus/test";

import type { QueuedThreadMessage } from "./thread-outbox-model";

// The import chain reaches React Native modules that read this global.
vi.hoisted(() => {
  (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false;
});

const calls: string[] = [];
const updatedMessages: QueuedThreadMessage[] = [];
let alertButtons: ReadonlyArray<{ readonly text?: string; readonly onPress?: () => void }> = [];
let alertOnDismiss: (() => void) | undefined;
let appendStatus: "committed" | "failed" = "committed";
let removeResult = true;

vi.mock("./shell", () => ({
  environmentShell: {
    stateValueAtom: () => {
      throw new Error("not used by queued-edit ordering tests");
    },
  },
}));

vi.mock("react-native", () => ({
  Alert: {
    alert: (
      _title: string,
      _message: string,
      buttons: ReadonlyArray<{ readonly text?: string; readonly onPress?: () => void }>,
      options?: { readonly onDismiss?: () => void },
    ) => {
      alertButtons = buttons;
      alertOnDismiss = options?.onDismiss;
    },
  },
}));

// The drain pulls in React Native surface this test does not exercise; only its
// dispatch atom matters here.
vi.mock("./use-thread-outbox-drain", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { dispatchingQueuedMessageIdAtom: Atom.make<string | null>(null).pipe(Atom.keepAlive) };
});

vi.mock("./thread-outbox", () => ({
  removeThreadOutboxMessage: () => {
    calls.push("remove");
    return Promise.resolve(removeResult);
  },
  updateThreadOutboxMessage: (updatedMessage: QueuedThreadMessage) => {
    updatedMessages.push(updatedMessage);
    return Promise.resolve(true);
  },
}));

vi.mock("./use-composer-drafts", () => ({
  appendComposerDraftContentDurably: (_key: string, content: { text: string }) => {
    calls.push("append");
    return Promise.resolve({
      status: appendStatus,
      before: { text: "", attachments: [] },
      appended: { text: content.text, attachments: [] },
    });
  },
  appendedComposerDraftText: (existing: string, addition: string) =>
    existing.length > 0 ? `${existing}\n\n${addition}` : addition,
  composerDraftStillContainsAppend: () => true,
  getComposerDraftSnapshot: () => ({ text: "", attachments: [] }),
  revertComposerDraftAppend: () => {
    calls.push("revert");
    return Promise.resolve({ fullyReverted: true, persisted: true });
  },
  updateComposerDraftSettings: () => {},
}));

import { appAtomRegistry } from "./atom-registry";
import { confirmDeleteQueuedMessage, editQueuedMessage } from "./use-thread-outbox-actions";
import { editingQueuedMessageIdsAtom } from "./use-thread-outbox";

const message: QueuedThreadMessage = {
  environmentId: EnvironmentId.make("environment-local"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("queued-1"),
  commandId: CommandId.make("command-1"),
  text: "queued body",
  attachments: [],
  createdAt: "2026-07-27T00:00:00.000Z",
};

afterEach(() => {
  calls.length = 0;
  updatedMessages.length = 0;
  alertButtons = [];
  alertOnDismiss = undefined;
  appendStatus = "committed";
  removeResult = true;
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
  vi.useRealTimers();
});

describe("confirmDeleteQueuedMessage", () => {
  it("holds the queued message while the confirmation is open", () => {
    confirmDeleteQueuedMessage(message);

    expect(appAtomRegistry.get(editingQueuedMessageIdsAtom)).toEqual({
      [message.messageId]: true,
    });
    expect(alertButtons.map(({ text }) => text)).toEqual(["Cancel", "Delete"]);
  });

  it("restarts the grace window when deletion is canceled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:05.000Z"));
    confirmDeleteQueuedMessage(message);

    alertButtons.find(({ text }) => text === "Cancel")?.onPress?.();
    alertOnDismiss?.();
    await Promise.resolve();

    expect(updatedMessages).toEqual([{ ...message, createdAt: "2026-07-27T00:00:05.000Z" }]);
    expect(appAtomRegistry.get(editingQueuedMessageIdsAtom)).toEqual({});
    expect(calls).not.toContain("remove");
  });

  it("keeps the hold through confirmed deletion", async () => {
    confirmDeleteQueuedMessage(message);

    alertButtons.find(({ text }) => text === "Delete")?.onPress?.();
    expect(appAtomRegistry.get(editingQueuedMessageIdsAtom)).toEqual({
      [message.messageId]: true,
    });
    await Promise.resolve();

    expect(calls).toContain("remove");
    expect(updatedMessages).toEqual([]);
    expect(appAtomRegistry.get(editingQueuedMessageIdsAtom)).toEqual({});
  });
});

describe("editQueuedMessage ordering", () => {
  it("appends to the draft before the durable queued row is removed", async () => {
    await editQueuedMessage(message);

    // Removing first would destroy the message whenever the append fails, which
    // is the bug this ordering exists to prevent.
    expect(calls).toEqual(["append", "remove"]);
  });

  it("keeps the row queued when the append does not commit", async () => {
    appendStatus = "failed";

    await editQueuedMessage(message);

    expect(calls).toEqual(["append", "revert"]);
    expect(calls).not.toContain("remove");
  });
});
