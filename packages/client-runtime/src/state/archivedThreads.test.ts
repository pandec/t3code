import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ArchivedShellSnapshot,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import {
  createArchivedThreadSnapshotsAtomFamily,
  createRecentArchivedThreadsAtoms,
  makeArchivedThreadsEnvironmentKey,
  makeRecentArchivedThreadsKey,
  parseArchivedThreadsEnvironmentKey,
  parseRecentArchivedThreadsKey,
  type RecentArchivedSnapshotEntry,
  selectRecentArchivedThreads,
} from "./archivedThreads.ts";
import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

it("round-trips environment keys in sorted order", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const key = makeArchivedThreadsEnvironmentKey([envB, envA]);

  expect(parseArchivedThreadsEnvironmentKey(key)).toEqual([envA, envB]);
});

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationV2ArchivedShellSnapshot, Error>(
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

describe("recent archive shelf", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const archived = (
    id: string,
    minute: number,
    extra: Partial<OrchestrationV2ThreadShell> = {},
  ) => ({
    ...v2ThreadShell,
    id: ThreadId.make(id),
    archivedAt: DateTime.makeUnsafe(Date.UTC(2026, 5, 20, 0, minute)),
    ...extra,
  });
  const entry = (
    environmentId: EnvironmentId,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
    totalArchivedCount: number,
  ): RecentArchivedSnapshotEntry => ({
    environmentId,
    threads: threads.map((thread) => presentThreadShell(environmentId, thread)),
    totalArchivedCount,
  });

  it("merges environments newest first, clips, and keeps the open thread's row", () => {
    const snapshots = [
      entry(envA, [archived("a-new", 9), archived("a-old", 1)], 7),
      entry(envB, [archived("b-mid", 5)], 3),
    ];

    const clipped = selectRecentArchivedThreads(snapshots, 2);
    expect(clipped.threads.map((thread) => thread.id)).toEqual(["a-new", "b-mid"]);
    expect(clipped.totalCount).toBe(10);

    const withSelected = selectRecentArchivedThreads(
      snapshots,
      2,
      scopedThreadKey(scopeThreadRef(envA, ThreadId.make("a-old"))),
    );
    expect(withSelected.threads.map((thread) => thread.id)).toEqual(["a-new", "b-mid", "a-old"]);
  });

  it("keys targets in a stable order", () => {
    const projectA = ProjectId.make("project-a");
    const projectB = ProjectId.make("project-b");
    const key = makeRecentArchivedThreadsKey(
      [envB, envA],
      5,
      new Map([[envB, [projectB, projectA]]]),
    );

    expect(parseRecentArchivedThreadsKey(key)).toEqual({
      targets: [{ environmentId: envA }, { environmentId: envB, projectIds: [projectA, projectB] }],
      visibleCount: 5,
    });
  });

  it("never pages the full archive for a filtered shelf, and drops subagents from the fallback", () => {
    const fallbackReads: EnvironmentId[] = [];
    const runtime = Atom.runtime(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        {} as EnvironmentRegistry.EnvironmentRegistry["Service"],
      ),
    );
    const atoms = createRecentArchivedThreadsAtoms(runtime, {
      labelPrefix: "test:recent-archive",
      shellStateValueAtom: () =>
        Atom.make({ snapshot: Option.none(), status: "empty" as const, error: Option.none() }),
      // Neither environment's server advertises the bounded query.
      serverConfigsAtom: Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(new Map()),
      getFallbackAtom: (environmentId) =>
        Atom.make(() => {
          fallbackReads.push(environmentId);
          return AsyncResult.success<OrchestrationV2ArchivedShellSnapshot, never>({
            schemaVersion: 2,
            snapshotSequence: 1,
            projects: [],
            threads: [
              archived("root", 2),
              archived("child", 3, {
                lineage: {
                  rootThreadId: ThreadId.make("root"),
                  parentThreadId: ThreadId.make("root"),
                  relationshipToParent: "subagent",
                },
              }),
            ],
          });
        }),
    });
    const registry = AtomRegistry.make();

    const state = registry.get(
      atoms.snapshotsAtom(
        makeRecentArchivedThreadsKey([envA, envB], 5, new Map([[envB, [ProjectId.make("p")]]])),
      ),
    );
    expect(fallbackReads).toEqual([envA]);
    expect(
      state.snapshots.map((snapshot) => [
        snapshot.environmentId,
        snapshot.threads.map((thread) => thread.id),
        snapshot.totalArchivedCount,
      ]),
    ).toEqual([
      [envA, ["root"], 1],
      [envB, [], 0],
    ]);

    registry.dispose();
  });
});
