// @effect-diagnostics globalDate:off -- Tests exercise local calendar snooze boundaries.
import { ThreadId } from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSnooze,
  canSnoozeUntilDone,
  effectiveSnoozed,
  resolveSnoozePresets,
  snoozeWakeSortMs,
  threadRaisedHandWhileSnoozed,
  threadWokeAt,
  threadWokeOnFinishedWork,
  isThreadWokeUnseen,
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
  readonly turnRequestedAt?: string | null;
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
            requestedAt: input.turnRequestedAt === undefined ? SNOOZED_AT : input.turnRequestedAt,
            startedAt: null,
            completedAt: input.turnCompletedAt,
            assistantMessageId: null,
          },
  };
}

describe("effectiveSnoozed", () => {
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

  it.each([
    {
      reason: "stale failure",
      completedAt: "2026-04-10T08:00:00.000Z",
      pending: undefined,
      wokeAt: null,
    },
    {
      reason: "fresh failure",
      completedAt: "2026-04-10T10:00:00.000Z",
      pending: undefined,
      wokeAt: "2026-04-10T10:00:00.000Z",
    },
    {
      reason: "approval after a stale failure",
      completedAt: "2026-04-10T08:00:00.000Z",
      pending: "approval",
      wokeAt: "2026-04-10T11:00:00.000Z",
    },
    {
      reason: "input after a stale failure",
      completedAt: "2026-04-10T08:00:00.000Z",
      pending: "user-input",
      wokeAt: "2026-04-10T11:00:00.000Z",
    },
  ] as const)(
    "uses the wake event time for $reason despite newer metadata",
    ({ completedAt, pending, wokeAt }) => {
      const shell: ThreadSnoozeShell = {
        ...makeShell({ snoozedUntil: FUTURE_WAKE }),
        hasPendingApprovals: pending === "approval",
        hasPendingUserInput: pending === "user-input",
        runtime: { status: "failed", updatedAt: "2026-04-10T11:00:00.000Z" },
        latestRun: { status: "failed", requestedAt: "2026-04-10T07:00:00.000Z", completedAt },
      };
      expect(effectiveSnoozed(shell, { now: NOW })).toBe(wokeAt === null);
      expect(threadWokeAt(shell, { now: NOW })).toBe(wokeAt);
    },
  );

  it("stays snoozed while the session keeps working — snooze never pauses the agent", () => {
    expect(
      effectiveSnoozed(makeShell({ snoozedUntil: FUTURE_WAKE, sessionStatus: "running" }), {
        now: NOW,
      }),
    ).toBe(true);
  });

  it("stays snoozed when a run requested after the snooze completes", () => {
    const shell = {
      ...makeShell({ snoozedUntil: FUTURE_WAKE }),
      latestRun: {
        status: "completed",
        requestedAt: "2026-04-10T09:00:00.001Z",
        startedAt: "2026-04-10T09:15:00.000Z",
        completedAt: "2026-04-10T10:30:00.000Z",
      },
    };

    expect(effectiveSnoozed(shell, { now: NOW })).toBe(true);
    expect(threadWokeAt(shell, { now: NOW })).toBe(null);
  });
});

describe("legacy snooze without a wake time (fork)", () => {
  it("reads a stored marker with no wake time and no awaited run as awake", () => {
    const legacy = makeShell({ snoozedAt: SNOOZED_AT });
    expect(effectiveSnoozed(legacy, { now: NOW })).toBe(false);
    expect(threadWokeAt(legacy, { now: NOW })).toBeNull();
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

  // Fork: queued messages carry the work on; the server follows each one as it starts.
  it("holds while queued messages wait, whichever run it last followed", () => {
    const queued = untilDone({ status: "queued", runId: "run-3" });
    expect(effectiveSnoozed(queued, { now: NOW })).toBe(true);
    expect(threadWokeAt(queued, { now: NOW })).toBeNull();
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

  it("leads the snoozed shelf", () => {
    expect(snoozeWakeSortMs({ snoozedUntil: null, snoozedUntilRunId: "run-1" })).toBeLessThan(
      snoozeWakeSortMs({ snoozedUntil: NOW }),
    );
  });
});

describe("threadRaisedHandWhileSnoozed", () => {
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
  it("refuses blocked-on-you work", () => {
    expect(canSnooze(makeShell({ pending: "approval" }))).toBe(false);
    expect(canSnooze(makeShell({ pending: "user-input" }))).toBe(false);
    expect(canSnooze({ ...makeShell({}), pendingSubagentRequest: "approval" })).toBe(false);
  });

  it("refuses a run that has not started yet", () => {
    for (const status of ["preparing", "queued", "starting"]) {
      expect(canSnooze({ ...makeShell({}), runtime: { status } })).toBe(false);
    }
  });

  it("allows a running thread whose newest message was steered into the run", () => {
    // The cancelled steer run ends 1ms before the message is recorded into
    // the running run, so the message is newer than every latestRun stamp.
    // Real shells carry latestUserMessageAt; canSnooze must ignore it.
    const steered = {
      ...makeShell({}),
      runtime: { status: "running" },
      latestUserMessageAt: "2026-04-10T11:59:18.488Z",
      latestRun: {
        status: "cancelled",
        requestedAt: "2026-04-10T11:59:17.628Z",
        startedAt: null,
        completedAt: "2026-04-10T11:59:18.487Z",
      },
    };
    expect(canSnooze(steered)).toBe(true);
  });
});

describe("threadWokeAt", () => {
  it("reports the timer wake even after an already-requested run completes", () => {
    expect(threadWokeAt(makeShell({ snoozedUntil: PAST_WAKE }), { now: NOW })).toBe(PAST_WAKE);
    const shell = makeShell({
      snoozedUntil: PAST_WAKE,
      turnCompletedAt: "2026-04-10T09:30:00.000Z",
    });
    expect(effectiveSnoozed(shell, { now: NOW })).toBe(false);
    expect(threadWokeAt(shell, { now: NOW })).toBe(PAST_WAKE);
  });

  it.each([
    { reason: "failure", sessionStatus: "error" },
    { reason: "approval", sessionStatus: "ready", pending: "approval" },
    { reason: "user input", sessionStatus: "ready", pending: "user-input" },
  ] as const)("reports $reason activity instead of an already-requested completion", (activity) => {
    const shell = makeShell({
      ...activity,
      snoozedUntil: FUTURE_WAKE,
      turnCompletedAt: "2026-04-10T10:30:00.000Z",
    });
    expect(effectiveSnoozed(shell, { now: NOW })).toBe(false);
    expect(threadWokeAt(shell, { now: NOW })).toBe("2026-04-10T11:00:00.000Z");
  });

  it("tells finished-work wakes from timer wakes", () => {
    expect(threadWokeOnFinishedWork(makeShell({ snoozedUntil: PAST_WAKE }))).toBe(false);
    expect(
      threadWokeOnFinishedWork(makeShell({ snoozedUntil: FUTURE_WAKE, pending: "approval" })),
    ).toBe(false);
    // A run that ended before the snooze is not what woke it.
    expect(
      threadWokeOnFinishedWork(
        makeShell({ snoozedUntil: PAST_WAKE, turnCompletedAt: "2026-04-10T08:00:00.000Z" }),
      ),
    ).toBe(false);
    // A timed snooze stays hidden through a finished run, so that never wakes it.
    expect(
      threadWokeOnFinishedWork(
        makeShell({ snoozedUntil: FUTURE_WAKE, turnCompletedAt: "2026-04-10T10:30:00.000Z" }),
      ),
    ).toBe(false);
    expect(
      threadWokeOnFinishedWork({
        ...makeShell({ snoozedAt: SNOOZED_AT }),
        snoozedUntilRunId: "run-1",
      }),
    ).toBe(true);
  });

  it("keeps the early wake authoritative after the scheduled time passes", () => {
    const shell: ThreadSnoozeShell = {
      ...makeShell({ snoozedUntil: PAST_WAKE }),
      runtime: { status: "failed", updatedAt: "2026-04-10T11:00:00.000Z" },
      latestRun: {
        status: "failed",
        requestedAt: "2026-04-10T09:15:00.000Z",
        completedAt: "2026-04-10T09:30:00.000Z",
      },
    };
    expect(threadWokeAt(shell, { now: NOW })).toBe("2026-04-10T09:30:00.000Z");
  });
});

describe("resolveSnoozePresets", () => {
  it("drops the evening choice once evening is near or past", () => {
    expect(resolveSnoozePresets(localDate(2026, 4, 8, 17, 30)).map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "tomorrow",
      "next-week",
    ]);
  });

  it("drops next week on Sundays, when it lands on the same Monday as tomorrow", () => {
    // Sunday 2026-08-30 07:01: "Tomorrow" and "Next week" are both Monday 6:00.
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

it("dismisses a wake at its timestamp without hiding a later wake", () => {
  const firstWake = "2026-04-10T10:00:00.000Z";
  const state = {
    wokeAt: firstWake,
    settled: false,
    lastVisitedAt: null,
    latestRunCompletedAt: null,
  };
  expect(isThreadWokeUnseen(state)).toBe(true);
  expect(isThreadWokeUnseen({ ...state, lastVisitedAt: firstWake })).toBe(false);
  expect(isThreadWokeUnseen({ ...state, lastVisitedAt: firstWake, wokeAt: NOW })).toBe(true);
});
