import { describe, expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import { createThreadOutboxDelivery } from "./threadOutboxDelivery.ts";
import type { QueuedThreadMessage, ThreadSettingsSnapshot } from "./threadOutboxModel.ts";

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
    const delivery = createThreadOutboxDelivery({
      commands: {
        startTurn,
        updateMetadata,
        setRuntimeMode: vi.fn(async () => AsyncResult.success(undefined)),
        setInteractionMode: vi.fn(async () => AsyncResult.success(undefined)),
      },
      removeQueuedMessage,
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

    await expect(delivery.sendQueuedMessage(message, threadSettings)).resolves.toBe(true);
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
    expect(calls).toEqual(["metadata", "metadata", "start-turn", "remove"]);
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
});
