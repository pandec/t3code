import type { OrchestrationShellSnapshot, OrchestrationThreadShell } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  cliLiveServerReadTimeoutsFromMillis,
  CliOrchestrationRequestError,
  CliOrchestrationUndeclaredStatusError,
  CliOrchestrationWaitOutcomeUnknownError,
} from "./orchestration.ts";
import {
  classifyWaitReadFailure,
  evaluateThreadWait,
  THREAD_WAIT_DRAIN_STALE_MS,
  type ThreadWaitDependencies,
  type ThreadWaitOptions,
  type ThreadWaitOutcome,
  threadWaitExitCode,
  waitForThread,
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
    updatedAt: NOW,
    latestTurn: completedTurn,
    latestUserMessageAt: completedTurn?.requestedAt ?? null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    backgroundLiveness: null,
    ...input,
  }) as OrchestrationThreadShell;

const snapshotWith = (
  thread: OrchestrationThreadShell | null,
  sequence = 10,
): OrchestrationShellSnapshot =>
  ({
    snapshotSequence: sequence,
    projects: [],
    threads: thread === null ? [] : [thread],
    updatedAt: NOW,
  }) as OrchestrationShellSnapshot;

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
  readonly queuedStartObserved?: boolean;
  readonly updatedAtFrozenMs?: number;
}) =>
  evaluateThreadWait({
    snapshot: snapshotWith(
      input?.thread === undefined ? threadWith() : input.thread,
      input?.sequence,
    ),
    threadId: "thread-1",
    options: { ...defaultOptions, ...input?.options },
    now: NOW,
    deadlineReached: input?.deadlineReached ?? false,
    queuedStartObserved: input?.queuedStartObserved ?? false,
    updatedAtFrozenMs: input?.updatedAtFrozenMs ?? 0,
  });

it("waits for the requested projection watermark even when the shell looks idle", () => {
  assert.deepEqual(evaluate({ sequence: 9, options: { afterSequence: 10 } }), {
    status: "pending",
    outcome: null,
    adoptionTimedOut: false,
    drainUnsupported: false,
    drainStale: false,
  });
});

it("maps every terminal thread outcome to its exit code", () => {
  const cases: ReadonlyArray<{
    readonly outcome: ThreadWaitOutcome;
    readonly thread: OrchestrationThreadShell | null;
    readonly deadlineReached?: boolean;
    readonly queuedStartObserved?: boolean;
    readonly expectedExitCode: number;
  }> = [
    { outcome: "completed", thread: threadWith(), expectedExitCode: 0 },
    {
      outcome: "idle",
      thread: threadWith({ latestTurn: null, latestUserMessageAt: null }),
      expectedExitCode: 0,
    },
    {
      outcome: "superseded",
      thread: threadWith(),
      expectedExitCode: 0,
    },
    {
      outcome: "unadopted",
      thread: threadWith({
        latestTurn: null,
        latestUserMessageAt: "2026-08-08T11:57:00.000Z",
      }),
      queuedStartObserved: true,
      expectedExitCode: 2,
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
    const options = testCase.outcome === "superseded" ? { turnId: "turn-unknown" } : undefined;
    const result = evaluate({
      thread: testCase.thread,
      ...(options === undefined ? {} : { options }),
      ...(testCase.deadlineReached === undefined
        ? {}
        : { deadlineReached: testCase.deadlineReached }),
      ...(testCase.queuedStartObserved === undefined
        ? {}
        : { queuedStartObserved: testCase.queuedStartObserved }),
    });
    assert.strictEqual(result.outcome, testCase.outcome);
    assert.strictEqual(threadWaitExitCode(testCase.outcome, false), testCase.expectedExitCode);
  }
});

it("gives a fresh session error precedence over a stale running latest turn", () => {
  const result = evaluate({
    thread: threadWith({
      session: {
        status: "error",
        updatedAt: "2026-08-08T12:00:01.000Z",
      } as OrchestrationThreadShell["session"],
      latestTurn: { ...completedTurn!, state: "running" },
    }),
  });

  assert.strictEqual(result.outcome, "error");
});

it("keeps waiting when a newer message makes the prior session error stale", () => {
  const result = evaluate({
    thread: threadWith({
      latestUserMessageAt: "2026-08-08T11:59:50.000Z",
      session: {
        status: "error",
        updatedAt: "2026-08-08T11:59:40.000Z",
      } as OrchestrationThreadShell["session"],
      latestTurn: completedTurn,
    }),
  });

  assert.strictEqual(result.status, "pending");
});

it("does not label a long-idle legacy shell as adoption-timed-out", () => {
  const result = evaluate({
    thread: threadWith({
      latestTurn: null,
      latestUserMessageAt: "2026-08-08T10:00:00.000Z",
    }),
  });

  assert.strictEqual(result.outcome, "idle");
  assert.isFalse(result.adoptionTimedOut);
});

it("returns unadopted only after observing a queued start age out", () => {
  const fresh = threadWith({
    latestTurn: null,
    latestUserMessageAt: "2026-08-08T11:59:30.000Z",
  });
  const expired = threadWith({
    latestTurn: null,
    latestUserMessageAt: "2026-08-08T11:57:00.000Z",
  });

  assert.strictEqual(evaluate({ thread: fresh }).status, "pending");
  const result = evaluate({ thread: expired, queuedStartObserved: true });
  assert.strictEqual(result.outcome, "unadopted");
  assert.isTrue(result.adoptionTimedOut);
  assert.strictEqual(threadWaitExitCode("unadopted", false), 2);
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
    latestUserMessageAt: "2026-08-08T11:59:20.000Z",
    latestTurn: {
      ...completedTurn!,
      state: "running",
      completedAt: null,
    },
    session: { status: "running" } as OrchestrationThreadShell["session"],
  });
  const ready = threadWith({
    latestUserMessageAt: running.latestUserMessageAt,
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

it("returns the settled outcome with drainStale after observing the freeze threshold", () => {
  const working = threadWith({ backgroundLiveness: "working" });

  // Exactly at the threshold is stale (pins >= semantics); 1ms short is not.
  const stale = evaluate({
    thread: working,
    options: { drain: "agents" },
    updatedAtFrozenMs: THREAD_WAIT_DRAIN_STALE_MS,
  });
  assert.strictEqual(stale.outcome, "completed");
  assert.isTrue(stale.drainStale);

  const almost = evaluate({
    thread: working,
    options: { drain: "agents" },
    updatedAtFrozenMs: THREAD_WAIT_DRAIN_STALE_MS - 1,
  });
  assert.strictEqual(almost.status, "pending");
  assert.isFalse(almost.drainStale);
});

it("never declares staleness under --drain=all: working may hide a quiet monitor", () => {
  const working = threadWith({ backgroundLiveness: "working" });
  const monitoring = threadWith({ backgroundLiveness: "monitoring" });

  const all = evaluate({
    thread: working,
    options: { drain: "all" },
    updatedAtFrozenMs: THREAD_WAIT_DRAIN_STALE_MS * 10,
  });
  assert.strictEqual(all.status, "pending");
  assert.isFalse(all.drainStale);

  const quietMonitor = evaluate({
    thread: monitoring,
    options: { drain: "all" },
    updatedAtFrozenMs: THREAD_WAIT_DRAIN_STALE_MS * 10,
  });
  assert.strictEqual(quietMonitor.status, "pending");
  assert.isFalse(quietMonitor.drainStale);
});

it("reports drain as unsupported when an old server omits liveness", () => {
  const thread = threadWith();
  delete (thread as { backgroundLiveness?: unknown }).backgroundLiveness;

  const result = evaluate({ thread, options: { drain: "agents" } });

  assert.strictEqual(result.outcome, "completed");
  assert.isTrue(result.drainUnsupported);
});

it("retains unsupported-drain diagnostics on vanished and timeout results", () => {
  const thread = threadWith({
    latestTurn: { ...completedTurn!, state: "running" },
    backgroundLiveness: undefined,
  });
  const timeout = evaluate({
    thread,
    options: { drain: "all" },
    deadlineReached: true,
  });

  assert.strictEqual(timeout.outcome, "timeout");
  assert.isTrue(timeout.drainUnsupported);
  assert.strictEqual(evaluate({ thread: null, options: { drain: "all" } }).outcome, "vanished");
});

it("collapses every non-zero terminal exit code under --exit-zero", () => {
  for (const outcome of [
    "unadopted",
    "timeout",
    "error",
    "interrupted",
    "blocked",
    "vanished",
  ] as const) {
    assert.strictEqual(threadWaitExitCode(outcome, true), 0);
  }
});

it("keeps a mismatched requested turn pending while adoption is visible", () => {
  const queued = threadWith({
    latestTurn: completedTurn,
    latestUserMessageAt: "2026-08-08T11:59:50.000Z",
  });
  const starting = threadWith({
    session: { status: "starting" } as OrchestrationThreadShell["session"],
  });

  assert.strictEqual(evaluate({ thread: queued, options: { turnId: "turn-2" } }).status, "pending");
  assert.strictEqual(
    evaluate({ thread: starting, options: { turnId: "turn-2" } }).status,
    "pending",
  );
});

it("distinguishes requested turns that completed, run, or were superseded", () => {
  assert.strictEqual(evaluate({ options: { turnId: "turn-unknown" } }).outcome, "superseded");
  assert.strictEqual(
    evaluate({
      thread: threadWith({ latestTurn: { ...completedTurn!, state: "running" } }),
      options: { turnId: TURN_ID },
    }).status,
    "pending",
  );
  assert.strictEqual(evaluate({ options: { turnId: TURN_ID } }).outcome, "completed");
});

it("classifies transient 5xx reads and deadline precedence", () => {
  const serverError = new CliOrchestrationUndeclaredStatusError({
    operation: "callLiveServer",
    status: 503,
    cause: null,
  });
  const clientError = new CliOrchestrationUndeclaredStatusError({
    operation: "callLiveServer",
    status: 404,
    cause: null,
  });

  assert.strictEqual(
    classifyWaitReadFailure({
      error: serverError,
      nowMs: 1_000,
      failureStartedAtMs: 0,
      consecutiveFailures: 1,
      deadlineExceeded: false,
    }),
    "retry",
  );
  assert.strictEqual(
    classifyWaitReadFailure({
      error: serverError,
      nowMs: 30_000,
      failureStartedAtMs: 0,
      consecutiveFailures: 20,
      deadlineExceeded: true,
    }),
    "timeout",
  );
  assert.strictEqual(
    classifyWaitReadFailure({
      error: clientError,
      nowMs: 0,
      failureStartedAtMs: null,
      consecutiveFailures: 1,
      deadlineExceeded: false,
    }),
    "give-up",
  );
});

const runningThread = () =>
  threadWith({
    latestTurn: { ...completedTurn!, state: "running", completedAt: null },
    session: { status: "running" } as OrchestrationThreadShell["session"],
  });

const requestFailure = () =>
  new CliOrchestrationRequestError({
    operation: "callLiveServer",
    cause: new Error("temporary read failure"),
  });

const waitInput = (thread: OrchestrationThreadShell, options: Partial<ThreadWaitOptions> = {}) => ({
  live: {
    origin: "http://127.0.0.1:1",
    pid: 123,
    startedAt: NOW,
    shell: snapshotWith(thread),
  },
  token: "token",
  timeouts: cliLiveServerReadTimeoutsFromMillis(100),
  thread,
  options: { ...defaultOptions, ...options },
});

const dependencies = (
  fetchShell: ThreadWaitDependencies["fetchShell"],
  processAlive: ThreadWaitDependencies["processAlive"] = () => Effect.succeed(true),
): ThreadWaitDependencies => ({ fetchShell, processAlive });

it.effect("re-polls past a watermark and terminates on a later snapshot", () =>
  Effect.gen(function* () {
    const initial = threadWith({ latestTurn: null, latestUserMessageAt: null });
    const fiber = yield* waitForThread(
      waitInput(initial, { afterSequence: 11 }),
      dependencies(() => Effect.succeed(snapshotWith(threadWith(), 11))),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* TestClock.adjust(Duration.millis(250));
    const result = yield* Fiber.join(fiber);

    assert.strictEqual(result.evaluation.outcome, "completed");
    assert.strictEqual(result.snapshot.snapshotSequence, 11);
    assert.isTrue(result.waited);
  }),
);

it.effect("clamps the first poll delay to the remaining timeout", () =>
  Effect.gen(function* () {
    let reads = 0;
    const thread = runningThread();
    const fiber = yield* waitForThread(
      waitInput(thread, { timeoutMs: 100 }),
      dependencies(() => {
        reads += 1;
        return Effect.succeed(snapshotWith(thread));
      }),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* TestClock.adjust(Duration.millis(100));
    const result = yield* Fiber.join(fiber);

    assert.strictEqual(result.evaluation.outcome, "timeout");
    assert.strictEqual(result.waitedMs, 100);
    assert.strictEqual(reads, 1);
  }),
);

it.effect("preserves the last snapshot and drain state through a transient failure", () =>
  Effect.gen(function* () {
    let reads = 0;
    const thread = threadWith({ backgroundLiveness: "working" });
    const drained = threadWith({ backgroundLiveness: null });
    const fiber = yield* waitForThread(
      waitInput(thread, { drain: "agents" }),
      dependencies(() => {
        reads += 1;
        return reads === 1
          ? Effect.fail(requestFailure())
          : Effect.succeed(snapshotWith(drained, 12));
      }),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* TestClock.adjust(Duration.millis(250));
    yield* TestClock.adjust(Duration.millis(375));
    const result = yield* Fiber.join(fiber);

    assert.strictEqual(result.evaluation.outcome, "completed");
    assert.strictEqual(result.snapshot.snapshotSequence, 12);
    assert.isNull(result.thread.backgroundLiveness);
  }),
);

it.effect("resets the continuous failure window after a successful read", () =>
  Effect.gen(function* () {
    let reads = 0;
    const thread = runningThread();
    const fiber = yield* waitForThread(
      waitInput(thread, { timeoutMs: 120_000 }),
      dependencies(() => {
        reads += 1;
        if (reads === 13) return Effect.succeed(snapshotWith(thread, 11));
        if (reads === 24) return Effect.succeed(snapshotWith(threadWith(), 12));
        return Effect.fail(requestFailure());
      }),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    for (let index = 0; index < 24; index += 1) {
      yield* TestClock.adjust(Duration.seconds(2));
    }
    const result = yield* Fiber.join(fiber);

    assert.strictEqual(result.evaluation.outcome, "completed");
    assert.strictEqual(reads, 24);
  }),
);

it.effect("probes the process after three failures and reports an unknown outcome when dead", () =>
  Effect.gen(function* () {
    let probes = 0;
    const thread = runningThread();
    const fiber = yield* waitForThread(
      waitInput(thread),
      dependencies(
        () => Effect.fail(requestFailure()),
        () => {
          probes += 1;
          return Effect.succeed(false);
        },
      ),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    for (const delay of [250, 375, 563]) {
      yield* TestClock.adjust(Duration.millis(delay));
    }
    const error = yield* Fiber.join(fiber).pipe(Effect.flip);

    assert.instanceOf(error, CliOrchestrationWaitOutcomeUnknownError);
    assert.strictEqual(probes, 1);
  }),
);

it.effect("declares drainStale only after observing the freeze across polls", () =>
  Effect.gen(function* () {
    // Same snapshot (same updatedAt) on every read: the wait itself must
    // observe the 3-minute freeze before self-healing — never at t=0.
    const thread = threadWith({ backgroundLiveness: "working" });
    const fiber = yield* waitForThread(
      waitInput(thread, { drain: "agents" }),
      dependencies(() => Effect.succeed(snapshotWith(thread))),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    for (let index = 0; index < 100; index += 1) {
      yield* TestClock.adjust(Duration.seconds(2));
    }
    const result = yield* Fiber.join(fiber);

    assert.strictEqual(result.evaluation.outcome, "completed");
    assert.isTrue(result.evaluation.drainStale);
    assert.isAtLeast(result.waitedMs, THREAD_WAIT_DRAIN_STALE_MS);
  }),
);

it.effect("advancing updatedAt resets the freeze anchor and defers to timeout", () =>
  Effect.gen(function* () {
    let reads = 0;
    const withUpdatedAt = (iso: string) =>
      threadWith({ backgroundLiveness: "working", updatedAt: iso });
    const fiber = yield* waitForThread(
      waitInput(withUpdatedAt(NOW), { drain: "agents", timeoutMs: 240_000 }),
      dependencies(() => {
        reads += 1;
        // Every read reports fresh thread activity, so the observed freeze
        // never reaches the threshold and the deadline wins.
        return Effect.succeed(
          snapshotWith(withUpdatedAt(new Date(Date.parse(NOW) + reads * 1_000).toISOString())),
        );
      }),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    for (let index = 0; index < 125; index += 1) {
      yield* TestClock.adjust(Duration.seconds(2));
    }
    const result = yield* Fiber.join(fiber);

    assert.strictEqual(result.evaluation.outcome, "timeout");
    assert.isFalse(result.evaluation.drainStale);
  }),
);

it.effect("retains drain diagnostics in a loop timeout result", () =>
  Effect.gen(function* () {
    const thread = threadWith({ backgroundLiveness: "working" });
    const fiber = yield* waitForThread(
      waitInput(thread, { drain: "agents", timeoutMs: 100 }),
      dependencies(() => Effect.succeed(snapshotWith(thread))),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* TestClock.adjust(Duration.millis(100));
    const result = yield* Fiber.join(fiber);

    assert.strictEqual(result.evaluation.outcome, "timeout");
    assert.strictEqual(result.thread.backgroundLiveness, "working");
  }),
);

it.effect("returns timeout instead of a read envelope when the wait deadline expires", () =>
  Effect.gen(function* () {
    const thread = runningThread();
    const fiber = yield* waitForThread(
      waitInput(thread, { timeoutMs: 10_000 }),
      dependencies(() => Effect.fail(requestFailure())),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    for (let index = 0; index < 16; index += 1) {
      yield* TestClock.adjust(Duration.seconds(2));
    }
    const result = yield* Fiber.join(fiber);

    assert.strictEqual(result.evaluation.outcome, "timeout");
    assert.strictEqual(result.waitedMs, 10_000);
  }),
);
