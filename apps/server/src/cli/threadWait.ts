import type { OrchestrationShellSnapshot, OrchestrationThreadShell } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import {
  type CliOrchestrationCallError,
  CliOrchestrationReadTimeoutError,
  CliOrchestrationRequestError,
  CliOrchestrationUndeclaredStatusError,
  CliOrchestrationWaitOutcomeUnknownError,
  type CliLiveOrchestrationServer,
  type CliLiveServerReadTimeouts,
  fetchLiveOrchestrationShell,
  isConnectionRefused,
  isProcessAlive,
} from "./orchestration.ts";
import { hasQueuedTurnStart, hasUnadoptedTurnStart, threadIsQuiescent } from "./threadState.ts";

export type ThreadWaitOutcome =
  | "completed"
  | "idle"
  | "superseded"
  | "unadopted"
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
  readonly drainStale: boolean;
}

export interface EvaluateThreadWaitInput {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly threadId: string;
  readonly options: ThreadWaitOptions;
  readonly now: string;
  readonly deadlineReached: boolean;
  readonly queuedStartObserved: boolean;
  /**
   * Milliseconds this wait has observed `thread.updatedAt` standing still,
   * measured by the poll loop on its own clock (0 on the first evaluation).
   * Feeds the stale-drain backstop; see {@link THREAD_WAIT_DRAIN_STALE_MS}.
   */
  readonly updatedAtFrozenMs: number;
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
  drainStale: false,
});

const terminal = (
  outcome: Exclude<ThreadWaitOutcome, "timeout">,
  options?: {
    readonly adoptionTimedOut?: boolean;
    readonly drainUnsupported?: boolean;
    readonly drainStale?: boolean;
  },
): ThreadWaitEvaluation => ({
  status: "terminal",
  outcome,
  adoptionTimedOut: options?.adoptionTimedOut ?? false,
  drainUnsupported: options?.drainUnsupported ?? false,
  drainStale: options?.drainStale ?? false,
});

const turnOutcome = (
  state: NonNullable<OrchestrationThreadShell["latestTurn"]>["state"],
): Exclude<
  ThreadWaitOutcome,
  "timeout" | "blocked" | "vanished" | "idle" | "superseded" | "unadopted"
> | null => (state === "running" ? null : state);

const drainPending = (thread: OrchestrationThreadShell, drain: ThreadWaitDrainMode): boolean => {
  if (drain === null || thread.backgroundLiveness === undefined) return false;
  if (drain === "all") return thread.backgroundLiveness !== null;
  return thread.backgroundLiveness === "working";
};

/**
 * Background liveness is best-effort in-memory server state; a lost terminal
 * event can pin `"working"` forever and burn the wait to `timeout`. Real
 * background agent work usually keeps producing activities (tool events,
 * context updates), which advance `thread.updatedAt` — so when the turn has
 * settled and only the drain keeps the wait pending, an `updatedAt` this
 * wait has observed standing still for the threshold marks the liveness as
 * stale and the wait returns the settled outcome instead. The freeze is
 * measured across this wait's own polls (never against pre-wait history or
 * cross-host clocks), so a fresh liveness transition whose activity has not
 * yet projected cannot trip it. This is a heuristic, not a proof: an agent
 * silent inside one long tool call has no activity cadence guarantee, hence
 * the result carries `drainStale: true` and callers who depend on
 * background-produced artifacts should verify them. Restricted to
 * `--drain=agents`: `"monitoring"` watch loops can legitimately be quiet
 * for long stretches, and a `"working"` aggregate can hide a live quiet
 * monitor, so `--drain=all` keeps its plain timeout semantics.
 */
export const THREAD_WAIT_DRAIN_STALE_MS = 3 * 60_000;

const drainLooksStale = (
  thread: OrchestrationThreadShell,
  drain: ThreadWaitDrainMode,
  updatedAtFrozenMs: number,
): boolean =>
  drain === "agents" &&
  thread.backgroundLiveness === "working" &&
  updatedAtFrozenMs >= THREAD_WAIT_DRAIN_STALE_MS;

const sessionErrorIsFresh = (thread: OrchestrationThreadShell): boolean => {
  if (thread.session?.status !== "error") return false;
  if (thread.latestUserMessageAt === null) return true;
  const sessionUpdatedAt = Date.parse(thread.session.updatedAt);
  const latestUserMessageAt = Date.parse(thread.latestUserMessageAt);
  if (Number.isNaN(sessionUpdatedAt) || Number.isNaN(latestUserMessageAt)) return true;
  return sessionUpdatedAt > latestUserMessageAt;
};

export const evaluateThreadWait = (input: EvaluateThreadWaitInput): ThreadWaitEvaluation => {
  const thread = input.snapshot.threads.find(
    (candidate) => candidate.id === input.threadId && candidate.archivedAt === null,
  );
  const drainUnsupported =
    thread !== undefined && input.options.drain !== null && thread.backgroundLiveness === undefined;
  if (
    input.options.afterSequence !== null &&
    input.snapshot.snapshotSequence < input.options.afterSequence
  ) {
    return pendingOrTimeout(input.deadlineReached, { drainUnsupported });
  }

  if (thread === undefined) {
    return terminal("vanished", { drainUnsupported });
  }

  const queuedStart = hasQueuedTurnStart(thread, { now: input.now });
  const queuedStartObserved = input.queuedStartObserved || queuedStart;
  const adoptionTimedOut = queuedStartObserved && hasUnadoptedTurnStart(thread) && !queuedStart;

  if (sessionErrorIsFresh(thread)) return terminal("error", { drainUnsupported });
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
    return input.options.onBlocked === "return"
      ? terminal("blocked", { drainUnsupported })
      : pendingOrTimeout(input.deadlineReached, { drainUnsupported });
  }

  let settledOutcome: Exclude<ThreadWaitOutcome, "timeout" | "blocked" | "vanished"> | null = null;

  if (input.options.turnId !== null) {
    if (thread.latestTurn?.turnId !== input.options.turnId) {
      if (queuedStart || thread.session?.status === "starting") {
        return pendingOrTimeout(input.deadlineReached, { drainUnsupported });
      }
      settledOutcome = adoptionTimedOut ? "unadopted" : "superseded";
    } else if (thread.latestTurn.state !== "running") {
      settledOutcome = turnOutcome(thread.latestTurn.state);
    }
  } else {
    const quiescence = threadIsQuiescent(thread, { now: input.now });
    if (quiescence.quiescent) {
      settledOutcome = adoptionTimedOut
        ? "unadopted"
        : thread.latestTurn === null
          ? "idle"
          : turnOutcome(thread.latestTurn.state);
    }
  }

  if (settledOutcome === null) {
    return pendingOrTimeout(input.deadlineReached, { drainUnsupported });
  }

  if (drainPending(thread, input.options.drain)) {
    if (drainLooksStale(thread, input.options.drain, input.updatedAtFrozenMs)) {
      return terminal(settledOutcome, { adoptionTimedOut, drainUnsupported, drainStale: true });
    }
    return pendingOrTimeout(input.deadlineReached, { adoptionTimedOut, drainUnsupported });
  }

  return terminal(settledOutcome, { adoptionTimedOut, drainUnsupported });
};

export const threadWaitExitCode = (outcome: ThreadWaitOutcome, exitZero: boolean): number => {
  if (exitZero || outcome === "completed" || outcome === "idle" || outcome === "superseded") {
    return 0;
  }
  switch (outcome) {
    case "timeout":
    case "unadopted":
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

export interface ThreadWaitDependencies<R = never> {
  readonly fetchShell: (
    origin: string,
    token: string,
    timeouts: CliLiveServerReadTimeouts,
  ) => Effect.Effect<OrchestrationShellSnapshot, CliOrchestrationCallError, R>;
  readonly processAlive: (pid: number) => Effect.Effect<boolean>;
}

const defaultThreadWaitDependencies: ThreadWaitDependencies<HttpClient.HttpClient> = {
  fetchShell: (origin, token, timeouts) =>
    fetchLiveOrchestrationShell(origin, token, timeouts, {
      phase: "wait",
      timeout: timeouts.read,
    }),
  processAlive: isProcessAlive,
};

const THREAD_WAIT_POLL_SCHEDULE = Schedule.exponential(Duration.millis(250), 1.5).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(2))),
  ),
);
export const THREAD_WAIT_FAILURE_GRACE_MS = 30_000;

const isReadTimeout = Schema.is(CliOrchestrationReadTimeoutError);
const isRequestError = Schema.is(CliOrchestrationRequestError);
const isUndeclaredStatusError = Schema.is(CliOrchestrationUndeclaredStatusError);
const isTransientWaitReadError = (error: unknown): boolean =>
  isReadTimeout(error) ||
  isRequestError(error) ||
  (isUndeclaredStatusError(error) && error.status >= 500);

export type WaitReadFailureAction = "retry" | "probe-process" | "give-up" | "timeout";

export const classifyWaitReadFailure = (input: {
  readonly error: unknown;
  readonly nowMs: number;
  readonly failureStartedAtMs: number | null;
  readonly consecutiveFailures: number;
  readonly deadlineExceeded: boolean;
}): WaitReadFailureAction => {
  if (!isTransientWaitReadError(input.error)) return "give-up";
  const failureStartedAtMs = input.failureStartedAtMs ?? input.nowMs;
  const failureGraceExpired = input.nowMs - failureStartedAtMs >= THREAD_WAIT_FAILURE_GRACE_MS;
  if (failureGraceExpired) return input.deadlineExceeded ? "timeout" : "give-up";
  if (isConnectionRefused(input.error) || input.consecutiveFailures >= 3) {
    return "probe-process";
  }
  return "retry";
};

const timeoutResult = (input: {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly thread: OrchestrationThreadShell;
  readonly waited: boolean;
  readonly waitedMs: number;
  readonly options: ThreadWaitOptions;
  readonly queuedStartObserved: boolean;
  readonly now: string;
  readonly updatedAtFrozenMs: number;
}): WaitForThreadResult => {
  const evaluated = evaluateThreadWait({
    snapshot: input.snapshot,
    threadId: input.thread.id,
    options: input.options,
    now: input.now,
    deadlineReached: true,
    queuedStartObserved: input.queuedStartObserved,
    updatedAtFrozenMs: input.updatedAtFrozenMs,
  });
  // The cached snapshot may already evaluate terminal (e.g. a stale drain
  // returning the settled outcome); honor that instead of overriding it
  // with "timeout" and emitting a contradictory drainStale record.
  const outcome =
    evaluated.status === "terminal" && evaluated.outcome !== null ? evaluated.outcome : "timeout";
  return {
    evaluation: {
      ...evaluated,
      status: "terminal",
      outcome,
    },
    thread: input.thread,
    snapshot: input.snapshot,
    waited: input.waited,
    waitedMs: input.waitedMs,
  };
};

const waitForThreadImpl = Effect.fn("waitForThread")(function* <R>(
  input: WaitForThreadInput,
  dependencies: ThreadWaitDependencies<R>,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const nextPollDelay = yield* Schedule.toStep(THREAD_WAIT_POLL_SCHEDULE);
  let snapshot = input.live.shell;
  let lastThread = input.thread;
  let waited = false;
  let queuedStartObserved = false;
  let consecutiveFailures = 0;
  let failureStartedAt: number | null = null;
  // Stale-drain anchor: the `updatedAt` value this wait last saw change and
  // when (on this process's clock). updatedAtFrozenMs is therefore freeze
  // observed by THIS wait — 0 on the first evaluation regardless of how old
  // the pre-wait snapshot is.
  let frozenUpdatedAt = input.thread.updatedAt;
  let frozenSinceMs = startedAt;

  while (true) {
    const nowMs = yield* Clock.currentTimeMillis;
    const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const waitedMs = Math.max(0, nowMs - startedAt);
    queuedStartObserved ||= hasQueuedTurnStart(lastThread, { now });
    if (lastThread.updatedAt !== frozenUpdatedAt) {
      frozenUpdatedAt = lastThread.updatedAt;
      frozenSinceMs = nowMs;
    }
    const updatedAtFrozenMs = Math.max(0, nowMs - frozenSinceMs);
    const evaluated = evaluateThreadWait({
      snapshot,
      threadId: input.thread.id,
      options: input.options,
      now,
      deadlineReached: waitedMs >= input.options.timeoutMs,
      queuedStartObserved,
      updatedAtFrozenMs,
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
      dependencies.fetchShell(input.live.origin, input.token, input.timeouts),
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

    const failedAt = yield* Clock.currentTimeMillis;
    failureStartedAt ??= failedAt;
    consecutiveFailures += 1;
    const action = classifyWaitReadFailure({
      error: attempted.failure,
      nowMs: failedAt,
      failureStartedAtMs: failureStartedAt,
      consecutiveFailures,
      deadlineExceeded: failedAt - startedAt >= input.options.timeoutMs,
    });
    if (action === "retry") continue;
    if (action === "probe-process") {
      if (yield* dependencies.processAlive(input.live.pid)) continue;
      return yield* new CliOrchestrationWaitOutcomeUnknownError({
        operation: "waitLiveServer",
        pid: input.live.pid,
        cause: attempted.failure,
      });
    }
    if (action === "timeout") {
      return timeoutResult({
        snapshot,
        thread: lastThread,
        waited,
        waitedMs: Math.max(0, failedAt - startedAt),
        options: input.options,
        queuedStartObserved,
        now: DateTime.formatIso(DateTime.makeUnsafe(failedAt)),
        updatedAtFrozenMs: Math.max(0, failedAt - frozenSinceMs),
      });
    }
    return yield* attempted.failure;
  }
});

export const waitForThread = <R = HttpClient.HttpClient>(
  input: WaitForThreadInput,
  dependencies?: ThreadWaitDependencies<R>,
) =>
  waitForThreadImpl(
    input,
    dependencies ?? (defaultThreadWaitDependencies as ThreadWaitDependencies<R>),
  );
