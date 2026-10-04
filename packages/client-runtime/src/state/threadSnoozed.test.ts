// @effect-diagnostics globalDate:off -- Tests exercise local calendar snooze boundaries.
import { ThreadId } from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSnooze,
  canSnoozeUntilDone,
  effectiveSnoozed,
  hasQueuedTurnStart,
  resolveSnoozePresets,
  snoozeShelfLabel,
  snoozeWakeLabel,
  snoozeWakeSortMs,
  threadRaisedHandWhileSnoozed,
  threadWokeAt,
  type ThreadSnoozeShell,
} from "./threadSettled.ts";

const NOW = "2026-04-10T12:00:00.000Z";
const SNOOZED_AT = "2026-04-10T09:00:00.000Z";
const FUTURE_WAKE = "2026-04-11T09:00:00.000Z";
const PAST_WAKE = "2026-04-10T10:00:00.000Z";

function localDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function makeShell(input: {
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly sessionStatus?: "starting" | "running" | "ready" | "error";
  readonly pending?: "approval" | "user-input";
  readonly turnCompletedAt?: string | null;
}): ThreadSnoozeShell {
  const threadId = ThreadId.make("thread-1");
  return {
    snoozedUntil: input.snoozedUntil ?? null,
    snoozedAt: input.snoozedAt ?? (input.snoozedUntil != null ? SNOOZED_AT : null),
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: input.pending === "user-input",
    session:
      input.sessionStatus === undefined
        ? null
        : {
            threadId,
            status: input.sessionStatus,
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: input.sessionStatus === "error" ? "boom" : null,
            updatedAt: "2026-04-10T11:00:00.000Z",
          },
    latestTurn:
      input.turnCompletedAt === undefined
        ? null
        : {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: SNOOZED_AT,
            startedAt: null,
            completedAt: input.turnCompletedAt,
            assistantMessageId: null,
          },
  };
}

type QueuedTurnShell = Parameters<typeof hasQueuedTurnStart>[0];

function makeQueuedTurnShell(overrides: Partial<QueuedTurnShell> = {}): QueuedTurnShell {
  return { latestUserMessageAt: null, latestTurn: null, session: null, ...overrides };
}

describe("effectiveSnoozed", () => {
  it("hides a thread whose wake time is in the future", () => {
    expect(effectiveSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE }), { now: NOW })).toBe(true);
  });

  it("stops classifying as snoozed once the wake time passes (timer wake, no event)", () => {
    expect(effectiveSnoozed(makeShell({ snoozedUntil: PAST_WAKE }), { now: NOW })).toBe(false);
  });

  it("never snoozes a thread with no snooze state", () => {
    expect(effectiveSnoozed(makeShell({}), { now: NOW })).toBe(false);
  });

  it("never hides on malformed wake data", () => {
    expect(effectiveSnoozed(makeShell({ snoozedUntil: "not-a-date" }), { now: NOW })).toBe(false);
  });

  it("wakes early when the agent is blocked on the user", () => {
    expect(
      effectiveSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, pending: "approval" }), {
        now: NOW,
      }),
    ).toBe(false);
    expect(
      effectiveSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, pending: "user-input" }), {
        now: NOW,
      }),
    ).toBe(false);
  });

  it("wakes early on a failure that happened after the snooze", () => {
    // makeShell stamps session.updatedAt at 11:00, after SNOOZED_AT (9:00).
    expect(
      effectiveSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, sessionStatus: "error" }), {
        now: NOW,
      }),
    ).toBe(false);
  });

  it("stays snoozed when the failure predates the snooze — the user saw it", () => {
    expect(
      effectiveSnoozed(
        makeShell({
          snoozedUntil: FUTURE_WAKE,
          sessionStatus: "error",
          // Snoozed AFTER the error's status edge.
          snoozedAt: "2026-04-10T11:30:00.000Z",
        }),
        { now: NOW },
      ),
    ).toBe(true);
  });

  it("stays snoozed while the session keeps working — snooze never pauses the agent", () => {
    expect(
      effectiveSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, sessionStatus: "running" }), {
        now: NOW,
      }),
    ).toBe(true);
  });

  it("wakes early when a run completes after the snooze was set", () => {
    expect(
      effectiveSnoozed(
        makeShell({ snoozedUntil: FUTURE_WAKE, turnCompletedAt: "2026-04-10T10:30:00.000Z" }),
        { now: NOW },
      ),
    ).toBe(false);
  });

  it("ignores runs that completed before the snooze — the user saw that result", () => {
    expect(
      effectiveSnoozed(
        makeShell({ snoozedUntil: FUTURE_WAKE, turnCompletedAt: "2026-04-10T08:00:00.000Z" }),
        { now: NOW },
      ),
    ).toBe(true);
  });
});

describe("indefinite snooze (fork)", () => {
  const parked = makeShell({ snoozedAt: SNOOZED_AT });

  it("stays snoozed without a wake time and never wakes by timer", () => {
    expect(effectiveSnoozed(parked, { now: "2099-01-01T00:00:00.000Z" })).toBe(true);
    expect(threadWokeAt(parked, { now: "2099-01-01T00:00:00.000Z" })).toBeNull();
  });

  it("never hides a thread on a malformed marker", () => {
    expect(effectiveSnoozed(makeShell({ snoozedAt: "garbage" }), { now: NOW })).toBe(false);
    expect(threadWokeAt(makeShell({ snoozedAt: "garbage" }), { now: NOW })).toBeNull();
  });

  it("wakes when the thread needs attention", () => {
    const blocked = makeShell({ snoozedAt: SNOOZED_AT, pending: "approval" });
    expect(effectiveSnoozed(blocked, { now: NOW })).toBe(false);
    const failed = makeShell({ snoozedAt: SNOOZED_AT, sessionStatus: "error" });
    expect(effectiveSnoozed(failed, { now: NOW })).toBe(false);
  });

  it("wakes on any ended run after the snooze, where timed snoozes need completion", () => {
    const completedAt = "2026-04-10T11:30:00.000Z";
    const interrupted = (snoozedUntil: string | null): ThreadSnoozeShell => {
      const shell = makeShell({
        snoozedUntil,
        snoozedAt: SNOOZED_AT,
        turnCompletedAt: completedAt,
      });
      return { ...shell, latestTurn: { ...shell.latestTurn!, state: "interrupted" } };
    };
    expect(effectiveSnoozed(interrupted(null), { now: NOW })).toBe(false);
    expect(threadWokeAt(interrupted(null), { now: NOW })).toBe(completedAt);
    expect(effectiveSnoozed(interrupted(FUTURE_WAKE), { now: NOW })).toBe(true);
  });

  it("sorts after every timed snooze", () => {
    expect(snoozeWakeSortMs({ snoozedUntil: null })).toBeGreaterThan(
      snoozeWakeSortMs({ snoozedUntil: "2099-01-01T00:00:00.000Z" }),
    );
  });
});

describe("snooze until done (fork)", () => {
  const ENDED_AT = "2026-04-10T11:30:00.000Z";
  const untilDone = (input: {
    readonly status: string;
    readonly runId?: string;
    readonly completedAt?: string | null;
    readonly tasks?: ReadonlyArray<{ readonly kind: string }>;
    readonly pending?: "approval";
  }): ThreadSnoozeShell => ({
    ...makeShell({ snoozedAt: SNOOZED_AT, ...(input.pending ? { pending: input.pending } : {}) }),
    snoozedUntilRunId: "run-1",
    pendingBackgroundTasks: input.tasks ?? [],
    latestRun: {
      runId: input.runId ?? "run-1",
      status: input.status,
      requestedAt: "2026-04-10T11:00:00.000Z",
      startedAt: null,
      completedAt: input.completedAt ?? null,
    },
  });

  it("holds while the awaited run is live, and through its subagents after it ends", () => {
    for (const shell of [
      untilDone({ status: "running" }),
      untilDone({ status: "queued" }),
      untilDone({ status: "completed", completedAt: ENDED_AT, tasks: [{ kind: "subagent" }] }),
      untilDone({ status: "interrupted", completedAt: ENDED_AT, tasks: [{ kind: "subagent" }] }),
    ]) {
      expect(effectiveSnoozed(shell, { now: NOW })).toBe(true);
      expect(threadWokeAt(shell, { now: NOW })).toBeNull();
    }
  });

  it("wakes when the work ends, even with watch loops left running", () => {
    for (const tasks of [[], [{ kind: "monitor" }, { kind: "command" }]]) {
      const ended = untilDone({ status: "completed", completedAt: ENDED_AT, tasks });
      expect(effectiveSnoozed(ended, { now: NOW })).toBe(false);
      expect(threadWokeAt(ended, { now: NOW })).toBe(ENDED_AT);
    }
    const interrupted = untilDone({ status: "interrupted", completedAt: ENDED_AT });
    expect(threadWokeAt(interrupted, { now: NOW })).toBe(ENDED_AT);
  });

  it("wakes when the work is replaced, fails, or needs the user", () => {
    const replaced = untilDone({ status: "running", runId: "run-2" });
    expect(effectiveSnoozed(replaced, { now: NOW })).toBe(false);
    expect(threadWokeAt(replaced, { now: NOW })).toBe("2026-04-10T11:00:00.000Z");
    const failed = untilDone({ status: "failed", tasks: [{ kind: "subagent" }] });
    expect(effectiveSnoozed(failed, { now: NOW })).toBe(false);
    const blocked = untilDone({ status: "running", pending: "approval" });
    expect(effectiveSnoozed(blocked, { now: NOW })).toBe(false);
  });

  it("is offered only while a run is live or its subagents work", () => {
    expect(canSnoozeUntilDone(untilDone({ status: "running" }))).toBe(true);
    expect(
      canSnoozeUntilDone(untilDone({ status: "completed", tasks: [{ kind: "subagent" }] })),
    ).toBe(true);
    expect(
      canSnoozeUntilDone(untilDone({ status: "completed", tasks: [{ kind: "monitor" }] })),
    ).toBe(false);
    expect(canSnoozeUntilDone({ latestRun: null, latestTurn: null })).toBe(false);
  });

  it("leads the snoozed shelf and labels its rows", () => {
    expect(snoozeWakeSortMs({ snoozedUntil: null, snoozedUntilRunId: "run-1" })).toBeLessThan(
      snoozeWakeSortMs({ snoozedUntil: NOW }),
    );
    expect(snoozeShelfLabel({ snoozedUntilRunId: "run-1" })).toBe("until done");
    expect(snoozeShelfLabel({ snoozedUntilRunId: null })).toBe("parked");
  });
});

describe("threadRaisedHandWhileSnoozed", () => {
  it("is false for a quiet snoozed thread", () => {
    expect(threadRaisedHandWhileSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE }))).toBe(false);
  });

  it("is true for approvals, input, and failures", () => {
    expect(
      threadRaisedHandWhileSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, pending: "approval" })),
    ).toBe(true);
    expect(
      threadRaisedHandWhileSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, pending: "user-input" })),
    ).toBe(true);
    expect(
      threadRaisedHandWhileSnoozed(
        makeShell({ snoozedUntil: FUTURE_WAKE, sessionStatus: "error" }),
      ),
    ).toBe(true);
  });
});

describe("canSnooze", () => {
  it("allows snoozing quiet and working threads alike", () => {
    expect(canSnooze({ ...makeShell({}), latestUserMessageAt: null }, { now: NOW })).toBe(true);
    expect(
      canSnooze(
        { ...makeShell({ sessionStatus: "running" }), latestUserMessageAt: null },
        { now: NOW },
      ),
    ).toBe(true);
  });

  it("refuses blocked-on-you work", () => {
    expect(
      canSnooze({ ...makeShell({ pending: "approval" }), latestUserMessageAt: null }, { now: NOW }),
    ).toBe(false);
    expect(
      canSnooze(
        { ...makeShell({ pending: "user-input" }), latestUserMessageAt: null },
        { now: NOW },
      ),
    ).toBe(false);
  });

  it("refuses a queued turn start — same invisible-pending-work rule as settle", () => {
    // Fresh user message, no turn has adopted it, within the grace window.
    expect(
      canSnooze(
        { ...makeShell({}), latestUserMessageAt: "2026-04-10T11:59:30.000Z" },
        { now: NOW },
      ),
    ).toBe(false);
    // Outside the grace window the message is stale data, not queued work.
    expect(
      canSnooze(
        { ...makeShell({}), latestUserMessageAt: "2026-04-10T11:00:00.000Z" },
        { now: NOW },
      ),
    ).toBe(true);
  });
});

describe("hasQueuedTurnStart", () => {
  it("expires queued state after two minutes", () => {
    const thread = makeQueuedTurnShell({
      latestUserMessageAt: "2026-04-10T11:57:59.000Z",
    });
    expect(hasQueuedTurnStart(thread, { now: NOW })).toBe(false);
  });

  it("clears queued state when a turn adopts the message or the session fails", () => {
    const messageAt = "2026-04-10T11:59:00.000Z";
    const adopted = makeQueuedTurnShell({
      latestUserMessageAt: messageAt,
      latestTurn: {
        turnId: TurnId.make("turn-adopted"),
        state: "running",
        requestedAt: messageAt,
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const failed = makeQueuedTurnShell({
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
    });
    expect(hasQueuedTurnStart(adopted, { now: NOW })).toBe(false);
    expect(hasQueuedTurnStart(failed, { now: NOW })).toBe(false);
  });

  it("bounds future client clock skew", () => {
    const farAhead = makeQueuedTurnShell({
      latestUserMessageAt: "2026-04-10T12:03:00.000Z",
    });
    const slightlyAhead = makeQueuedTurnShell({
      latestUserMessageAt: "2026-04-10T12:01:00.000Z",
    });
    expect(hasQueuedTurnStart(farAhead, { now: NOW })).toBe(false);
    expect(hasQueuedTurnStart(slightlyAhead, { now: NOW })).toBe(true);
  });
});

describe("threadWokeAt", () => {
  it("is null for never-snoozed and still-snoozed threads", () => {
    expect(threadWokeAt(makeShell({}), { now: NOW })).toBe(null);
    expect(threadWokeAt(makeShell({ snoozedUntil: FUTURE_WAKE }), { now: NOW })).toBe(null);
  });

  it("reports the wake time for a timer wake", () => {
    expect(threadWokeAt(makeShell({ snoozedUntil: PAST_WAKE }), { now: NOW })).toBe(PAST_WAKE);
  });

  it("reports the completion time for an early run-completed wake", () => {
    expect(
      threadWokeAt(
        makeShell({ snoozedUntil: FUTURE_WAKE, turnCompletedAt: "2026-04-10T10:30:00.000Z" }),
        { now: NOW },
      ),
    ).toBe("2026-04-10T10:30:00.000Z");
  });

  it("falls back to session activity for blocked/failed early wakes", () => {
    expect(
      threadWokeAt(makeShell({ snoozedUntil: FUTURE_WAKE, sessionStatus: "error" }), {
        now: NOW,
      }),
    ).toBe("2026-04-10T11:00:00.000Z");
  });

  it("keeps the early wake authoritative after the scheduled time passes", () => {
    // Woke early at 10:30 via run-completed; the scheduled wake (PAST_WAKE
    // 10:00 relative to a later now) has ALSO passed. Reporting the
    // scheduled time would resurface a Woke pill the user already cleared
    // by visiting between the early wake and now.
    expect(
      threadWokeAt(
        makeShell({ snoozedUntil: PAST_WAKE, turnCompletedAt: "2026-04-10T09:30:00.000Z" }),
        { now: NOW },
      ),
    ).toBe("2026-04-10T09:30:00.000Z");
  });
});

describe("snoozeWakeLabel", () => {
  const now = "2026-06-02T00:00:00.000Z";

  it("formats remaining time coarsely, rounding up", () => {
    expect(snoozeWakeLabel("2026-06-02T00:30:00.000Z", { now })).toBe("30m");
    expect(snoozeWakeLabel("2026-06-02T01:30:00.000Z", { now })).toBe("2h");
    expect(snoozeWakeLabel("2026-06-03T02:00:00.000Z", { now })).toBe("2d");
  });

  it("never reads zero or negative while still snoozed", () => {
    expect(snoozeWakeLabel("2026-06-02T00:00:30.000Z", { now })).toBe("1m");
    expect(snoozeWakeLabel("2026-06-01T23:59:59.000Z", { now })).toBe("now");
    expect(snoozeWakeLabel("not-a-date", { now })).toBe("now");
    expect(snoozeWakeLabel("2026-06-02T09:00:00.000Z", { now: "bad" })).toBe("now");
  });
});

describe("resolveSnoozePresets", () => {
  it("offers the shared desktop and mobile choices", () => {
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10));
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    expect(presets.find((preset) => preset.id === "three-hours")?.snoozedUntil).toBe(
      localDate(2026, 4, 8, 13).toISOString(),
    );
    expect(presets.find((preset) => preset.id === "three-hours")?.label).toBe("In 3 hours");
    expect(presets.find((preset) => preset.id === "evening")?.label).toBe("This evening");
    expect(
      new Date(presets.find((preset) => preset.id === "tomorrow")!.snoozedUntil).getHours(),
    ).toBe(9);
  });

  it("drops the evening choice once evening is near or past", () => {
    expect(resolveSnoozePresets(localDate(2026, 4, 8, 17, 30)).map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "tomorrow",
      "next-week",
    ]);
  });

  it("puts next week on the following Monday", () => {
    const nextWeek = new Date(
      resolveSnoozePresets(localDate(2026, 4, 6, 10)).find((preset) => preset.id === "next-week")!
        .snoozedUntil,
    );
    expect(nextWeek.getDay()).toBe(1);
    expect(nextWeek.getDate()).toBe(13);
  });

  it("drops next week on Sundays, when it lands on the same Monday as tomorrow", () => {
    // Sunday 2026-08-30 07:01: "Tomorrow" and "Next week" are both Monday 9:00.
    const presets = resolveSnoozePresets(localDate(2026, 8, 30, 7, 1));
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
    ]);
    const tomorrow = new Date(presets.find((preset) => preset.id === "tomorrow")!.snoozedUntil);
    expect(tomorrow.getDay()).toBe(1);
  });
});
