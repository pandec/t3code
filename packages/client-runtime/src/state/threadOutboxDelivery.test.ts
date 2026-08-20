import { describe, expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  createThreadOutboxDelivery,
  type ThreadOutboxDeliveryContext,
} from "./threadOutboxDelivery.ts";
import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type QueuedThreadMessage,
  type ThreadSettingsSnapshot,
} from "./threadOutboxModel.ts";

const baseModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
  options: [],
};

function queuedMessage(overrides: Partial<QueuedThreadMessage> = {}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    commandId: CommandId.make("command-1"),
    text: "Queued prompt",
    attachments: [],
    createdAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

const threadSettings: ThreadSettingsSnapshot = {
  modelSelection: baseModelSelection,
  branch: "dev",
  runtimeMode: "full-access",
  interactionMode: "default",
};

describe("thread outbox delivery", () => {
  it("persists the existing-thread settings fallback", () => {
    const message = queuedMessage({ threadSettings });
    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(message)).threadSettings).toEqual(
      threadSettings,
    );
  });

  it("syncs queued branch and model snapshots with payload-stable command ids", async () => {
    const calls: string[] = [];
    const updateMetadata = vi.fn(async () => {
      calls.push("metadata");
      return AsyncResult.success(undefined);
    });
    const startTurn = vi.fn(async () => {
      calls.push("start-turn");
      return AsyncResult.success(undefined);
    });
    const removeQueuedMessage = vi.fn(async () => {
      calls.push("remove");
    });
    const onStartTurnAccepted = vi.fn(() => {
      calls.push("start-accepted");
    });
    const onDelivered = vi.fn(() => {
      calls.push("delivered");
    });
    const delivery = createThreadOutboxDelivery({
      commands: {
        startTurn,
        updateMetadata,
        setRuntimeMode: vi.fn(async () => AsyncResult.success(undefined)),
        setInteractionMode: vi.fn(async () => AsyncResult.success(undefined)),
      },
      removeQueuedMessage,
      onStartTurnAccepted,
      onDelivered,
      warn: () => undefined,
    });
    const nextModelSelection = {
      ...baseModelSelection,
      model: "gpt-5.5",
    };
    const message = queuedMessage({
      modelSelection: nextModelSelection,
      localCheckoutBranch: "feature/queued-message",
    });

    const deliveryContext: ThreadOutboxDeliveryContext = {
      sessionStatus: "running",
      latestTurnId: TurnId.make("turn-1"),
    };
    await expect(
      delivery.sendQueuedMessage(message, threadSettings, deliveryContext),
    ).resolves.toBe(true);
    expect(updateMetadata).toHaveBeenCalledTimes(2);
    expect(updateMetadata).toHaveBeenNthCalledWith(1, {
      environmentId: message.environmentId,
      input: {
        commandId: CommandId.make("command-1:model-selection"),
        threadId: message.threadId,
        modelSelection: nextModelSelection,
      },
    });
    expect(updateMetadata).toHaveBeenNthCalledWith(2, {
      environmentId: message.environmentId,
      input: {
        commandId: CommandId.make("command-1:branch"),
        threadId: message.threadId,
        branch: "feature/queued-message",
        worktreePath: null,
      },
    });
    // The send-time turn reaches the callback so a steer that joined a running
    // turn can be told apart from one that started its own.
    expect(onStartTurnAccepted).toHaveBeenCalledWith(message, threadSettings, deliveryContext);
    expect(onDelivered).toHaveBeenCalledWith(message, threadSettings, deliveryContext);
    expect(calls).toEqual([
      "metadata",
      "metadata",
      "start-turn",
      "start-accepted",
      "remove",
      "delivered",
    ]);
  });

  it("does not update branch metadata for legacy messages without a snapshot", async () => {
    const updateMetadata = vi.fn(async () => AsyncResult.success(undefined));
    const delivery = createThreadOutboxDelivery({
      commands: {
        startTurn: vi.fn(async () => AsyncResult.success(undefined)),
        updateMetadata,
        setRuntimeMode: vi.fn(async () => AsyncResult.success(undefined)),
        setInteractionMode: vi.fn(async () => AsyncResult.success(undefined)),
      },
      removeQueuedMessage: vi.fn(async () => undefined),
      warn: () => undefined,
    });

    await expect(delivery.sendQueuedMessage(queuedMessage(), threadSettings)).resolves.toBe(true);
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it("keeps a delivered message complete when its notification callback throws", async () => {
    const warn = vi.fn();
    const delivery = createThreadOutboxDelivery({
      commands: {
        startTurn: vi.fn(async () => AsyncResult.success(undefined)),
        updateMetadata: vi.fn(async () => AsyncResult.success(undefined)),
        setRuntimeMode: vi.fn(async () => AsyncResult.success(undefined)),
        setInteractionMode: vi.fn(async () => AsyncResult.success(undefined)),
      },
      removeQueuedMessage: vi.fn(async () => undefined),
      onDelivered: () => {
        throw new Error("refresh failed");
      },
      warn,
    });

    await expect(delivery.sendQueuedMessage(queuedMessage(), threadSettings)).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "[thread-outbox] delivered-message callback failed",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
});
