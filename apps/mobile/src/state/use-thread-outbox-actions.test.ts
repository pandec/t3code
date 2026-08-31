import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";

import {
  STEER_GRACE_WINDOW_MS,
  steerGraceRemainingMs,
  type QueuedThreadMessage,
} from "./thread-outbox-model";

// The import chain reaches React Native modules that read this global.
vi.hoisted(() => {
  (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false;
});

const calls: string[] = [];
const alertTitles: string[] = [];
const updatedMessages: QueuedThreadMessage[] = [];
const stagedSettingsCalls: Array<{
  readonly threadKey: string;
  readonly patch: Pick<QueuedThreadMessage, "modelSelection" | "runtimeMode" | "interactionMode">;
  readonly baselines: NonNullable<QueuedThreadMessage["threadSettings"]>;
}> = [];
let alertButtons: ReadonlyArray<{ readonly text?: string; readonly onPress?: () => void }> = [];
let alertOnDismiss: (() => void) | undefined;
let appendStatus: "committed" | "failed" = "committed";
let removeError: Error | null = null;

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
      title: string,
      _message: string,
      buttons?: ReadonlyArray<{ readonly text?: string; readonly onPress?: () => void }>,
      options?: { readonly onDismiss?: () => void },
    ) => {
      alertTitles.push(title);
      alertButtons = buttons ?? [];
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
  updateThreadOutboxMessage: (updatedMessage: QueuedThreadMessage) => {
    updatedMessages.push(updatedMessage);
    return Promise.resolve(true);
  },
}));

vi.mock("./thread-outbox-removal", () => ({
  removeThreadOutboxMessage: () => {
    calls.push("remove");
    return removeError ? Promise.reject(removeError) : Promise.resolve(true);
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
}));

vi.mock("./use-thread-staged-settings", () => ({
  stageThreadSettings: (
    threadKey: string,
    patch: (typeof stagedSettingsCalls)[number]["patch"],
    baselines: (typeof stagedSettingsCalls)[number]["baselines"],
  ) => {
    stagedSettingsCalls.push({ threadKey, patch, baselines });
  },
}));

import { appAtomRegistry } from "./atom-registry";
import { confirmDeleteQueuedMessage, editQueuedMessage } from "./use-thread-outbox-actions";
import {
  editingQueuedMessageIdsAtom,
  expeditedQueuedMessageIdsAtom,
  expediteQueuedMessage,
} from "./use-thread-outbox";

const message: QueuedThreadMessage = {
  environmentId: EnvironmentId.make("environment-local"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("queued-1"),
  commandId: CommandId.make("command-1"),
  text: "queued body",
  attachments: [],
  createdAt: "2026-07-27T00:00:00.000Z",
};
const steerMessage = { ...message, deliveryIntent: "steer" } satisfies QueuedThreadMessage;

afterEach(() => {
  calls.length = 0;
  alertTitles.length = 0;
  updatedMessages.length = 0;
  stagedSettingsCalls.length = 0;
  alertButtons = [];
  alertOnDismiss = undefined;
  appendStatus = "committed";
  removeError = null;
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
  appAtomRegistry.set(expeditedQueuedMessageIdsAtom, {});
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    expediteQueuedMessage(steerMessage.messageId);
    confirmDeleteQueuedMessage(steerMessage);

    alertButtons.find(({ text }) => text === "Cancel")?.onPress?.();
    alertOnDismiss?.();
    await Promise.resolve();

    expect(updatedMessages).toEqual([
      { ...steerMessage, graceStartedAt: "2026-07-27T00:00:05.000Z" },
    ]);
    expect(updatedMessages[0]?.createdAt).toBe(steerMessage.createdAt);
    expect(steerGraceRemainingMs(updatedMessages[0]!, Date.now())).toBe(STEER_GRACE_WINDOW_MS);
    expect(appAtomRegistry.get(expeditedQueuedMessageIdsAtom)).toEqual({});
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

  it("restores the grace window when confirmed deletion fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:05.000Z"));
    removeError = new Error("storage unavailable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    confirmDeleteQueuedMessage(steerMessage);

    alertButtons.find(({ text }) => text === "Delete")?.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(updatedMessages).toEqual([
      { ...steerMessage, graceStartedAt: "2026-07-27T00:00:05.000Z" },
    ]);
    expect(steerGraceRemainingMs(updatedMessages[0]!, Date.now())).toBe(STEER_GRACE_WINDOW_MS);
    expect(appAtomRegistry.get(editingQueuedMessageIdsAtom)).toEqual({});
    expect(alertTitles).toEqual(["Delete queued message?", "Could not delete this message"]);
    expect(warn).toHaveBeenCalledWith(
      "[thread-outbox] failed to delete queued message",
      removeError,
    );
  });
});

describe("editQueuedMessage ordering", () => {
  it("appends to the draft before the durable queued row is removed", async () => {
    await editQueuedMessage(message);

    // Removing first would destroy the message whenever the append fails, which
    // is the bug this ordering exists to prevent.
    expect(calls).toEqual(["append", "remove"]);
  });

  it("restores queued settings into the session-only staged store", async () => {
    const baselines = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      branch: "main",
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
    };
    const configuredMessage: QueuedThreadMessage = {
      ...message,
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-opus-4-1",
      },
      runtimeMode: "full-access",
      interactionMode: "plan",
      threadSettings: baselines,
    };

    await editQueuedMessage(configuredMessage);

    expect(stagedSettingsCalls).toEqual([
      {
        threadKey: `${message.environmentId}:${message.threadId}`,
        patch: {
          modelSelection: configuredMessage.modelSelection,
          runtimeMode: configuredMessage.runtimeMode,
          interactionMode: configuredMessage.interactionMode,
        },
        baselines,
      },
    ]);
  });

  it("keeps the row queued when the append does not commit", async () => {
    appendStatus = "failed";

    await editQueuedMessage(message);

    expect(calls).toEqual(["append", "revert"]);
    expect(calls).not.toContain("remove");
  });
});
