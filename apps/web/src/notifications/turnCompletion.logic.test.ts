import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationLatestTurn, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceTurnCompletionSnapshot,
  buildTurnCompletionCopy,
  collectTurnCompletionCandidates,
  filterShellsForTurnCompletion,
  filterTurnCompletionCandidatesByDuration,
  resolveTurnCompletionCandidatesForDelivery,
  seedTurnCompletionSnapshot,
  shouldAnnounceTurnCompletion,
} from "./turnCompletion.logic";

function makeTurn(input: {
  turnId: string;
  state: OrchestrationLatestTurn["state"];
  completedAt?: string | null;
}): OrchestrationLatestTurn {
  return {
    turnId: input.turnId as TurnId,
    state: input.state,
    requestedAt: "2026-07-24T10:00:00.000Z",
    startedAt: "2026-07-24T10:00:01.000Z",
    completedAt: input.completedAt === undefined ? "2026-07-24T10:01:00.000Z" : input.completedAt,
    assistantMessageId: null,
  };
}

function makeShell(input: {
  id: string;
  environmentId?: string;
  title?: string;
  latestTurn: OrchestrationLatestTurn | null;
}): EnvironmentThreadShell {
  return {
    id: input.id,
    environmentId: input.environmentId ?? "env-1",
    title: input.title ?? `Thread ${input.id}`,
    latestTurn: input.latestTurn,
  } as EnvironmentThreadShell;
}

const running = (id: string) =>
  makeShell({
    id,
    latestTurn: makeTurn({ turnId: `${id}-turn`, state: "running", completedAt: null }),
  });
const completed = (id: string, turnId = `${id}-turn`) =>
  makeShell({ id, latestTurn: makeTurn({ turnId, state: "completed" }) });

describe("collectTurnCompletionCandidates", () => {
  it("fires when a known thread's turn transitions to completed", () => {
    const candidates = collectTurnCompletionCandidates([running("a")], [completed("a")]);
    expect(candidates).toEqual([
      {
        environmentId: "env-1",
        threadId: "a",
        turnId: "a-turn",
        title: "Thread a",
        durationMs: 59_000,
      },
    ]);
  });

  it("does not fire for threads absent from the previous list (initial sync, reconnect)", () => {
    expect(collectTurnCompletionCandidates([], [completed("a")])).toEqual([]);
    expect(
      collectTurnCompletionCandidates([running("a")], [completed("a"), completed("b")]),
    ).toEqual([
      {
        environmentId: "env-1",
        threadId: "a",
        turnId: "a-turn",
        title: "Thread a",
        durationMs: 59_000,
      },
    ]);
  });

  it("does not fire again for an unchanged completed turn (dedupe)", () => {
    const next = [completed("a")];
    expect(collectTurnCompletionCandidates(next, next)).toEqual([]);
  });

  it("does not fire when only the completedAt timestamp is re-serialized on the same turn", () => {
    const before = makeShell({
      id: "a",
      latestTurn: makeTurn({
        turnId: "a-turn",
        state: "completed",
        completedAt: "2026-07-24T10:01:00.000Z",
      }),
    });
    const after = makeShell({
      id: "a",
      latestTurn: makeTurn({
        turnId: "a-turn",
        state: "completed",
        completedAt: "2026-07-24T10:01:00.500Z",
      }),
    });
    expect(collectTurnCompletionCandidates([before], [after])).toEqual([]);
  });

  it("does not fire for interrupted or errored turns", () => {
    for (const state of ["interrupted", "error"] as const) {
      const settled = makeShell({ id: "a", latestTurn: makeTurn({ turnId: "a-turn-2", state }) });
      expect(collectTurnCompletionCandidates([running("a")], [settled])).toEqual([]);
    }
  });

  it("does not fire for a completed turn missing completedAt", () => {
    const settled = makeShell({
      id: "a",
      latestTurn: makeTurn({ turnId: "a-turn", state: "completed", completedAt: null }),
    });
    expect(collectTurnCompletionCandidates([running("a")], [settled])).toEqual([]);
  });

  it("fires again when a later turn of the same thread completes", () => {
    const candidates = collectTurnCompletionCandidates(
      [completed("a", "turn-1")],
      [completed("a", "turn-2")],
    );
    expect(candidates).toHaveLength(1);
  });

  it("does not fire when a completed thread goes back to running", () => {
    expect(collectTurnCompletionCandidates([completed("a")], [running("a")])).toEqual([]);
  });

  it("keys threads by environment: the same thread id in another environment is unknown", () => {
    const other = makeShell({
      id: "a",
      environmentId: "env-2",
      latestTurn: makeTurn({ turnId: "a-turn", state: "completed" }),
    });
    expect(collectTurnCompletionCandidates([running("a")], [other])).toEqual([]);
  });
});

describe("turn completion snapshot", () => {
  it("seeds completed turns as history and ignores an unchanged settings-triggered rerun", () => {
    const shells = [completed("a")];
    const seeded = seedTurnCompletionSnapshot(shells);
    expect(advanceTurnCompletionSnapshot(seeded, shells).candidates).toEqual([]);
  });

  it("never re-fires a turn id that temporarily leaves the completed state", () => {
    const initial = seedTurnCompletionSnapshot([running("a")]);
    const firstCompletion = advanceTurnCompletionSnapshot(initial, [completed("a")]);
    expect(firstCompletion.candidates).toHaveLength(1);

    const runningAgain = advanceTurnCompletionSnapshot(firstCompletion.snapshot, [running("a")]);
    const sameTurnCompletesAgain = advanceTurnCompletionSnapshot(runningAgain.snapshot, [
      completed("a"),
    ]);
    expect(sameTurnCompletesAgain.candidates).toEqual([]);
  });

  it("remembers silent completions for threads newly introduced by a snapshot", () => {
    const initial = seedTurnCompletionSnapshot([running("a")]);
    const introduced = advanceTurnCompletionSnapshot(initial, [running("a"), completed("b")]);
    expect(introduced.candidates).toEqual([]);

    const runningAgain = advanceTurnCompletionSnapshot(introduced.snapshot, [
      running("a"),
      running("b"),
    ]);
    const sameTurnCompletesAgain = advanceTurnCompletionSnapshot(runningAgain.snapshot, [
      running("a"),
      completed("b"),
    ]);
    expect(sameTurnCompletesAgain.candidates).toEqual([]);
  });

  it("keeps healthy environments live while another environment resynchronizes", () => {
    const env1Running = running("a");
    const env2Running = makeShell({
      ...running("b"),
      environmentId: "env-2",
    });
    const initial = seedTurnCompletionSnapshot([env1Running, env2Running]);

    const env2Unavailable = filterShellsForTurnCompletion(
      [
        completed("a"),
        makeShell({
          ...completed("b"),
          environmentId: "env-2",
        }),
      ],
      new Set(["env-1"]),
    );
    const whileEnv2Synchronizes = advanceTurnCompletionSnapshot(initial, env2Unavailable);
    expect(whileEnv2Synchronizes.candidates.map((candidate) => candidate.turnId)).toEqual([
      "a-turn",
    ]);

    const env2Returns = advanceTurnCompletionSnapshot(whileEnv2Synchronizes.snapshot, [
      completed("a"),
      makeShell({
        ...completed("b"),
        environmentId: "env-2",
      }),
    ]);
    expect(env2Returns.candidates).toEqual([]);
  });

  it("keeps a healthy environment live while a brand-new environment bootstraps", () => {
    const initial = seedTurnCompletionSnapshot([running("a")]);
    const authoritativeWhileEnv2Bootstraps = filterShellsForTurnCompletion(
      [
        completed("a"),
        makeShell({
          ...running("b"),
          environmentId: "env-2",
        }),
      ],
      new Set(["env-1"]),
    );

    const result = advanceTurnCompletionSnapshot(initial, authoritativeWhileEnv2Bootstraps);
    expect(result.candidates.map((candidate) => candidate.turnId)).toEqual(["a-turn"]);
  });

  it("keeps lifetime turn dedupe when an environment leaves and re-enters the baseline", () => {
    const initial = seedTurnCompletionSnapshot([running("a")]);
    const firstCompletion = advanceTurnCompletionSnapshot(initial, [completed("a")]);
    expect(firstCompletion.candidates).toHaveLength(1);

    const unavailable = advanceTurnCompletionSnapshot(firstCompletion.snapshot, []);
    const returnsRunning = advanceTurnCompletionSnapshot(unavailable.snapshot, [running("a")]);
    const sameTurnCompletesAgain = advanceTurnCompletionSnapshot(returnsRunning.snapshot, [
      completed("a"),
    ]);
    expect(sameTurnCompletesAgain.candidates).toEqual([]);
  });

  it("deduplicates the same turn id within one snapshot", () => {
    const env1Running = running("a");
    const env2Running = makeShell({
      ...running("b"),
      environmentId: "env-2",
    });
    const env1Completed = completed("a", "shared-turn");
    const env2Completed = makeShell({
      id: "b",
      environmentId: "env-2",
      latestTurn: makeTurn({ turnId: "shared-turn", state: "completed" }),
    });

    const result = advanceTurnCompletionSnapshot(
      seedTurnCompletionSnapshot([env1Running, env2Running]),
      [env1Completed, env2Completed],
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.turnId).toBe("shared-turn");
  });
});

describe("turn completion minimum duration", () => {
  const candidate = (durationMs: number | null) => ({
    environmentId: "env-1" as EnvironmentId,
    threadId: "a" as ThreadId,
    turnId: "turn-a",
    title: "Thread a",
    durationMs,
  });

  it("measures the turn from startedAt to completedAt", () => {
    expect(collectTurnCompletionCandidates([running("a")], [completed("a")])[0]?.durationMs).toBe(
      59_000,
    );
  });

  it("falls back to requestedAt when the turn was never stamped as started", () => {
    const before = makeShell({
      id: "a",
      latestTurn: { ...makeTurn({ turnId: "a-turn", state: "running" }), completedAt: null },
    });
    const after = makeShell({
      id: "a",
      latestTurn: { ...makeTurn({ turnId: "a-turn", state: "completed" }), startedAt: null },
    });
    expect(collectTurnCompletionCandidates([before], [after])[0]?.durationMs).toBe(60_000);
  });

  it("reports no duration when the timestamps are unusable", () => {
    const before = makeShell({
      id: "a",
      latestTurn: { ...makeTurn({ turnId: "a-turn", state: "running" }), completedAt: null },
    });
    const after = makeShell({
      id: "a",
      latestTurn: {
        ...makeTurn({ turnId: "a-turn", state: "completed" }),
        completedAt: "not-a-date",
      },
    });
    expect(collectTurnCompletionCandidates([before], [after])[0]?.durationMs).toBeNull();
  });

  it("announces everything when the threshold is zero or invalid", () => {
    expect(shouldAnnounceTurnCompletion(candidate(10), 0)).toBe(true);
    expect(shouldAnnounceTurnCompletion(candidate(10), Number.NaN)).toBe(true);
    expect(filterTurnCompletionCandidatesByDuration([candidate(10)], 0)).toHaveLength(1);
  });

  it("suppresses turns shorter than the threshold and keeps the rest", () => {
    expect(shouldAnnounceTurnCompletion(candidate(29_999), 30)).toBe(false);
    expect(shouldAnnounceTurnCompletion(candidate(30_000), 30)).toBe(true);
    expect(
      filterTurnCompletionCandidatesByDuration([candidate(1_000), candidate(60_000)], 30).map(
        (entry) => entry.durationMs,
      ),
    ).toEqual([60_000]);
  });

  it("announces a turn whose duration is unknown rather than guessing", () => {
    expect(shouldAnnounceTurnCompletion(candidate(null), 3_600)).toBe(true);
    expect(filterTurnCompletionCandidatesByDuration([candidate(null)], 3_600)).toHaveLength(1);
  });
});

describe("turn completion settings hydration", () => {
  const candidate = {
    environmentId: "env-1" as EnvironmentId,
    threadId: "a" as ThreadId,
    turnId: "turn-a",
    title: "Thread a",
    durationMs: 59_000,
  };

  it("holds observed candidates until persisted settings hydrate", () => {
    const beforeHydration = resolveTurnCompletionCandidatesForDelivery([], [candidate], false);
    expect(beforeHydration.deliver).toEqual([]);
    expect(beforeHydration.pending).toEqual([candidate]);

    const afterHydration = resolveTurnCompletionCandidatesForDelivery(
      beforeHydration.pending,
      [],
      true,
    );
    expect(afterHydration.pending).toEqual([]);
    expect(afterHydration.deliver).toEqual([candidate]);
  });
});

describe("buildTurnCompletionCopy", () => {
  it("uses the thread title as the body", () => {
    expect(buildTurnCompletionCopy({ title: "Fix the flaky test" })).toEqual({
      title: "Agent finished",
      body: "Fix the flaky test",
    });
  });

  it("falls back for whitespace-only titles", () => {
    expect(buildTurnCompletionCopy({ title: "  " }).body).toBe("A thread finished working.");
  });
});
