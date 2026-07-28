import { describe, expect, it } from "vite-plus/test";

import { MessageId, ProjectId } from "@t3tools/contracts";

import {
  isSteerWaitingOutGraceWindow,
  pruneExpeditedQueuedMessageIds,
  queueFlushBatchIds,
  soonestSteerGraceRemainingMs,
  STEER_GRACE_WINDOW_MS,
  steerGraceRemainingMs,
} from "./threadOutboxModel.ts";

const createdAt = "2026-07-27T10:00:00.000Z";
const createdAtMs = Date.parse(createdAt);

describe("steerGraceRemainingMs", () => {
  it("holds a fresh steer for the whole window", () => {
    expect(steerGraceRemainingMs({ deliveryIntent: "steer", createdAt }, createdAtMs)).toBe(
      STEER_GRACE_WINDOW_MS,
    );
  });

  it("counts the window down", () => {
    expect(steerGraceRemainingMs({ deliveryIntent: "steer", createdAt }, createdAtMs + 2_000)).toBe(
      STEER_GRACE_WINDOW_MS - 2_000,
    );
  });

  it("releases the steer once the window elapses", () => {
    expect(
      steerGraceRemainingMs(
        { deliveryIntent: "steer", createdAt },
        createdAtMs + STEER_GRACE_WINDOW_MS,
      ),
    ).toBe(0);
    expect(
      steerGraceRemainingMs({ deliveryIntent: "steer", createdAt }, createdAtMs + 60_000),
    ).toBe(0);
  });

  it("never holds a queued message — the running turn already does", () => {
    expect(steerGraceRemainingMs({ deliveryIntent: "queue", createdAt }, createdAtMs)).toBe(0);
    expect(steerGraceRemainingMs({ createdAt }, createdAtMs)).toBe(0);
  });

  it("sends immediately when the timestamp is unreadable", () => {
    // Better a steer that skips its window than one stuck in the queue.
    expect(steerGraceRemainingMs({ deliveryIntent: "steer", createdAt: "nonsense" }, 0)).toBe(0);
  });

  it("sends immediately when the timestamp is in the future", () => {
    expect(
      steerGraceRemainingMs(
        { deliveryIntent: "steer", createdAt: "2099-01-01T00:00:00.000Z" },
        createdAtMs,
      ),
    ).toBe(0);
  });

  it("does not resurrect a window for a steer promoted from an old queued message", () => {
    // The row action flips intent on a message queued long ago; the user asked
    // for it now, so it must not wait again.
    expect(
      steerGraceRemainingMs({ deliveryIntent: "steer", createdAt }, createdAtMs + 3_600_000),
    ).toBe(0);
  });
});

describe("soonestSteerGraceRemainingMs", () => {
  it("returns the earliest live grace deadline and ignores queued or expired rows", () => {
    expect(
      soonestSteerGraceRemainingMs(
        [
          { deliveryIntent: "queue", createdAt },
          { deliveryIntent: "steer", createdAt },
          { deliveryIntent: "steer", createdAt: "2026-07-27T10:00:01.000Z" },
          { deliveryIntent: "steer", createdAt: "2026-07-27T09:59:00.000Z" },
        ],
        createdAtMs + 2_000,
      ),
    ).toBe(3_000);
  });

  it("returns null when no grace deadline remains", () => {
    expect(
      soonestSteerGraceRemainingMs(
        [
          { deliveryIntent: "queue", createdAt },
          { deliveryIntent: "steer", createdAt: "2026-07-27T09:59:00.000Z" },
        ],
        createdAtMs,
      ),
    ).toBeNull();
  });
});

describe("isSteerWaitingOutGraceWindow", () => {
  const messageId = MessageId.make("queued-1");
  const message = { deliveryIntent: "steer" as const, createdAt, messageId };

  it("holds a steer that is still inside its window", () => {
    expect(isSteerWaitingOutGraceWindow(message, { nowMs: createdAtMs, expedited: {} })).toBe(true);
  });

  it("releases a steer the user asked to send now", () => {
    // Expediting retires the window rather than shortening it: the point of
    // the wait is second thoughts, and there are none.
    expect(
      isSteerWaitingOutGraceWindow(message, {
        nowMs: createdAtMs,
        expedited: { [messageId]: true },
      }),
    ).toBe(false);
  });

  it("holds nothing once the window has elapsed", () => {
    expect(
      isSteerWaitingOutGraceWindow(message, {
        nowMs: createdAtMs + STEER_GRACE_WINDOW_MS,
        expedited: {},
      }),
    ).toBe(false);
  });
});

describe("queueFlushBatchIds", () => {
  const a = { messageId: MessageId.make("a"), creation: undefined };
  const b = { messageId: MessageId.make("b"), creation: undefined };

  it("covers only rows behind a successful idle-thread leader", () => {
    const ids = queueFlushBatchIds([a, b], a, {
      delivered: true,
      action: "send",
      threadStatus: "idle",
    });

    expect(ids.has(MessageId.make("a"))).toBe(false);
    expect(ids.has(MessageId.make("b"))).toBe(true);
  });

  it("leaves rows ahead of the leader out — they are not in the turn it started", () => {
    const c = { messageId: MessageId.make("c"), creation: undefined };
    const ids = queueFlushBatchIds([a, b, c], b, {
      delivered: true,
      action: "send",
      threadStatus: "idle",
    });

    expect(ids.has(MessageId.make("a"))).toBe(false);
    expect(ids.has(MessageId.make("c"))).toBe(true);
  });

  it("does not open a batch for a steer dispatched into a running turn", () => {
    expect(
      queueFlushBatchIds([a, b], b, {
        delivered: true,
        action: "send",
        threadStatus: "running",
      }).size,
    ).toBe(0);
  });

  it("does not open a batch for stale-row removal", () => {
    expect(
      queueFlushBatchIds([a, b], a, {
        delivered: true,
        action: "remove",
        threadStatus: null,
      }).size,
    ).toBe(0);
  });

  it("leaves pending-task creations out — they start their own threads", () => {
    const creation = {
      messageId: MessageId.make("creation"),
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "local" as const,
        branch: null,
        worktreePath: null,
      },
    };
    const ids = queueFlushBatchIds([a, creation, b], a, {
      delivered: true,
      action: "send",
      threadStatus: "idle",
    });

    expect(ids.has(MessageId.make("creation"))).toBe(false);
    expect(ids.has(MessageId.make("b"))).toBe(true);
    expect(
      queueFlushBatchIds([creation, a], creation, {
        delivered: true,
        action: "send",
        threadStatus: null,
      }).size,
    ).toBe(0);
  });

  it("does not activate until the leader dispatch succeeds", () => {
    expect(
      queueFlushBatchIds([a, b], a, {
        delivered: false,
        action: "send",
        threadStatus: "idle",
      }).size,
    ).toBe(0);
  });
});

describe("pruneExpeditedQueuedMessageIds", () => {
  const retained = MessageId.make("retained");
  const removed = MessageId.make("removed");

  it("drops only ids whose row and in-flight ownership are both gone", () => {
    expect(
      pruneExpeditedQueuedMessageIds({ [retained]: true, [removed]: true }, new Set([retained])),
    ).toEqual({ [retained]: true });
  });

  it("preserves identity when every expedite latch is still live", () => {
    const expedited = { [retained]: true } as const;
    expect(pruneExpeditedQueuedMessageIds(expedited, new Set([retained]))).toBe(expedited);
  });
});
