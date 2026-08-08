import type { OrchestrationShellSnapshot, OrchestrationThreadShell } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  CliOrchestrationReadTimeoutError,
  CliOrchestrationRequestError,
  CliOrchestrationWaitOutcomeUnknownError,
  type CliLiveOrchestrationServer,
  type CliLiveServerReadTimeouts,
  fetchLiveOrchestrationShell,
  isConnectionRefused,
  isProcessAlive,
} from "./orchestration.ts";
import { threadIsQuiescent } from "./threadState.ts";

export type ThreadWaitOutcome =
  | "completed"
  | "idle"
  | "timeout"
  | "error"
  | "interrupted"
  | "blocked"
  | "vanished";

export type ThreadWaitDrainMode = "agents" | "all" | null;
export type ThreadWaitBlockedMode = "wait" | "return";

export interface ThreadWaitOptions {
  readonly afterSequence: number | null;
  readonly turnId: string | null;
  readonly timeoutMs: number;
  readonly drain: ThreadWaitDrainMode;
  readonly onBlocked: ThreadWaitBlockedMode;
}

export interface ThreadWaitEvaluation {
  readonly status: "pending" | "terminal";
  readonly outcome: ThreadWaitOutcome | null;
  readonly adoptionTimedOut: boolean;
  readonly drainUnsupported: boolean;
}

export interface EvaluateThreadWaitInput {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly threadId: string;
  readonly options: ThreadWaitOptions;
  readonly now: string;
  readonly deadlineReached: boolean;
  readonly observedThread: boolean;
}

const pendingOrTimeout = (
  deadlineReached: boolean,
  options?: {
    readonly adoptionTimedOut?: boolean;
    readonly drainUnsupported?: boolean;
  },
): ThreadWaitEvaluation => ({
  status: deadlineReached ? "terminal" : "pending",
  outcome: deadlineReached ? "timeout" : null,
  adoptionTimedOut: options?.adoptionTimedOut ?? false,
  drainUnsupported: options?.drainUnsupported ?? false,
});

const terminal = (
  outcome: Exclude<ThreadWaitOutcome, "timeout">,
  options?: {
    readonly adoptionTimedOut?: boolean;
    readonly drainUnsupported?: boolean;
  },
): ThreadWaitEvaluation => ({
  status: "terminal",
  outcome,
  adoptionTimedOut: options?.adoptionTimedOut ?? false,
  drainUnsupported: options?.drainUnsupported ?? false,
});

const turnOutcome = (
  state: NonNullable<OrchestrationThreadShell["latestTurn"]>["state"],
): Exclude<ThreadWaitOutcome, "timeout" | "blocked" | "vanished" | "idle"> | null =>
  state === "running" ? null : state;

const drainPending = (thread: OrchestrationThreadShell, drain: ThreadWaitDrainMode): boolean => {
  if (drain === null || thread.backgroundLiveness === undefined) return false;
  if (drain === "all") return thread.backgroundLiveness !== null;
  return thread.backgroundLiveness === "working";
};

export const evaluateThreadWait = (input: EvaluateThreadWaitInput): ThreadWaitEvaluation => {
  if (
    input.options.afterSequence !== null &&
    input.snapshot.snapshotSequence < input.options.afterSequence
  ) {
    return pendingOrTimeout(input.deadlineReached);
  }

  const thread = input.snapshot.threads.find(
    (candidate) => candidate.id === input.threadId && candidate.archivedAt === null,
  );
  if (thread === undefined) {
    return input.observedThread ? terminal("vanished") : pendingOrTimeout(input.deadlineReached);
  }

  if (thread.session?.status === "error") return terminal("error");
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
    return input.options.onBlocked === "return"
      ? terminal("blocked")
      : pendingOrTimeout(input.deadlineReached);
  }

  let settledOutcome: Exclude<ThreadWaitOutcome, "timeout" | "blocked" | "vanished"> | null = null;
  let adoptionTimedOut = false;

  if (input.options.turnId !== null) {
    if (thread.latestTurn?.turnId !== input.options.turnId) {
      settledOutcome = "idle";
    } else if (thread.latestTurn.state !== "running") {
      settledOutcome = turnOutcome(thread.latestTurn.state);
    }
  } else {
    const quiescence = threadIsQuiescent(thread, { now: input.now });
    adoptionTimedOut = quiescence.adoptionTimedOut;
    if (quiescence.quiescent) {
      settledOutcome = adoptionTimedOut
        ? "idle"
        : thread.latestTurn === null
          ? "idle"
          : turnOutcome(thread.latestTurn.state);
    }
  }

  if (settledOutcome === null) {
    return pendingOrTimeout(input.deadlineReached, { adoptionTimedOut });
  }

  const drainUnsupported = input.options.drain !== null && thread.backgroundLiveness === undefined;
  if (drainPending(thread, input.options.drain)) {
    return pendingOrTimeout(input.deadlineReached, { adoptionTimedOut, drainUnsupported });
  }

  return terminal(settledOutcome, { adoptionTimedOut, drainUnsupported });
};

export const threadWaitExitCode = (outcome: ThreadWaitOutcome, exitZero: boolean): number => {
  if (exitZero || outcome === "completed" || outcome === "idle") return 0;
  switch (outcome) {
    case "timeout":
      return 2;
    case "error":
      return 3;
    case "interrupted":
      return 4;
    case "blocked":
      return 5;
    case "vanished":
      return 6;
  }
};

export interface WaitForThreadInput {
  readonly live: CliLiveOrchestrationServer;
  readonly token: string;
  readonly timeouts: CliLiveServerReadTimeouts;
  readonly thread: OrchestrationThreadShell;
  readonly options: ThreadWaitOptions;
}

export interface WaitForThreadResult {
  readonly evaluation: ThreadWaitEvaluation & {
    readonly status: "terminal";
    readonly outcome: ThreadWaitOutcome;
  };
  readonly thread: OrchestrationThreadShell;
  readonly snapshot: OrchestrationShellSnapshot;
  readonly waited: boolean;
  readonly waitedMs: number;
}

const THREAD_WAIT_POLL_SCHEDULE = Schedule.exponential(Duration.millis(250), 1.5).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(2))),
  ),
);
const THREAD_WAIT_FAILURE_GRACE_MS = 30_000;

const isReadTimeout = Schema.is(CliOrchestrationReadTimeoutError);
const isRequestError = Schema.is(CliOrchestrationRequestError);
const isTransientWaitReadError = (error: unknown): boolean =>
  isReadTimeout(error) || isRequestError(error);

export const waitForThread = Effect.fn("waitForThread")(function* (input: WaitForThreadInput) {
  const startedAt = yield* Clock.currentTimeMillis;
  const nextPollDelay = yield* Schedule.toStep(THREAD_WAIT_POLL_SCHEDULE);
  let snapshot = input.live.shell;
  let lastThread = input.thread;
  let waited = false;
  let consecutiveFailures = 0;
  let failureStartedAt: number | null = null;

  while (true) {
    const nowMs = yield* Clock.currentTimeMillis;
    const waitedMs = Math.max(0, nowMs - startedAt);
    const evaluated = evaluateThreadWait({
      snapshot,
      threadId: input.thread.id,
      options: input.options,
      now: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      deadlineReached: waitedMs >= input.options.timeoutMs,
      observedThread: true,
    });
    if (evaluated.status === "terminal" && evaluated.outcome !== null) {
      return {
        evaluation: { ...evaluated, status: "terminal", outcome: evaluated.outcome },
        thread: lastThread,
        snapshot,
        waited,
        waitedMs,
      } satisfies WaitForThreadResult;
    }

    const [, scheduledDelay] = yield* nextPollDelay(nowMs, undefined);
    const remainingMs = Math.max(0, input.options.timeoutMs - waitedMs);
    yield* Effect.sleep(Duration.min(scheduledDelay, Duration.millis(remainingMs)));
    waited = true;

    const attempted = yield* Effect.result(
      fetchLiveOrchestrationShell(input.live.origin, input.token, input.timeouts, {
        phase: "wait",
        timeout: input.timeouts.read,
      }),
    );
    if (attempted._tag === "Success") {
      snapshot = attempted.success;
      lastThread =
        snapshot.threads.find(
          (thread) => thread.id === input.thread.id && thread.archivedAt === null,
        ) ?? lastThread;
      consecutiveFailures = 0;
      failureStartedAt = null;
      continue;
    }

    if (!isTransientWaitReadError(attempted.failure)) {
      return yield* attempted.failure;
    }

    const failedAt = yield* Clock.currentTimeMillis;
    failureStartedAt ??= failedAt;
    consecutiveFailures += 1;
    if (isConnectionRefused(attempted.failure) || consecutiveFailures >= 3) {
      if (!(yield* isProcessAlive(input.live.pid))) {
        return yield* new CliOrchestrationWaitOutcomeUnknownError({
          operation: "waitLiveServer",
          pid: input.live.pid,
          cause: attempted.failure,
        });
      }
    }
    if (failedAt - failureStartedAt >= THREAD_WAIT_FAILURE_GRACE_MS) {
      return yield* attempted.failure;
    }
  }
});
