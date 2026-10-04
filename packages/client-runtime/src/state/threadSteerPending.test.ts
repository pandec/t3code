import {
  MessageId,
  RunId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2Now, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { unreadSteerMessageIds, type SteerPendingThreadSnapshot } from "./threadSteerPending.ts";

const runId = RunId.make("run-1");

const base = (id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId: v2ThreadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: v2Now,
  completedAt: v2Now,
  updatedAt: v2Now,
});

function userMessage(
  id: string,
  ordinal: number,
  inputIntent: Extract<OrchestrationV2TurnItem, { type: "user_message" }>["inputIntent"],
): OrchestrationV2TurnItem {
  return {
    ...base(id, ordinal),
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make(id),
    inputIntent,
    text: id,
    attachments: [],
  };
}

function assistant(id: string, ordinal: number): OrchestrationV2TurnItem {
  return {
    ...base(id, ordinal),
    type: "assistant_message",
    messageId: MessageId.make(id),
    text: "ok",
    streaming: false,
  };
}

function notice(id: string, ordinal: number): OrchestrationV2TurnItem {
  return { ...base(id, ordinal), type: "system_notice", message: "note" };
}

function snapshot(
  status: OrchestrationV2Run["status"],
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): SteerPendingThreadSnapshot {
  return { runs: [{ id: runId, status }], turnItems };
}

describe("unreadSteerMessageIds", () => {
  it("marks steers the agent has not produced output after, in order", () => {
    const items = [
      userMessage("opening", 1, "turn_start"),
      assistant("before", 2),
      userMessage("steer-b", 4, "promoted_queued_to_steer"),
      userMessage("steer-a", 3, "steer"),
      notice("notice", 5),
    ];
    expect(unreadSteerMessageIds(snapshot("running", items))).toEqual([
      MessageId.make("steer-a"),
      MessageId.make("steer-b"),
    ]);
  });

  it("clears steers once main-agent output is recorded after them", () => {
    const items = [
      userMessage("opening", 1, "turn_start"),
      userMessage("read", 2, "steer"),
      assistant("reply", 3),
      userMessage("unread", 4, "steer"),
    ];
    expect(unreadSteerMessageIds(snapshot("running", items))).toEqual([MessageId.make("unread")]);
  });

  it("ignores output attributed to a parent item", () => {
    const items = [
      userMessage("steer", 2, "steer"),
      { ...assistant("nested", 3), parentItemId: TurnItemId.make("tool") },
    ];
    expect(unreadSteerMessageIds(snapshot("running", items))).toEqual([MessageId.make("steer")]);
  });

  it("resolves every steer once the run ends", () => {
    const items = [userMessage("opening", 1, "turn_start"), userMessage("steer", 2, "steer")];
    expect(unreadSteerMessageIds(snapshot("waiting", items))).toEqual([MessageId.make("steer")]);
    for (const status of ["completed", "interrupted", "failed", "cancelled"] as const) {
      expect(unreadSteerMessageIds(snapshot(status, items))).toEqual([]);
    }
  });
});
