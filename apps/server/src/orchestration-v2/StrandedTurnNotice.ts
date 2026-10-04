import type { OrchestrationV2ProviderTurn, OrchestrationV2Run, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/**
 * Fork: prepended to the first provider turn after a turn was stranded by a
 * server shutdown or restart. Providers report a tool call that the shutdown
 * cancelled with their own "the user doesn't want to proceed … STOP" text,
 * which an agent otherwise reads as the user refusing and halting on purpose.
 */
export const STRANDED_PRIOR_TURN_NOTICE = [
  "<system-reminder>",
  "The previous turn on this thread was cut off when T3 shut down and took its session with it — not because the user stopped it.",
  'If that turn ends with a tool result saying the user rejected the tool call or "doesn\'t want to proceed", the shutdown cancelled it; the user did not refuse and is not waiting for you to justify yourself.',
  // Deliberately does not tell the agent to resume: the user may have quit
  // mid-turn on purpose, and the message below is what they want done now.
  "Take the message below as the instruction, and re-run anything that was cut off if you still need its result.",
  "</system-reminder>",
].join("\n");

type RunState = Pick<
  OrchestrationV2Run,
  | "id"
  | "ordinal"
  | "status"
  | "userMessageId"
  | "providerThreadId"
  | "activeAttemptId"
  | "strandedByRestart"
>;
type ProviderTurnState = Pick<
  OrchestrationV2ProviderTurn,
  "id" | "runAttemptId" | "providerThreadId" | "status"
>;

/**
 * Whether the previous turn this run's provider thread received was cut off
 * mid-turn by restart recovery. Recovery marks each run it cancels with
 * `strandedByRestart`; a run that had already settled (only background work
 * lost) keeps its completed provider turn, and a user stop settles a turn as
 * `interrupted`. A Stop the restart overtook leaves its unpaired durable
 * request (`stopRequested`), so that cut-off was asked for. Derived rather
 * than cleared: once a later turn reaches the provider, it is the previous
 * turn. Compactions are skipped both ways (a prefixed `/compact` stops being
 * the command; other slash commands are skipped by the caller for the same
 * reason), and a steer's replacement attempt does not repeat what an earlier
 * attempt delivered.
 */
export function priorTurnStrandedByRestart(input: {
  readonly runs: ReadonlyArray<RunState>;
  readonly providerTurns: ReadonlyArray<ProviderTurnState>;
  readonly compactionMessageIds: ReadonlySet<string>;
  readonly run: Omit<RunState, "status" | "strandedByRestart">;
  /** Every attempt id of `run`; a steer replaces the attempt but not the run. */
  readonly runAttemptIds: ReadonlyArray<string>;
  /** Whether the stranded run has a Stop request without an interrupt result. */
  readonly stopRequested: (runId: RunId) => Effect.Effect<boolean>;
}): Effect.Effect<boolean> {
  const providerThreadId = input.run.providerThreadId;
  if (providerThreadId === null || input.compactionMessageIds.has(input.run.userMessageId)) {
    return Effect.succeed(false);
  }
  const turns = input.providerTurns.filter((turn) => turn.providerThreadId === providerThreadId);
  const delivered = (attemptId: string | null) =>
    attemptId !== null && turns.some((turn) => turn.runAttemptId === attemptId);
  if (
    input.runAttemptIds.some(
      (attemptId) => attemptId !== input.run.activeAttemptId && delivered(attemptId),
    )
  ) {
    return Effect.succeed(false);
  }
  const previous = input.runs
    .filter(
      (candidate) =>
        candidate.id !== input.run.id &&
        candidate.providerThreadId === providerThreadId &&
        candidate.ordinal < input.run.ordinal &&
        candidate.status !== "rolled_back" &&
        !input.compactionMessageIds.has(candidate.userMessageId) &&
        delivered(candidate.activeAttemptId),
    )
    .reduce<RunState | undefined>(
      (latest, candidate) => (!latest || candidate.ordinal > latest.ordinal ? candidate : latest),
      undefined,
    );
  if (
    previous === undefined ||
    previous.status !== "cancelled" ||
    previous.strandedByRestart !== true ||
    !turns.some(
      (turn) => turn.runAttemptId === previous.activeAttemptId && turn.status === "cancelled",
    )
  ) {
    return Effect.succeed(false);
  }
  return input.stopRequested(previous.id).pipe(Effect.map((requested) => !requested));
}
