import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  createRecentArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  makeRecentArchivedThreadsKey,
  type RecentArchivedSnapshotEntry,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { environmentShell } from "../state/shell";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

function recentArchivedThreadsAtom(environmentId: EnvironmentId, limit: number) {
  return orchestrationEnvironment.recentArchivedThreads({
    environmentId,
    input: { limit },
  });
}

const supportsRecentArchivedThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
        .recentArchivedThreads === true,
  ),
);
const archiveInvalidationSequenceAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(environmentShell.stateValueAtom(environmentId)).archiveInvalidationSequence,
  ),
);
const recentArchivedSnapshotsAtom = createRecentArchivedThreadSnapshotsAtomFamily({
  supportsRecentAtom: supportsRecentArchivedThreadsAtom,
  getRecentAtom: recentArchivedThreadsAtom,
  getFallbackAtom: archivedSnapshotAtom,
  getInvalidationSequenceAtom: archiveInvalidationSequenceAtom,
  labelPrefix: "web:recent-archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  }, [environmentIds]);

  return {
    ...result,
    refresh,
  };
}

export function useRecentArchivedThreadSnapshots(
  environmentIds: ReadonlyArray<EnvironmentId>,
  visibleCount: number,
): {
  readonly snapshots: ReadonlyArray<RecentArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
} {
  const key = useMemo(
    () => makeRecentArchivedThreadsKey(environmentIds, visibleCount),
    [environmentIds, visibleCount],
  );
  const result = useAtomValue(recentArchivedSnapshotsAtom(key));
  const previousInvalidationSequences = useRef<ReadonlyMap<EnvironmentId, number> | null>(null);

  useEffect(() => {
    const previous = previousInvalidationSequences.current;
    previousInvalidationSequences.current = result.invalidationSequences;
    if (previous === null) return;
    const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    for (const [environmentId, sequence] of result.invalidationSequences) {
      if (previous.get(environmentId) === sequence) continue;
      if (
        serverConfigs.get(environmentId)?.environment.capabilities.recentArchivedThreads === true
      ) {
        appAtomRegistry.refresh(recentArchivedThreadsAtom(environmentId, visibleCount));
      } else {
        appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
      }
    }
  }, [result.invalidationSequences, visibleCount]);

  return { snapshots: result.snapshots, error: result.error, isLoading: result.isLoading };
}
