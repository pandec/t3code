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

import { connectionAtomRuntime } from "../connection/runtime";
import { orchestrationEnvironment } from "../state/orchestration";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells } from "../state/threads";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { environmentShell } from "../state/shell";

// Fork: SP Labs owner lookups share this full-archive query with Settings.
export function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  hiddenThreadTagsAtom: serverEnvironment.hiddenThreadTagsAtom,
  hiddenThreadKeysAtom: environmentThreadShells.hiddenThreadKeysAtom,
  liveThreadRefsAtom: environmentThreadShells.threadRefsAtom,
  anyEnvironmentHidingAtom: environmentThreadShells.anyEnvironmentHidingAtom,
  labelPrefix: "web:archived-thread-snapshots",
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
  const environmentKey = makeArchivedThreadsEnvironmentKey(environmentIds);
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = () => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  };

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
  hiddenThreadTagsAtom: serverEnvironment.hiddenThreadTagsAtom,
  hiddenThreadKeysAtom: environmentThreadShells.hiddenThreadKeysAtom,
  liveThreadRefsAtom: environmentThreadShells.threadRefsAtom,
  anyEnvironmentHidingAtom: environmentThreadShells.anyEnvironmentHidingAtom,
});

export function useRecentArchivedThreadSnapshots(
  environmentIds: ReadonlyArray<EnvironmentId>,
  visibleCount: number,
  projectIdsByEnvironment?: ReadonlyMap<EnvironmentId, ReadonlyArray<ProjectId>>,
): RecentArchivedThreadSnapshotsState {
  const key = makeRecentArchivedThreadsKey(environmentIds, visibleCount, projectIdsByEnvironment);
  return useAtomValue(recentArchivedThreads.snapshotsAtom(key));
}
