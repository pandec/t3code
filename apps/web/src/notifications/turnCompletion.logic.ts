import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface TurnCompletionCandidate {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly title: string;
  /**
   * How long the turn ran, from the thread's own timestamps. Null when the
   * server sent timestamps this client cannot parse — no duration filter may
   * silence a completion on a guess.
   */
  readonly durationMs: number | null;
}

export interface TurnCompletionSnapshot {
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly seenCompletedTurnIds: ReadonlySet<string>;
}

export function resolveTurnCompletionCandidatesForDelivery(
  pending: ReadonlyArray<TurnCompletionCandidate>,
  current: ReadonlyArray<TurnCompletionCandidate>,
  settingsHydrated: boolean,
): {
  readonly pending: ReadonlyArray<TurnCompletionCandidate>;
  readonly deliver: ReadonlyArray<TurnCompletionCandidate>;
} {
  const combined = pending.length === 0 ? current : [...pending, ...current];
  return settingsHydrated ? { pending: [], deliver: combined } : { pending: combined, deliver: [] };
}

export function filterShellsForTurnCompletion(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  readyEnvironmentIds: ReadonlySet<string>,
): ReadonlyArray<EnvironmentThreadShell> {
  return shells.filter((shell) => readyEnvironmentIds.has(shell.environmentId));
}

function threadShellKey(shell: EnvironmentThreadShell): string {
  return threadKey({ environmentId: shell.environmentId, threadId: shell.id });
}

/**
 * The latest turn's id iff that turn is in the terminal "completed" state.
 * Keyed by turnId alone — not completedAt — so a re-serialized or
 * clock-corrected timestamp on the same turn can never re-fire. Interrupted
 * and errored turns are deliberately excluded: a user pressing Stop is not a
 * completion worth announcing.
 */
function completedTurnId(shell: EnvironmentThreadShell): string | null {
  const latestTurn = shell.latestTurn;
  return latestTurn?.state === "completed" && latestTurn.completedAt !== null
    ? latestTurn.turnId
    : null;
}

/**
 * Wall-clock length of the shell's completed turn.
 *
 * `startedAt` is when the provider actually began; `requestedAt` covers turns
 * whose start was never stamped (older servers, queued starts) so a completion
 * is never treated as instantaneous just because one field is missing.
 */
function completedTurnDurationMs(shell: EnvironmentThreadShell): number | null {
  const latestTurn = shell.latestTurn;
  if (!latestTurn || latestTurn.completedAt === null) {
    return null;
  }
  const startedAtMs = Date.parse(latestTurn.startedAt ?? latestTurn.requestedAt);
  const completedAtMs = Date.parse(latestTurn.completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
    return null;
  }
  return Math.max(0, completedAtMs - startedAtMs);
}

/**
 * Whether a completion clears the "only tell me about long turns" threshold.
 * A turn whose duration could not be determined always announces: staying
 * quiet would be a guess, and a missed completion is the costlier mistake.
 */
export function shouldAnnounceTurnCompletion(
  candidate: Pick<TurnCompletionCandidate, "durationMs">,
  minDurationSeconds: number,
): boolean {
  if (!Number.isFinite(minDurationSeconds) || minDurationSeconds <= 0) {
    return true;
  }
  if (candidate.durationMs === null) {
    return true;
  }
  return candidate.durationMs >= minDurationSeconds * 1_000;
}

/** Drops completions shorter than the configured minimum turn duration. */
export function filterTurnCompletionCandidatesByDuration(
  candidates: ReadonlyArray<TurnCompletionCandidate>,
  minDurationSeconds: number,
): ReadonlyArray<TurnCompletionCandidate> {
  if (!Number.isFinite(minDurationSeconds) || minDurationSeconds <= 0) {
    return candidates;
  }
  return candidates.filter((candidate) =>
    shouldAnnounceTurnCompletion(candidate, minDurationSeconds),
  );
}

function collectCompletedTurnIds(
  shells: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlySet<string> {
  const turnIds = new Set<string>();
  for (const shell of shells) {
    const turnId = completedTurnId(shell);
    if (turnId !== null) {
      turnIds.add(turnId);
    }
  }
  return turnIds;
}

/**
 * Threads whose latest turn transitioned into "completed" between two shell
 * lists. A thread absent from the previous list never fires: freshly synced
 * threads (initial load, environment reconnect, replayed history) arrive
 * already-completed and must stay silent — only a transition observed live
 * counts.
 */
export function collectTurnCompletionCandidates(
  previousShells: ReadonlyArray<EnvironmentThreadShell>,
  nextShells: ReadonlyArray<EnvironmentThreadShell>,
): TurnCompletionCandidate[] {
  const previousCompletedTurnIds = new Map(
    previousShells.map((shell) => [threadShellKey(shell), completedTurnId(shell)] as const),
  );
  const candidates: TurnCompletionCandidate[] = [];
  for (const shell of nextShells) {
    const key = threadShellKey(shell);
    if (!previousCompletedTurnIds.has(key)) {
      continue;
    }
    const turnId = completedTurnId(shell);
    if (turnId === null || previousCompletedTurnIds.get(key) === turnId) {
      continue;
    }
    candidates.push({
      environmentId: shell.environmentId,
      threadId: shell.id,
      turnId,
      title: shell.title,
      durationMs: completedTurnDurationMs(shell),
    });
  }
  return candidates;
}

export function seedTurnCompletionSnapshot(
  shells: ReadonlyArray<EnvironmentThreadShell>,
): TurnCompletionSnapshot {
  return {
    shells,
    seenCompletedTurnIds: collectCompletedTurnIds(shells),
  };
}

export function advanceTurnCompletionSnapshot(
  previous: TurnCompletionSnapshot,
  nextShells: ReadonlyArray<EnvironmentThreadShell>,
): {
  readonly snapshot: TurnCompletionSnapshot;
  readonly candidates: ReadonlyArray<TurnCompletionCandidate>;
} {
  const seenCompletedTurnIds = new Set(previous.seenCompletedTurnIds);
  const candidates: TurnCompletionCandidate[] = [];
  for (const candidate of collectTurnCompletionCandidates(previous.shells, nextShells)) {
    if (seenCompletedTurnIds.has(candidate.turnId)) {
      continue;
    }
    seenCompletedTurnIds.add(candidate.turnId);
    candidates.push(candidate);
  }
  for (const turnId of collectCompletedTurnIds(nextShells)) {
    seenCompletedTurnIds.add(turnId);
  }
  return {
    snapshot: { shells: nextShells, seenCompletedTurnIds },
    candidates,
  };
}

export function buildTurnCompletionCopy(candidate: Pick<TurnCompletionCandidate, "title">): {
  title: string;
  body: string;
} {
  const threadLabel = candidate.title.trim();
  return {
    title: "Agent finished",
    body: threadLabel.length > 0 ? threadLabel : "A thread finished working.",
  };
}
