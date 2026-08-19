import { EnvironmentId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
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
