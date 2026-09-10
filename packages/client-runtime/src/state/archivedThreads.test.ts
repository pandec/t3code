import {
  EnvironmentId,
  ProjectId,
  type OrchestrationGetRecentArchivedThreadsResult,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createArchivedThreadSnapshotsAtomFamily,
  createRecentArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  makeRecentArchivedThreadsKey,
  parseArchivedThreadsEnvironmentKey,
  parseRecentArchivedThreadsKey,
  selectRecentArchivedThreads,
} from "./archivedThreads.ts";

it("round-trips environment keys in sorted order", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const key = makeArchivedThreadsEnvironmentKey([envB, envA]);

  expect(parseArchivedThreadsEnvironmentKey(key)).toEqual([envA, envB]);
});

it("selects the newest archived threads across environments", () => {
  const makeThreads = (
    threads: ReadonlyArray<{
      readonly id: string;
      readonly archivedAt: string;
    }>,
  ) =>
    threads.map((thread) => ({
      id: thread.id,
      archivedAt: thread.archivedAt,
      updatedAt: thread.archivedAt,
      createdAt: thread.archivedAt,
    })) as never;
  const result = selectRecentArchivedThreads(
    [
      {
        environmentId: EnvironmentId.make("env-a"),
        threads: makeThreads([
          { id: "older", archivedAt: "2026-01-01T00:00:00.000Z" },
          { id: "newest", archivedAt: "2026-01-03T00:00:00.000Z" },
        ]),
        totalArchivedCount: 7,
      },
      {
        environmentId: EnvironmentId.make("env-b"),
        threads: makeThreads([{ id: "middle", archivedAt: "2026-01-02T00:00:00.000Z" }]),
        totalArchivedCount: 4,
      },
    ],
    2,
  );

  expect(result.totalCount).toBe(11);
  expect(result.threads.map((thread) => [thread.environmentId, thread.id])).toEqual([
    ["env-a", "newest"],
    ["env-b", "middle"],
  ]);
});

it("pulls the selected thread's row past the clip", () => {
  const snapshots = [
    {
      environmentId: EnvironmentId.make("env-a"),
      threads: ["newest", "middle", "oldest"].map((id, index) => ({
        id,
        archivedAt: `2026-01-0${3 - index}T00:00:00.000Z`,
        updatedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })) as never,
      totalArchivedCount: 3,
    },
  ];

  const withSelected = selectRecentArchivedThreads(snapshots, 1, "env-a:oldest");
  expect(withSelected.threads.map((thread) => thread.id)).toEqual(["newest", "oldest"]);

  // A selected thread already inside the clip must not gain a duplicate row.
  expect(
    selectRecentArchivedThreads(snapshots, 1, "env-a:newest").threads.map((thread) => thread.id),
  ).toEqual(["newest"]);
  // A selected thread the snapshots never held cannot be conjured up.
  expect(
    selectRecentArchivedThreads(snapshots, 1, "env-a:missing").threads.map((thread) => thread.id),
  ).toEqual(["newest"]);
});

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])))).toEqual({
    snapshots: [],
    error: "Failed to load archived threads.",
    isLoading: false,
  });

  registry.dispose();
});

it("round-trips recent-archive keys with per-environment project filters", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const key = makeRecentArchivedThreadsKey(
    [envB, envA],
    5,
    new Map([[envA, [ProjectId.make("p2"), ProjectId.make("p1")]]]),
  );

  expect(parseRecentArchivedThreadsKey(key)).toEqual({
    targets: [{ environmentId: envA, projectIds: ["p1", "p2"] }, { environmentId: envB }],
    visibleCount: 5,
  });
  // Filter order must not fork the cache.
  expect(key).toBe(
    makeRecentArchivedThreadsKey(
      [envA, envB],
      5,
      new Map([[envA, [ProjectId.make("p1"), ProjectId.make("p2")]]]),
    ),
  );
});

describe("recent archive project filter", () => {
  const environmentId = EnvironmentId.make("env-a");
  const inScope = ProjectId.make("project-in");
  const outOfScope = ProjectId.make("project-out");
  const thread = (id: string, projectId: ProjectId) =>
    ({ id, projectId, archivedAt: "2026-01-01T00:00:00.000Z" }) as never;
  const fullArchive = {
    threads: [thread("kept", inScope), thread("dropped", outOfScope)],
  } as unknown as OrchestrationShellSnapshot;
  const recentCalls: Array<ReadonlyArray<ProjectId> | undefined> = [];
  const makeFamily = (capabilities: { recent: boolean; projectFilter: boolean }) =>
    createRecentArchivedThreadSnapshotsAtomFamily<never>({
      supportsRecentAtom: () => Atom.make(capabilities.recent),
      supportsRecentProjectFilterAtom: () => Atom.make(capabilities.projectFilter),
      getRecentAtom: (_environmentId, _limit, projectIds) => {
        recentCalls.push(projectIds);
        return Atom.make(
          AsyncResult.success<OrchestrationGetRecentArchivedThreadsResult, never>({
            snapshotSequence: 1,
            threads: [thread("server-filtered", inScope)],
            totalArchivedCount: 1,
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        );
      },
      getFallbackAtom: () =>
        Atom.make(AsyncResult.success<OrchestrationShellSnapshot, never>(fullArchive)),
      getInvalidationSequenceAtom: () => Atom.make(0),
      labelPrefix: "test:recent-archived",
    });
  const filteredKey = makeRecentArchivedThreadsKey(
    [environmentId],
    3,
    new Map([[environmentId, [inScope]]]),
  );

  it("sends the filter to a server that honors it", () => {
    recentCalls.length = 0;
    const registry = AtomRegistry.make();
    const state = registry.get(makeFamily({ recent: true, projectFilter: true })(filteredKey));
    expect(recentCalls).toEqual([[inScope]]);
    expect(state.snapshots.map((snapshot) => snapshot.threads.map((t) => t.id))).toEqual([
      ["server-filtered"],
    ]);
    registry.dispose();
  });

  it.each([
    { recent: true, projectFilter: false },
    { recent: false, projectFilter: false },
  ])("filters the full archive locally when the server cannot (%o)", (capabilities) => {
    recentCalls.length = 0;
    const registry = AtomRegistry.make();
    const state = registry.get(makeFamily(capabilities)(filteredKey));
    expect(recentCalls).toEqual([]);
    expect(state.snapshots).toEqual([
      { environmentId, threads: [thread("kept", inScope)], totalArchivedCount: 1 },
    ]);
    registry.dispose();
  });

  it("keeps the unfiltered recent query when no filter is set", () => {
    recentCalls.length = 0;
    const registry = AtomRegistry.make();
    registry.get(
      makeFamily({ recent: true, projectFilter: false })(
        makeRecentArchivedThreadsKey([environmentId], 3),
      ),
    );
    expect(recentCalls).toEqual([undefined]);
    registry.dispose();
  });
});
