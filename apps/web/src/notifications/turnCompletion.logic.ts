import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface TurnCompletionCandidate {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly title: string;
}

export interface TurnCompletionSnapshot {
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly seenCompletedTurnIds: ReadonlySet<string>;
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
  const candidates = collectTurnCompletionCandidates(previous.shells, nextShells).filter(
    (candidate) => !previous.seenCompletedTurnIds.has(candidate.turnId),
  );
  const seenCompletedTurnIds = new Set(previous.seenCompletedTurnIds);
  for (const turnId of collectCompletedTurnIds(nextShells)) {
    seenCompletedTurnIds.add(turnId);
  }
  return {
    snapshot: { shells: nextShells, seenCompletedTurnIds },
    candidates,
  };
}

export function buildTurnCompletionCopy(candidate: TurnCompletionCandidate): {
  title: string;
  body: string;
} {
  const threadLabel = candidate.title.trim();
  return {
    title: "Agent finished",
    body: threadLabel.length > 0 ? threadLabel : "A thread finished working.",
  };
}
