import type {
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadShell,
  RuntimeRequestId,
} from "@t3tools/contracts";
import {
  backgroundWorkDrainState,
  type BackgroundWorkDrainScope,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CliOrchestrationWaitOutcomeUnknownError } from "./orchestration.ts";
import { CliOrchestrationCommandRejectedError } from "./orchestrationRpc.ts";
import { threadCliState, threadRunSettled } from "./threadState.ts";

export type ThreadWaitOutcome =
  | "completed"
  | "idle"
  | "superseded"
  | "timeout"
  | "error"
  | "interrupted"
  | "blocked"
  | "vanished";

export type ThreadWaitDrainMode = BackgroundWorkDrainScope | null;
export type ThreadWaitBlockedMode = "wait" | "return";
/** A blocking question holds the turn; a message-mode one is answered by a later message. */
export type ThreadInputResponseMode = "blocking" | "message";

export interface ThreadWaitOptions {
  /** Wait until the shell has reached this sequence (from `thread send --json`). */
  readonly afterSequence: number | null;
  /** Wait for this run; a newer run makes the outcome `superseded`. */
  readonly runId: string | null;
  readonly timeoutMs: number;
  readonly drain: ThreadWaitDrainMode;
  readonly onBlocked: ThreadWaitBlockedMode;
}

/** What the wait has seen: the thread (null once it left the active shell) and the shell sequence. */
export interface ThreadWaitObservation {
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly sequence: number;
}

export const observeShellItem = (
  observation: ThreadWaitObservation,
  item: OrchestrationV2ShellStreamItem,
  threadId: string,
): ThreadWaitObservation => {
  switch (item.kind) {
    case "synchronized":
      return observation;
    case "snapshot":
      // A marked enrichment frame carries project metadata only (no threads).
      if (item.resolvedRepositoryIdentityRoots !== undefined) return observation;
      return {
        thread:
          item.snapshot.threads.find(
            (thread) => thread.id === threadId && thread.archivedAt === null,
          ) ?? null,
        sequence: Math.max(observation.sequence, item.snapshot.snapshotSequence),
      };
    case "project.updated":
    case "project.removed":
      return { ...observation, sequence: Math.max(observation.sequence, item.sequence) };
    case "thread.updated":
      return {
        thread:
          item.thread.id !== threadId
            ? observation.thread
            : item.location === "active" && item.thread.archivedAt === null
              ? item.thread
              : null,
        sequence: Math.max(observation.sequence, item.sequence),
      };
    case "thread.removed":
      return {
        thread:
          item.threadId === threadId && item.location === "active" ? null : observation.thread,
        sequence: Math.max(observation.sequence, item.sequence),
      };
  }
};

/**
 * Whether a pending request holds the thread's turn. Auth refreshes resolve
 * on their own, and a message-mode question does not hold the turn. A
 * question whose mode is unknown counts as blocking.
 */
export const threadHasBlockingRequest = (
  thread: Pick<OrchestrationV2ThreadShell, "pendingRuntimeRequest">,
  responseMode: (requestId: RuntimeRequestId) => ThreadInputResponseMode | undefined,
): boolean => {
  const request = thread.pendingRuntimeRequest;
  if (request === null || request.kind === "auth_refresh") return false;
  return request.kind !== "user_input" || responseMode(request.id) !== "message";
};

const settledOutcome = (
  thread: OrchestrationV2ThreadShell,
  runId: string | null,
): Exclude<ThreadWaitOutcome, "timeout" | "blocked" | "vanished"> | null => {
  if (runId !== null && thread.activeRunId !== runId && thread.latestRunId !== runId) {
    return "superseded";
  }
  if (!threadRunSettled(thread)) return null;
  const state = threadCliState(thread);
  return state === "running" ? null : state;
};

/** The wait's outcome for what it has observed, or null while it keeps waiting. */
export const evaluateThreadWait = (input: {
  readonly observation: ThreadWaitObservation;
  readonly options: ThreadWaitOptions;
  readonly responseMode: (requestId: RuntimeRequestId) => ThreadInputResponseMode | undefined;
}): Exclude<ThreadWaitOutcome, "timeout"> | null => {
  const { observation, options } = input;
  if (options.afterSequence !== null && observation.sequence < options.afterSequence) return null;
  const thread = observation.thread;
  if (thread === null) return "vanished";
  if (threadHasBlockingRequest(thread, input.responseMode)) {
    return options.onBlocked === "return" ? "blocked" : null;
  }
  const outcome = settledOutcome(thread, options.runId);
  if (outcome === null) return null;
  if (options.drain !== null && !backgroundWorkDrainState(thread, options.drain).drained) {
    return null;
  }
  return outcome;
};

export const threadWaitExitCode = (outcome: ThreadWaitOutcome, exitZero: boolean): number => {
  if (exitZero) return 0;
  switch (outcome) {
    case "completed":
    case "idle":
    case "superseded":
      return 0;
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

export class ThreadCliWaitConnectionError extends Schema.TaggedError<ThreadCliWaitConnectionError>()(
  "ThreadCliWaitConnectionError",
  {
    operation: Schema.Literal("waitLiveServer"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Lost the connection to the server during the wait and could not restore it, so the thread's outcome is unknown.";
  }
}

export interface ThreadWaitDependencies<E, R> {
  /** One connection's shell stream, resuming after the given sequence; rerunning it reconnects. */
  readonly shellStream: (
    afterSequence: number,
  ) => Stream.Stream<OrchestrationV2ShellStreamItem, E, R>;
  /** How a pending question is answered; null once it is no longer pending. */
  readonly userInputResponseMode: (
    requestId: RuntimeRequestId,
  ) => Effect.Effect<ThreadInputResponseMode | null, E, R>;
  readonly serverAlive: Effect.Effect<boolean>;
}

export interface WaitForThreadInput {
  readonly thread: OrchestrationV2ThreadShell;
  /** Sequence of the shell `thread` was read from. */
  readonly sequence: number;
  readonly serverPid: number;
  readonly options: ThreadWaitOptions;
}

export interface WaitForThreadResult {
  readonly outcome: ThreadWaitOutcome;
  /** The last observed thread; a vanished thread keeps its last active shell. */
  readonly thread: OrchestrationV2ThreadShell;
  readonly observedSequence: number;
  readonly waited: boolean;
  readonly waitedMs: number;
  readonly hasPendingBlockingUserInput: boolean;
}

/** A connection that keeps failing for this long ends the wait. */
export const THREAD_WAIT_FAILURE_GRACE_MS = 30_000;
const reconnectDelayMs = (attempt: number) => Math.min(2_000, 250 * 1.5 ** (attempt - 1));
const isCommandRejected = Schema.is(CliOrchestrationCommandRejectedError);

/**
 * Follows the live shell stream until the thread reaches an outcome. A lost
 * connection is restored by resuming after the last observed sequence; the
 * wait fails only when the
 * server process is gone (outcome unknown), the server rejects the
 * subscription, or reconnecting keeps failing past the grace period.
 */
export const waitForThread = Effect.fn("waitForThread")(function* <E, R>(
  input: WaitForThreadInput,
  deps: ThreadWaitDependencies<E, R>,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const threadId = input.thread.id;
  let observation: ThreadWaitObservation = { thread: input.thread, sequence: input.sequence };
  let lastThread = input.thread;
  let waited = false;
  const responseModes = new Map<RuntimeRequestId, ThreadInputResponseMode>();
  const responseMode = (requestId: RuntimeRequestId) => responseModes.get(requestId);

  const classifyPendingQuestion = Effect.suspend(() => {
    const request = observation.thread?.pendingRuntimeRequest;
    if (request?.kind !== "user_input" || responseModes.has(request.id)) return Effect.void;
    return deps
      .userInputResponseMode(request.id)
      .pipe(Effect.map((mode) => void responseModes.set(request.id, mode ?? "blocking")));
  });
  const evaluate = () => evaluateThreadWait({ observation, options: input.options, responseMode });
  const finish = (outcome: ThreadWaitOutcome) =>
    Effect.map(Clock.currentTimeMillis, (now): WaitForThreadResult => {
      const thread = observation.thread ?? lastThread;
      const request = thread.pendingRuntimeRequest;
      return {
        outcome,
        thread,
        observedSequence: observation.sequence,
        waited,
        waitedMs: Math.max(0, now - startedAt),
        hasPendingBlockingUserInput:
          request?.kind === "user_input" && responseMode(request.id) !== "message",
      };
    });

  const initial = yield* Effect.result(classifyPendingQuestion);
  const initialOutcome = initial._tag === "Success" ? evaluate() : null;
  if (initialOutcome !== null) return yield* finish(initialOutcome);
  waited = true;

  let failureStartedAt: number | null = null;
  let attempt = 0;
  while (true) {
    const remainingMs = input.options.timeoutMs - ((yield* Clock.currentTimeMillis) - startedAt);
    if (remainingMs <= 0) return yield* finish("timeout");

    const connection = yield* deps.shellStream(observation.sequence).pipe(
      Stream.mapEffect((item) =>
        Effect.gen(function* () {
          observation = observeShellItem(observation, item, threadId);
          if (observation.thread !== null) lastThread = observation.thread;
          yield* classifyPendingQuestion;
          failureStartedAt = null;
          attempt = 0;
          return evaluate();
        }),
      ),
      Stream.filter(
        (outcome): outcome is Exclude<ThreadWaitOutcome, "timeout"> => outcome !== null,
      ),
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(remainingMs)),
      Effect.result,
    );
    if (connection._tag === "Success") {
      if (Option.isNone(connection.success)) return yield* finish("timeout");
      if (Option.isSome(connection.success.value)) {
        return yield* finish(connection.success.value.value);
      }
    }
    const cause =
      connection._tag === "Failure" ? connection.failure : new Error("The shell stream ended.");
    if (isCommandRejected(cause)) return yield* cause;
    if (!(yield* deps.serverAlive)) {
      return yield* new CliOrchestrationWaitOutcomeUnknownError({
        operation: "waitLiveServer",
        pid: input.serverPid,
        cause,
      });
    }
    const failedAt = yield* Clock.currentTimeMillis;
    failureStartedAt ??= failedAt;
    if (failedAt - failureStartedAt >= THREAD_WAIT_FAILURE_GRACE_MS) {
      return yield* new ThreadCliWaitConnectionError({ operation: "waitLiveServer", cause });
    }
    attempt += 1;
    const untilDeadlineMs = input.options.timeoutMs - (failedAt - startedAt);
    yield* Effect.sleep(
      Duration.millis(Math.max(0, Math.min(reconnectDelayMs(attempt), untilDeadlineMs))),
    );
  }
});
