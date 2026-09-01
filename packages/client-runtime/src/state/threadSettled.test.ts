// @effect-diagnostics globalDate:off -- Tests exercise local calendar snooze boundaries.
import { ThreadId, TurnId, type OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSnooze,
  effectiveSnoozed,
  hasQueuedTurnStart,
  resolveSnoozePresets,
  snoozeWakeLabel,
  threadLastActivityAt,
  threadWokeAt,
  type ThreadSnoozeShell,
} from "./threadSettled.ts";

const NOW = "2026-04-10T12:00:00.000Z";
const SNOOZED_AT = "2026-04-10T09:00:00.000Z";
const FUTURE_WAKE = "2026-04-11T09:00:00.000Z";

type QueuedTurnShell = Pick<
  OrchestrationThreadShell,
  "latestUserMessageAt" | "latestTurn" | "session"
>;

function makeQueuedTurnShell(overrides: Partial<QueuedTurnShell> = {}): QueuedTurnShell {
  return { latestUserMessageAt: null, latestTurn: null, session: null, ...overrides };
}

function makeSnoozeShell(input: {
  readonly snoozedAt?: string | null;
  readonly snoozedUntil?: string | null;
  readonly pendingApproval?: boolean;
  readonly completedAt?: string | null;
}): ThreadSnoozeShell {
  return {
    snoozedAt: input.snoozedAt ?? null,
    snoozedUntil: input.snoozedUntil ?? null,
    hasPendingApprovals: input.pendingApproval ?? false,
    hasPendingUserInput: false,
    session: null,
    latestTurn:
      input.completedAt === undefined
        ? null
        : {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: SNOOZED_AT,
            startedAt: null,
            completedAt: input.completedAt,
            assistantMessageId: null,
          },
  };
}

describe("threadLastActivityAt", () => {
  it("returns the latest user or turn timestamp", () => {
    expect(
      threadLastActivityAt({
        latestUserMessageAt: "2026-04-04T00:00:00.000Z",
        latestTurn: {
          turnId: TurnId.make("turn-activity"),
          state: "completed",
          requestedAt: "2026-04-03T00:00:00.000Z",
          startedAt: "2026-04-05T00:00:00.000Z",
          completedAt: "2026-04-06T00:00:00.000Z",
          assistantMessageId: null,
        },
      }),
    ).toBe("2026-04-06T00:00:00.000Z");
  });

  it("returns null without parseable activity", () => {
    expect(threadLastActivityAt({ latestUserMessageAt: null, latestTurn: null })).toBeNull();
    expect(threadLastActivityAt({ latestUserMessageAt: "bad", latestTurn: null })).toBeNull();
  });
});

describe("hasQueuedTurnStart", () => {
  it("detects a fresh user message no turn has adopted", () => {
    expect(
      hasQueuedTurnStart(makeQueuedTurnShell({ latestUserMessageAt: "2026-04-10T11:59:00.000Z" }), {
        now: NOW,
      }),
    ).toBe(true);
  });

  it("expires queued state and clears it after adoption or failure", () => {
    expect(
      hasQueuedTurnStart(makeQueuedTurnShell({ latestUserMessageAt: "2026-04-10T11:57:59.000Z" }), {
        now: NOW,
      }),
    ).toBe(false);

    const messageAt = "2026-04-10T11:59:00.000Z";
    expect(
      hasQueuedTurnStart(
        makeQueuedTurnShell({
          latestUserMessageAt: messageAt,
          latestTurn: {
            turnId: TurnId.make("turn-adopted"),
            state: "running",
            requestedAt: messageAt,
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
        { now: NOW },
      ),
    ).toBe(false);

    expect(
      hasQueuedTurnStart(
        makeQueuedTurnShell({
          latestUserMessageAt: messageAt,
          session: {
            threadId: ThreadId.make("thread-failed"),
            status: "error",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "failed",
            updatedAt: NOW,
          },
        }),
        { now: NOW },
      ),
    ).toBe(false);
  });
});

describe("canSnooze", () => {
  it("allows working threads but rejects blocked or queued work", () => {
    const quiet = makeQueuedTurnShell();
    expect(
      canSnooze({ ...quiet, hasPendingApprovals: false, hasPendingUserInput: false }, { now: NOW }),
    ).toBe(true);
    expect(
      canSnooze({ ...quiet, hasPendingApprovals: true, hasPendingUserInput: false }, { now: NOW }),
    ).toBe(false);
    expect(
      canSnooze(
        {
          ...quiet,
          latestUserMessageAt: "2026-04-10T11:59:00.000Z",
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        },
        { now: NOW },
      ),
    ).toBe(false);
  });
});

describe("indefinite snooze", () => {
  it("stays hidden until it raises its hand", () => {
    const snoozed = makeSnoozeShell({ snoozedAt: SNOOZED_AT });
    expect(effectiveSnoozed(snoozed, { now: NOW })).toBe(true);
    expect(threadWokeAt(snoozed, { now: NOW })).toBeNull();

    const woke = makeSnoozeShell({
      snoozedAt: SNOOZED_AT,
      completedAt: "2026-04-10T10:30:00.000Z",
    });
    expect(effectiveSnoozed(woke, { now: NOW })).toBe(false);
    expect(threadWokeAt(woke, { now: NOW })).toBe("2026-04-10T10:30:00.000Z");
  });

  it("does not hide malformed lone snooze markers", () => {
    const malformed = makeSnoozeShell({ snoozedAt: "not-a-date" });
    expect(effectiveSnoozed(malformed, { now: NOW })).toBe(false);
    expect(threadWokeAt(malformed, { now: NOW })).toBeNull();
  });
});

describe("timed snooze helpers", () => {
  it("reports timer wakes and compact remaining time", () => {
    const woke = makeSnoozeShell({
      snoozedAt: SNOOZED_AT,
      snoozedUntil: "2026-04-10T10:00:00.000Z",
    });
    expect(effectiveSnoozed(woke, { now: NOW })).toBe(false);
    expect(threadWokeAt(woke, { now: NOW })).toBe("2026-04-10T10:00:00.000Z");
    expect(snoozeWakeLabel(FUTURE_WAKE, { now: NOW })).toBe("21h");
  });

  it("keeps shared calendar presets available", () => {
    const ids = resolveSnoozePresets(new Date(2026, 3, 8, 10)).map((preset) => preset.id);
    expect(ids).toEqual(["hour", "three-hours", "evening", "tomorrow", "next-week"]);
  });
});
