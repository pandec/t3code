import type { OrchestrationShellSnapshot, OrchestrationThreadShell } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import {
  evaluateThreadWait,
  type ThreadWaitOptions,
  type ThreadWaitOutcome,
  threadWaitExitCode,
} from "./threadWait.ts";

const NOW = "2026-08-08T12:00:00.000Z";
const TURN_ID = "turn-1";

const completedTurn = {
  turnId: TURN_ID,
  state: "completed",
  requestedAt: "2026-08-08T11:59:00.000Z",
  startedAt: "2026-08-08T11:59:01.000Z",
  completedAt: "2026-08-08T11:59:30.000Z",
  assistantMessageId: null,
} as OrchestrationThreadShell["latestTurn"];

const threadWith = (input: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell =>
  ({
    id: "thread-1",
    archivedAt: null,
    latestTurn: completedTurn,
    latestUserMessageAt: completedTurn?.requestedAt ?? null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    backgroundLiveness: null,
    ...input,
  }) as OrchestrationThreadShell;

const defaultOptions: ThreadWaitOptions = {
  afterSequence: null,
  turnId: null,
  timeoutMs: 30 * 60 * 1_000,
  drain: null,
  onBlocked: "return",
};

const evaluate = (input?: {
  readonly thread?: OrchestrationThreadShell | null;
  readonly sequence?: number;
  readonly options?: Partial<ThreadWaitOptions>;
  readonly deadlineReached?: boolean;
}) =>
  evaluateThreadWait({
    snapshot: {
      snapshotSequence: input?.sequence ?? 10,
      projects: [],
      threads: input?.thread === null ? [] : [input?.thread ?? threadWith()],
      updatedAt: NOW,
    } as OrchestrationShellSnapshot,
    threadId: "thread-1",
    options: { ...defaultOptions, ...input?.options },
    now: NOW,
    deadlineReached: input?.deadlineReached ?? false,
    observedThread: true,
  });

it("waits for the requested projection watermark even when the shell looks idle", () => {
  assert.deepEqual(evaluate({ sequence: 9, options: { afterSequence: 10 } }), {
    status: "pending",
    outcome: null,
    adoptionTimedOut: false,
    drainUnsupported: false,
  });
});

it("maps every terminal thread outcome to its exit code", () => {
  const cases: ReadonlyArray<{
    readonly outcome: ThreadWaitOutcome;
    readonly thread: OrchestrationThreadShell | null;
    readonly deadlineReached?: boolean;
    readonly expectedExitCode: number;
  }> = [
    { outcome: "completed", thread: threadWith(), expectedExitCode: 0 },
    {
      outcome: "idle",
      thread: threadWith({ latestTurn: null, latestUserMessageAt: null }),
      expectedExitCode: 0,
    },
    {
      outcome: "timeout",
      thread: threadWith({ latestTurn: { ...completedTurn!, state: "running" } }),
      deadlineReached: true,
      expectedExitCode: 2,
    },
    {
      outcome: "error",
      thread: threadWith({ latestTurn: { ...completedTurn!, state: "error" } }),
      expectedExitCode: 3,
    },
    {
      outcome: "interrupted",
      thread: threadWith({ latestTurn: { ...completedTurn!, state: "interrupted" } }),
      expectedExitCode: 4,
    },
    {
      outcome: "blocked",
      thread: threadWith({ hasPendingApprovals: true }),
      expectedExitCode: 5,
    },
    { outcome: "vanished", thread: null, expectedExitCode: 6 },
  ];

  for (const testCase of cases) {
    const result = evaluate({
      thread: testCase.thread,
      ...(testCase.deadlineReached === undefined
        ? {}
        : { deadlineReached: testCase.deadlineReached }),
    });
    assert.strictEqual(result.outcome, testCase.outcome);
    assert.strictEqual(threadWaitExitCode(testCase.outcome, false), testCase.expectedExitCode);
  }
});

it("gives session errors precedence over a stale running latest turn", () => {
  const result = evaluate({
    thread: threadWith({
      session: { status: "error" } as OrchestrationThreadShell["session"],
      latestTurn: { ...completedTurn!, state: "running" },
    }),
  });

  assert.strictEqual(result.outcome, "error");
});

it("returns blocked by default or keeps waiting when requested", () => {
  const blocked = threadWith({ hasPendingUserInput: true });

  assert.strictEqual(evaluate({ thread: blocked }).outcome, "blocked");
  assert.strictEqual(
    evaluate({ thread: blocked, options: { onBlocked: "wait" } }).status,
    "pending",
  );
  assert.strictEqual(
    evaluate({
      thread: blocked,
      options: { onBlocked: "wait" },
      deadlineReached: true,
    }).outcome,
    "timeout",
  );
});

it("settles after steering folds into a turn without requestedAt advancing", () => {
  const running = threadWith({
    latestTurn: {
      ...completedTurn!,
      state: "running",
      completedAt: null,
    },
    session: { status: "running" } as OrchestrationThreadShell["session"],
  });
  const ready = threadWith({
    latestTurn: {
      ...completedTurn!,
      requestedAt: running.latestTurn!.requestedAt,
      completedAt: "2026-08-08T12:00:10.000Z",
    },
  });

  assert.strictEqual(evaluate({ thread: running }).status, "pending");
  assert.strictEqual(evaluate({ thread: ready }).outcome, "completed");
});

it("drains working agents only when requested", () => {
  const working = threadWith({ backgroundLiveness: "working" });

  assert.strictEqual(evaluate({ thread: working }).outcome, "completed");
  assert.strictEqual(evaluate({ thread: working, options: { drain: "agents" } }).status, "pending");
});

it("treats monitoring as drained for agents but not for all", () => {
  const monitoring = threadWith({ backgroundLiveness: "monitoring" });

  assert.strictEqual(
    evaluate({ thread: monitoring, options: { drain: "agents" } }).outcome,
    "completed",
  );
  assert.strictEqual(evaluate({ thread: monitoring, options: { drain: "all" } }).status, "pending");
});

it("reports drain as unsupported when an old server omits liveness", () => {
  const thread = threadWith();
  delete (thread as { backgroundLiveness?: unknown }).backgroundLiveness;

  const result = evaluate({ thread, options: { drain: "agents" } });

  assert.strictEqual(result.outcome, "completed");
  assert.isTrue(result.drainUnsupported);
});

it("collapses terminal exit codes under --exit-zero", () => {
  for (const outcome of ["timeout", "error", "interrupted", "blocked", "vanished"] as const) {
    assert.strictEqual(threadWaitExitCode(outcome, true), 0);
  }
});

it("uses the requested turn's latest observed identity and state", () => {
  assert.strictEqual(evaluate({ options: { turnId: "turn-2" } }).outcome, "idle");
  assert.strictEqual(
    evaluate({
      thread: threadWith({ latestTurn: { ...completedTurn!, state: "running" } }),
      options: { turnId: TURN_ID },
    }).status,
    "pending",
  );
  assert.strictEqual(evaluate({ options: { turnId: TURN_ID } }).outcome, "completed");
});
