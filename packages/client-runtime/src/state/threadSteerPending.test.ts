// @effect-diagnostics globalDate:off -- fixtures build ISO timestamps at fixed offsets from one base.
import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  MessageId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import {
  latestParentAgentProgressAt,
  unreadSteerMessageIds,
  type SteerPendingThreadSnapshot,
} from "./threadSteerPending.ts";

const turnId = TurnId.make("turn-1");
const otherTurnId = TurnId.make("turn-2");
const steerMessageId = MessageId.make("steer-1");

const at = (seconds: number): string =>
  new Date(Date.parse("2026-07-27T10:00:00.000Z") + seconds * 1_000).toISOString();

/** The blocking parent tool call the steer is queued behind. */
const blockingToolStarted: OrchestrationThreadActivity = {
  id: EventId.make("activity-blocking"),
  tone: "tool",
  kind: "tool.started",
  summary: "Agent started",
  payload: { itemType: "tool", title: "Agent" },
  turnId,
  createdAt: at(0),
};

function activity(
  overrides: Partial<Omit<OrchestrationThreadActivity, "id">> & { readonly id: string },
): OrchestrationThreadActivity {
  return {
    ...blockingToolStarted,
    ...overrides,
    id: EventId.make(overrides.id),
  };
}

function message(
  overrides: Partial<Omit<OrchestrationMessage, "id">> & { readonly id: string },
): OrchestrationMessage {
  return {
    role: "user",
    text: "steer",
    turnId: null,
    streaming: false,
    createdAt: at(10),
    updatedAt: at(10),
    ...overrides,
    id: MessageId.make(overrides.id),
  };
}

const assistantMessage = (createdAt: string): OrchestrationMessage =>
  message({ id: `assistant-${createdAt}`, role: "assistant", text: "on it", turnId, createdAt });

/** The user message that opened the turn shares the turn's requestedAt. */
const openingMessage = message({ id: "opening", createdAt: at(-60) });
const steer = message({ id: steerMessageId, createdAt: at(10) });

const runningThread: SteerPendingThreadSnapshot = {
  sessionStatus: "running",
  latestTurn: { turnId, state: "running", requestedAt: at(-60) },
  messages: [openingMessage, steer],
  activities: [blockingToolStarted],
};

describe("latestParentAgentProgressAt", () => {
  it("takes the newest main-agent tool start or assistant message", () => {
    expect(
      latestParentAgentProgressAt({
        messages: [assistantMessage(at(1))],
        activities: [blockingToolStarted, activity({ id: "later", createdAt: at(5) })],
      }),
    ).toBe(at(5));
  });

  it("ignores subagent work entirely", () => {
    expect(
      latestParentAgentProgressAt({
        messages: [],
        activities: [
          activity({ id: "owned", createdAt: at(9), payload: { agentId: "agent-1" } }),
          activity({ id: "bypass", createdAt: at(9), payload: { timelineBypass: true } }),
          activity({ id: "task", kind: "task.progress", createdAt: at(9) }),
          activity({ id: "tokens", kind: "context-window.updated", createdAt: at(9) }),
          blockingToolStarted,
        ],
      }),
    ).toBe(at(0));
  });
});

describe("unreadSteerMessageIds", () => {
  it("marks a steer while the parent is blocked in its tool call", () => {
    expect(unreadSteerMessageIds(runningThread)).toStrictEqual([steerMessageId]);
  });

  it("never marks the message that opened the turn", () => {
    expect(unreadSteerMessageIds({ ...runningThread, messages: [openingMessage] })).toStrictEqual(
      [],
    );
  });

  it("is unmoved by subagent activity streaming under the blocked parent", () => {
    // The whole point of the marker: a subagent narrates continuously while the
    // parent has not looked at its prompt queue once.
    expect(
      unreadSteerMessageIds({
        ...runningThread,
        activities: [
          blockingToolStarted,
          activity({ id: "sub-tool", createdAt: at(20), payload: { agentId: "agent-1" } }),
          activity({ id: "sub-task", kind: "task.progress", createdAt: at(30) }),
          activity({ id: "sub-tokens", kind: "context-window.updated", createdAt: at(40) }),
          activity({ id: "sub-bypass", createdAt: at(50), payload: { timelineBypass: true } }),
        ],
      }),
    ).toStrictEqual([steerMessageId]);
  });

  it("resolves once the main agent starts its next tool", () => {
    expect(
      unreadSteerMessageIds({
        ...runningThread,
        activities: [blockingToolStarted, activity({ id: "next", createdAt: at(60) })],
      }),
    ).toStrictEqual([]);
  });

  it("resolves once the main agent answers in prose", () => {
    expect(
      unreadSteerMessageIds({
        ...runningThread,
        messages: [...runningThread.messages, assistantMessage(at(60))],
      }),
    ).toStrictEqual([]);
  });

  it("keeps only the steers newer than the last main-agent progress", () => {
    const later = message({ id: "steer-2", createdAt: at(70) });
    expect(
      unreadSteerMessageIds({
        ...runningThread,
        messages: [openingMessage, steer, later],
        activities: [blockingToolStarted, activity({ id: "next", createdAt: at(60) })],
      }),
    ).toStrictEqual([later.id]);
  });

  it("ignores main-agent work that predates the steer", () => {
    expect(
      unreadSteerMessageIds({
        ...runningThread,
        messages: [openingMessage, assistantMessage(at(-30)), steer],
        activities: [activity({ id: "earlier", createdAt: at(-10) }), blockingToolStarted],
      }),
    ).toStrictEqual([steerMessageId]);
  });

  it("resolves when the turn completes", () => {
    expect(
      unreadSteerMessageIds({
        ...runningThread,
        sessionStatus: "ready",
        latestTurn: { ...runningThread.latestTurn!, state: "completed" },
      }),
    ).toStrictEqual([]);
  });

  it("resolves when the turn is interrupted, errors, or is gone", () => {
    expect(
      unreadSteerMessageIds({
        ...runningThread,
        sessionStatus: "interrupted",
        latestTurn: { ...runningThread.latestTurn!, state: "interrupted" },
      }),
    ).toStrictEqual([]);
    expect(
      unreadSteerMessageIds({
        ...runningThread,
        sessionStatus: "error",
        latestTurn: { ...runningThread.latestTurn!, state: "error" },
      }),
    ).toStrictEqual([]);
    expect(unreadSteerMessageIds({ ...runningThread, latestTurn: null })).toStrictEqual([]);
  });

  it("resolves when the provider answered the steer with a turn of its own", () => {
    // Codex injects a mid-turn message at the protocol level and opens a fresh
    // turn for it. The steer is now that turn's opening message: it is not
    // newer than the turn it belongs to, so nothing is waiting.
    expect(
      unreadSteerMessageIds({
        ...runningThread,
        latestTurn: { turnId: otherTurnId, state: "running", requestedAt: at(10) },
      }),
    ).toStrictEqual([]);
  });
});
