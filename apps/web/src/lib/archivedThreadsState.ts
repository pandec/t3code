import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  createRecentArchivedThreadsAtoms,
  makeArchivedThreadsEnvironmentKey,
  makeRecentArchivedThreadsKey,
  type RecentArchivedThreadSnapshotsState,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
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

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

// Fork (SP Labs): the full archive, refetched whenever the shell reports an archive change, so a
// lab owner archived by an agent or another client resolves without a manual refresh.
const archiveInvalidationAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(environmentShell.stateValueAtom(environmentId)).archiveInvalidationSequence ?? 0,
  ),
);

export const liveArchivedShellSnapshotAtom = Atom.family((environmentId: EnvironmentId) =>
  archivedSnapshotAtom(environmentId).pipe(
    Atom.makeRefreshOnSignal(archiveInvalidationAtom(environmentId)),
  ),
);

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

// Fork: the sidebar's recent-archive shelf, refetched on shell archive changes.
const recentArchivedThreads = createRecentArchivedThreadsAtoms(connectionAtomRuntime, {
  labelPrefix: "web:recent-archived-threads",
  shellStateValueAtom: environmentShell.stateValueAtom,
  serverConfigsAtom: environmentServerConfigsAtom,
  getFallbackAtom: archivedSnapshotAtom,
});

export function useRecentArchivedThreadSnapshots(
  environmentIds: ReadonlyArray<EnvironmentId>,
  visibleCount: number,
  projectIdsByEnvironment?: ReadonlyMap<EnvironmentId, ReadonlyArray<ProjectId>>,
): RecentArchivedThreadSnapshotsState {
  const key = useMemo(
    () => makeRecentArchivedThreadsKey(environmentIds, visibleCount, projectIdsByEnvironment),
    [environmentIds, projectIdsByEnvironment, visibleCount],
  );
  return useAtomValue(recentArchivedThreads.snapshotsAtom(key));
}
