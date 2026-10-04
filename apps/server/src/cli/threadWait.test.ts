import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemsFromInitialSnapshot,
} from "../orchestration-v2/ShellStream.ts";
import { makeTestThreadShell, testShellTime } from "./liveServerTestKit.ts";
import { CliOrchestrationOutcomeUnknownError } from "./orchestration.ts";
import { CliOrchestrationCommandRejectedError } from "./orchestrationRpc.ts";
import {
  evaluateThreadWait,
  observeShellItem,
  type ThreadInputResponseMode,
  type ThreadWaitDependencies,
  type ThreadWaitObservation,
  type ThreadWaitOptions,
  threadWaitExitCode,
  waitForThread,
} from "./threadWait.ts";

const threadId = ThreadId.make("thread-wait");
const runId = RunId.make("run-wait");
const newerRunId = RunId.make("run-newer");
const questionId = RuntimeRequestId.make("question-1");
const subagent = { taskId: "sub", kind: "subagent" } as const;
const monitor = { taskId: "watch", kind: "monitor" } as const;

const running = makeTestThreadShell(threadId, {
  status: "running",
  activeRunId: runId,
  latestRunId: runId,
  activityRunStatus: "running",
});
const settled = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  makeTestThreadShell(threadId, { status: "completed", latestRunId: runId, ...overrides });
const withQuestion = (thread: OrchestrationV2ThreadShell) => ({
  ...thread,
  pendingRuntimeRequest: { id: questionId, kind: "user_input" as const, createdAt: testShellTime },
});

const options = (overrides: Partial<ThreadWaitOptions> = {}): ThreadWaitOptions => ({
  afterSequence: null,
  runId: null,
  timeoutMs: 60_000,
  drain: null,
  onBlocked: "return",
  ...overrides,
});

const evaluate = (
  thread: OrchestrationV2ThreadShell | null,
  overrides: Partial<ThreadWaitOptions> = {},
  input: {
    readonly sequence?: number;
    readonly mode?: ThreadInputResponseMode;
  } = {},
) =>
  evaluateThreadWait({
    observation: { thread, sequence: input.sequence ?? 10 },
    options: options(overrides),
    responseMode: () => input.mode,
  });

const snapshot = (
  thread: OrchestrationV2ThreadShell,
  sequence: number,
): OrchestrationV2ShellStreamItem => ({
  kind: "snapshot",
  snapshot: {
    schemaVersion: 1,
    snapshotSequence: sequence,
    projects: [],
    threads: [thread],
    archivedThreads: [],
  },
});
const updated = (
  thread: OrchestrationV2ThreadShell,
  sequence: number,
): OrchestrationV2ShellStreamItem => ({
  kind: "thread.updated",
  sequence,
  location: "active",
  thread,
});

type StreamError = CliOrchestrationCommandRejectedError | CliOrchestrationOutcomeUnknownError;
const deps = (
  shellStream: Stream.Stream<OrchestrationV2ShellStreamItem, StreamError>,
  overrides: Partial<ThreadWaitDependencies<StreamError, never>> = {},
): ThreadWaitDependencies<StreamError, never> => ({
  shellStream: () => shellStream,
  userInputResponseMode: () => Effect.succeed("blocking"),
  serverAlive: Effect.succeed(true),
  ...overrides,
});

const waitInput = (
  thread: OrchestrationV2ThreadShell,
  overrides: Partial<ThreadWaitOptions> = {},
) => ({
  thread,
  sequence: 10,
  serverPid: 4242,
  options: options(overrides),
});

const rejected = new CliOrchestrationCommandRejectedError({
  operation: "dispatchLiveServer",
  commandType: "orchestration.subscribeShell",
  detail: "Not authorized.",
});

const dropped = new CliOrchestrationOutcomeUnknownError({
  operation: "dispatchLiveServer",
  cause: new Error("socket closed"),
});

describe("thread wait outcomes", () => {
  it("reports the settled run's outcome and keeps waiting while it runs", () => {
    assert.deepEqual(
      [
        evaluate(running),
        evaluate(settled()),
        evaluate(makeTestThreadShell(threadId)),
        evaluate(settled({ status: "failed" })),
        evaluate(settled({ status: "interrupted" })),
        // A finished run still finalizing is not settled yet.
        evaluate(settled({ activityRunStatus: "waiting" })),
        evaluate(settled({ status: "queued" })),
      ],
      [null, "completed", "idle", "error", "interrupted", null, null],
    );
  });

  it("returns blocked for requests that hold the turn, not for message-mode questions", () => {
    const approval = {
      ...running,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("approval-1"),
        kind: "command" as const,
        createdAt: testShellTime,
      },
    };
    assert.strictEqual(evaluate(approval), "blocked");
    assert.strictEqual(evaluate(approval, { onBlocked: "wait" }), null);
    assert.strictEqual(evaluate(withQuestion(running)), "blocked");
    assert.strictEqual(evaluate(withQuestion(running), {}, { mode: "message" }), null);
    assert.strictEqual(evaluate(withQuestion(settled()), {}, { mode: "message" }), "completed");
    assert.strictEqual(
      evaluate({
        ...settled(),
        pendingRuntimeRequest: { id: questionId, kind: "auth_refresh", createdAt: testShellTime },
      }),
      "completed",
    );
  });

  it("waits for the requested shell sequence before judging the thread", () => {
    assert.strictEqual(evaluate(settled(), { afterSequence: 11 }, { sequence: 10 }), null);
    assert.strictEqual(evaluate(settled(), { afterSequence: 11 }, { sequence: 11 }), "completed");
  });

  it("reports a newer run as superseded and an archived or removed thread as vanished", () => {
    const newer = { ...running, activeRunId: newerRunId, latestRunId: newerRunId };
    assert.strictEqual(evaluate(newer, { runId }), "superseded");
    assert.strictEqual(evaluate(running, { runId }), null);
    assert.strictEqual(evaluate(settled(), { runId }), "completed");
    assert.strictEqual(evaluate(null), "vanished");

    const observed = { thread: running, sequence: 10 };
    const archived = observeShellItem(
      observed,
      {
        kind: "thread.updated",
        sequence: 11,
        location: "archive",
        thread: { ...running, archivedAt: testShellTime },
      },
      threadId,
    );
    assert.deepEqual(archived, { thread: null, sequence: 11 });
    const removed = observeShellItem(
      observed,
      { kind: "thread.removed", sequence: 12, location: "active", threadId },
      threadId,
    );
    assert.deepEqual(removed, { thread: null, sequence: 12 });
    const otherThread = observeShellItem(
      observed,
      updated(makeTestThreadShell(ThreadId.make("other")), 13),
      threadId,
    );
    assert.deepEqual(otherThread, { thread: running, sequence: 13 });
  });

  it("keeps the thread and sequence on metadata-only enrichment frames", () => {
    const shell = {
      schemaVersion: 1,
      snapshotSequence: 20,
      projects: [],
      threads: [running],
      archivedThreads: [],
    };
    const [authoritative, enrichment] = shellStreamItemsFromInitialSnapshot({
      snapshot: shell,
      resolvedRepositoryIdentityRoots: ["/repo"],
    });
    const refresh = shellStreamItemFromEnrichmentRefresh({
      snapshot: { ...shell, snapshotSequence: 25 },
      changes: [{ workspaceRoot: "/repo" }],
    });
    let observed: ThreadWaitObservation = { thread: running, sequence: 10 };
    for (const item of [authoritative!, enrichment!, refresh]) {
      observed = observeShellItem(observed, item, threadId);
    }
    assert.deepEqual(observed, { thread: running, sequence: 20 });
    assert.strictEqual(
      evaluateThreadWait({
        observation: observed,
        options: options({ afterSequence: 21 }),
        responseMode: () => undefined,
      }),
      null,
    );
    assert.strictEqual(evaluate(observed.thread), null);
  });

  it("drains agent work by default and monitors only with --drain=all", () => {
    const watching = settled({ pendingBackgroundTasks: [monitor] });
    const working = settled({ pendingBackgroundTasks: [monitor, subagent] });
    assert.deepEqual(
      [
        evaluate(watching, { drain: "agents" }),
        evaluate(watching, { drain: "all" }),
        evaluate(working, { drain: "agents" }),
        evaluate(working),
      ],
      ["completed", null, null, "completed"],
    );
  });

  it("maps outcomes to the fork's exit codes", () => {
    assert.deepEqual(
      (
        [
          "completed",
          "idle",
          "superseded",
          "timeout",
          "error",
          "interrupted",
          "blocked",
          "vanished",
        ] as const
      ).map((outcome) => threadWaitExitCode(outcome, false)),
      [0, 0, 0, 2, 3, 4, 5, 6],
    );
    assert.strictEqual(threadWaitExitCode("blocked", true), 0);
  });
});

describe("waitForThread", () => {
  it.effect("follows the shell stream through the turn and its agent work", () =>
    Effect.gen(function* () {
      const stream = Stream.fromIterable([
        snapshot(running, 12),
        updated(settled({ pendingBackgroundTasks: [subagent] }), 13),
        updated(settled(), 14),
      ]);
      const plain = yield* waitForThread(waitInput(running), deps(stream));
      assert.deepEqual(
        { outcome: plain.outcome, sequence: plain.observedSequence, waited: plain.waited },
        { outcome: "completed", sequence: 13, waited: true },
      );
      const drained = yield* waitForThread(waitInput(running, { drain: "agents" }), deps(stream));
      assert.deepEqual(
        { outcome: drained.outcome, sequence: drained.observedSequence },
        { outcome: "completed", sequence: 14 },
      );
    }),
  );

  it.effect("returns at once when the thread has already settled", () =>
    Effect.gen(function* () {
      const result = yield* waitForThread(
        waitInput(settled()),
        deps(Stream.die("the stream is not opened")),
      );
      assert.deepEqual(
        { outcome: result.outcome, waited: result.waited },
        { outcome: "completed", waited: false },
      );
    }),
  );

  it.effect("reads a pending question's mode once and does not block on a message-mode one", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const result = yield* waitForThread(
        waitInput(withQuestion(running)),
        deps(
          Stream.fromIterable([
            snapshot(withQuestion(running), 12),
            updated(withQuestion(running), 13),
            updated(withQuestion(settled()), 14),
          ]),
          {
            userInputResponseMode: () =>
              Ref.update(reads, (count) => count + 1).pipe(Effect.as("message")),
          },
        ),
      );
      assert.deepEqual(
        {
          outcome: result.outcome,
          blocking: result.hasPendingBlockingUserInput,
          reads: yield* Ref.get(reads),
        },
        { outcome: "completed", blocking: false, reads: 1 },
      );
    }),
  );

  it.effect("reconnects after a dropped stream, resuming after the last observed sequence", () =>
    Effect.gen(function* () {
      const resumedAfter = yield* Ref.make<ReadonlyArray<number>>([]);
      const shellStream = (afterSequence: number) =>
        Stream.unwrap(
          Ref.updateAndGet(resumedAfter, (sequences) => [...sequences, afterSequence]).pipe(
            Effect.map((sequences) =>
              sequences.length === 1
                ? Stream.concat(Stream.make(updated(running, 12)), Stream.fail(dropped))
                : Stream.make(updated(settled(), 15)),
            ),
          ),
        );
      const fiber = yield* waitForThread(
        waitInput(running),
        deps(Stream.empty, { shellStream }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);
      assert.deepEqual(
        { outcome: result.outcome, sequence: result.observedSequence },
        { outcome: "completed", sequence: 15 },
      );
      assert.deepEqual(yield* Ref.get(resumedAfter), [10, 12]);
    }),
  );

  it.effect("gives up after the grace period when a pending question cannot be classified", () =>
    Effect.gen(function* () {
      const fiber = yield* waitForThread(
        waitInput(withQuestion(running)),
        deps(Stream.make(snapshot(withQuestion(running), 12)), {
          userInputResponseMode: () => Effect.fail(dropped),
        }),
      ).pipe(Effect.flip, Effect.forkChild);
      // Step past the grace period and the 60-second timeout; only the grace ends it with an error.
      for (let second = 0; second < 61; second += 1) yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error._tag, "ThreadCliWaitConnectionError");
    }),
  );

  it.effect("reports an unknown outcome when the server process is gone", () =>
    Effect.gen(function* () {
      const error = yield* waitForThread(
        waitInput(running),
        deps(Stream.make(snapshot(running, 12)), { serverAlive: Effect.succeed(false) }),
      ).pipe(Effect.flip);
      assert.strictEqual(error._tag, "CliOrchestrationWaitOutcomeUnknownError");
    }),
  );

  it.effect("fails on a declared rejection without reconnecting", () =>
    Effect.gen(function* () {
      const error = yield* waitForThread(waitInput(running), deps(Stream.fail(rejected))).pipe(
        Effect.flip,
      );
      assert.strictEqual(error, rejected);
    }),
  );

  it.effect("times out with the last observed thread", () =>
    Effect.gen(function* () {
      const fiber = yield* waitForThread(
        waitInput(running, { timeoutMs: 5_000 }),
        deps(Stream.concat(Stream.make(snapshot(running, 12)), Stream.never)),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(fiber);
      assert.deepEqual(
        {
          outcome: result.outcome,
          sequence: result.observedSequence,
          status: result.thread.status,
        },
        { outcome: "timeout", sequence: 12, status: "running" },
      );
    }),
  );
});
