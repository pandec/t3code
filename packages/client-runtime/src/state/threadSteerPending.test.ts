// @effect-diagnostics globalDate:off -- fixtures build ISO timestamps at fixed offsets from one base.
import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  MessageId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  createThreadSteerPendingStore,
  isSteerStillUnread,
  latestParentAgentProgressAt,
  nextSteerPendingRevealDelayMs,
  revealedSteerPendingMessageIds,
  shouldTrackSteerDispatch,
  STEER_PENDING_REVEAL_DELAY_MS,
  unreadSteerDispatches,
  type PendingSteerDispatch,
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

function assistantMessage(createdAt: string): OrchestrationMessage {
  return {
    id: MessageId.make(`assistant-${createdAt}`),
    role: "assistant",
    text: "on it",
    turnId,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

const runningThread: SteerPendingThreadSnapshot = {
  sessionStatus: "running",
  latestTurn: { turnId, state: "running" },
  messages: [],
  activities: [blockingToolStarted],
};

const pendingSteer: PendingSteerDispatch = {
  messageId: steerMessageId,
  dispatchedAt: at(10),
  progressWatermarkAt: at(0),
  turnId,
};

describe("shouldTrackSteerDispatch", () => {
  it("tracks a steer that landed on a turn already running", () => {
    expect(shouldTrackSteerDispatch({ deliveryIntent: "steer", sessionStatus: "running" })).toBe(
      true,
    );
  });

  it("ignores a plain queued send", () => {
    expect(shouldTrackSteerDispatch({ deliveryIntent: "queue", sessionStatus: "running" })).toBe(
      false,
    );
  });

  it("ignores a steer that started its own turn", () => {
    // Drained after the turn settled, or after the grace window outlived it:
    // nothing queues behind a tool call, so there is nothing to wait for.
    expect(shouldTrackSteerDispatch({ deliveryIntent: "steer", sessionStatus: "idle" })).toBe(
      false,
    );
    expect(shouldTrackSteerDispatch({ deliveryIntent: "steer", sessionStatus: "starting" })).toBe(
      false,
    );
    expect(shouldTrackSteerDispatch({ deliveryIntent: "steer", sessionStatus: null })).toBe(false);
  });
});

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

describe("isSteerStillUnread", () => {
  it("stays pending while the parent is blocked in its tool call", () => {
    expect(isSteerStillUnread(pendingSteer, runningThread)).toBe(true);
  });

  it("is unmoved by subagent activity streaming under the blocked parent", () => {
    // The whole point of the marker: a subagent narrates continuously while the
    // parent has not looked at its prompt queue once.
    expect(
      isSteerStillUnread(pendingSteer, {
        ...runningThread,
        activities: [
          blockingToolStarted,
          activity({ id: "sub-tool", createdAt: at(20), payload: { agentId: "agent-1" } }),
          activity({ id: "sub-task", kind: "task.progress", createdAt: at(30) }),
          activity({ id: "sub-tokens", kind: "context-window.updated", createdAt: at(40) }),
          activity({ id: "sub-bypass", createdAt: at(50), payload: { timelineBypass: true } }),
        ],
      }),
    ).toBe(true);
  });

  it("resolves once the main agent starts its next tool", () => {
    expect(
      isSteerStillUnread(pendingSteer, {
        ...runningThread,
        activities: [blockingToolStarted, activity({ id: "next", createdAt: at(60) })],
      }),
    ).toBe(false);
  });

  it("resolves once the main agent answers in prose", () => {
    expect(
      isSteerStillUnread(pendingSteer, { ...runningThread, messages: [assistantMessage(at(60))] }),
    ).toBe(false);
  });

  it("ignores main-agent work that predates the dispatch", () => {
    expect(
      isSteerStillUnread(pendingSteer, {
        ...runningThread,
        messages: [assistantMessage(at(-30))],
        activities: [activity({ id: "earlier", createdAt: at(-10) }), blockingToolStarted],
      }),
    ).toBe(true);
  });

  it("uses the server progress watermark when the client clock is skewed", () => {
    expect(
      isSteerStillUnread(
        { ...pendingSteer, dispatchedAt: "2099-01-01T00:00:00.000Z" },
        {
          ...runningThread,
          activities: [blockingToolStarted, activity({ id: "next", createdAt: at(60) })],
        },
      ),
    ).toBe(false);
  });

  it("resolves when the turn completes", () => {
    expect(
      isSteerStillUnread(pendingSteer, {
        ...runningThread,
        sessionStatus: "ready",
        latestTurn: { turnId, state: "completed" },
      }),
    ).toBe(false);
  });

  it("resolves when the turn is interrupted or errors", () => {
    expect(
      isSteerStillUnread(pendingSteer, {
        ...runningThread,
        sessionStatus: "interrupted",
        latestTurn: { turnId, state: "interrupted" },
      }),
    ).toBe(false);
    expect(
      isSteerStillUnread(pendingSteer, {
        ...runningThread,
        sessionStatus: "error",
        latestTurn: { turnId, state: "error" },
      }),
    ).toBe(false);
    expect(isSteerStillUnread(pendingSteer, { ...runningThread, latestTurn: null })).toBe(false);
  });

  it("resolves when the provider answered the steer with a turn of its own", () => {
    // Codex injects a mid-turn message at the protocol level and opens a fresh
    // turn for it, so the turn the steer joined no longer being current means
    // it was taken. No provider gate needed.
    expect(
      isSteerStillUnread(pendingSteer, {
        ...runningThread,
        latestTurn: { turnId: otherTurnId, state: "running" },
      }),
    ).toBe(false);
  });
});

describe("unreadSteerDispatches", () => {
  it("keeps array identity while nothing resolves", () => {
    const pending = [pendingSteer];
    expect(unreadSteerDispatches(pending, runningThread)).toBe(pending);
  });

  it("drops the steers the agent has read", () => {
    expect(
      unreadSteerDispatches([pendingSteer], {
        ...runningThread,
        activities: [blockingToolStarted, activity({ id: "next", createdAt: at(60) })],
      }),
    ).toStrictEqual([]);
  });
});

describe("reveal delay", () => {
  it("hides a steer that may still be read within a round trip", () => {
    const dispatchedAtMs = Date.parse(pendingSteer.dispatchedAt);
    expect(revealedSteerPendingMessageIds([pendingSteer], dispatchedAtMs).size).toBe(0);
    expect(nextSteerPendingRevealDelayMs([pendingSteer], dispatchedAtMs)).toBe(
      STEER_PENDING_REVEAL_DELAY_MS,
    );
    expect([
      ...revealedSteerPendingMessageIds(
        [pendingSteer],
        dispatchedAtMs + STEER_PENDING_REVEAL_DELAY_MS,
      ),
    ]).toStrictEqual([steerMessageId]);
    expect(
      nextSteerPendingRevealDelayMs([pendingSteer], dispatchedAtMs + STEER_PENDING_REVEAL_DELAY_MS),
    ).toBeNull();
  });
});

describe("createThreadSteerPendingStore", () => {
  const makeStore = () => {
    const registry = AtomRegistry.make();
    const store = createThreadSteerPendingStore({ registry, atomLabel: "test" });
    return { store, read: () => registry.get(store.pendingByThreadKeyAtom) };
  };

  it("replaces a re-tracked message instead of duplicating it", () => {
    const { store, read } = makeStore();
    store.retain("env:thread");
    store.track("env:thread", pendingSteer);
    store.track("env:thread", { ...pendingSteer, dispatchedAt: at(20) });
    expect(read()["env:thread"]).toStrictEqual([{ ...pendingSteer, dispatchedAt: at(20) }]);
  });

  it("drops a thread's key once nothing is pending for it", () => {
    const { store, read } = makeStore();
    store.retain("env:thread");
    store.track("env:thread", pendingSteer);
    store.setThread("env:thread", []);
    expect(read()).toStrictEqual({});
  });

  it("keeps only the active thread and rejects late deliveries after release", () => {
    const { store, read } = makeStore();
    store.retain("env:left");
    store.track("env:left", pendingSteer);

    store.retain("env:open");
    store.track("env:left", pendingSteer);
    store.track("env:open", pendingSteer);
    expect(Object.keys(read())).toStrictEqual(["env:open"]);

    store.release("env:open");
    store.track("env:open", pendingSteer);
    expect(read()).toStrictEqual({});
  });

  it("holds the lease until the last view of a thread releases it", () => {
    const { store, read } = makeStore();
    // Mobile's files route stacks a second view of the same thread over the
    // first; closing it must not stop the still-mounted one from marking.
    store.retain("env:thread");
    store.retain("env:thread");
    store.release("env:thread");
    store.track("env:thread", pendingSteer);
    expect(read()["env:thread"]).toStrictEqual([pendingSteer]);

    store.release("env:thread");
    store.track("env:thread", pendingSteer);
    expect(read()).toStrictEqual({});
  });

  it("ignores a release from a view left behind by an earlier thread", () => {
    const { store, read } = makeStore();
    store.retain("env:left");
    store.retain("env:open");
    store.release("env:left");
    store.track("env:open", pendingSteer);
    expect(read()["env:open"]).toStrictEqual([pendingSteer]);
  });

  it("caps the active thread at eight pending steers", () => {
    const { store, read } = makeStore();
    store.retain("env:thread");
    for (let index = 0; index < 10; index += 1) {
      store.track("env:thread", {
        ...pendingSteer,
        messageId: MessageId.make(`steer-${index}`),
      });
    }
    expect(read()["env:thread"]?.map(({ messageId }) => messageId)).toStrictEqual(
      Array.from({ length: 8 }, (_, index) => MessageId.make(`steer-${index + 2}`)),
    );
  });
});
