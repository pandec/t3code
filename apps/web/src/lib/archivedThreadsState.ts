import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  createRecentArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  makeRecentArchivedThreadsKey,
  type RecentArchivedSnapshotEntry,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
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

function recentArchivedThreadsAtom(
  environmentId: EnvironmentId,
  limit: number,
  projectIds?: ReadonlyArray<ProjectId>,
) {
  return orchestrationEnvironment.recentArchivedThreads({
    environmentId,
    input: { limit, ...(projectIds === undefined ? {} : { projectIds }) },
  });
}

const supportsRecentArchivedThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
        .recentArchivedThreads === true,
  ),
);
const supportsRecentArchivedThreadsProjectFilterAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
        .recentArchivedThreadsProjectFilter === true,
  ),
);
const archiveInvalidationSequenceAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(environmentShell.stateValueAtom(environmentId)).archiveInvalidationSequence,
  ),
);
const recentArchivedSnapshotsAtom = createRecentArchivedThreadSnapshotsAtomFamily({
  supportsRecentAtom: supportsRecentArchivedThreadsAtom,
  supportsRecentProjectFilterAtom: supportsRecentArchivedThreadsProjectFilterAtom,
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
  projectIdsByEnvironment?: ReadonlyMap<EnvironmentId, ReadonlyArray<ProjectId>>,
): {
  readonly snapshots: ReadonlyArray<RecentArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
} {
  const key = useMemo(
    () => makeRecentArchivedThreadsKey(environmentIds, visibleCount, projectIdsByEnvironment),
    [environmentIds, projectIdsByEnvironment, visibleCount],
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
      const capabilities = serverConfigs.get(environmentId)?.environment.capabilities;
      const projectIds = projectIdsByEnvironment?.get(environmentId);
      if (
        capabilities?.recentArchivedThreads === true &&
        (projectIds === undefined || capabilities.recentArchivedThreadsProjectFilter === true)
      ) {
        appAtomRegistry.refresh(recentArchivedThreadsAtom(environmentId, visibleCount, projectIds));
      } else {
        appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
      }
    }
  }, [projectIdsByEnvironment, result.invalidationSequences, visibleCount]);

  return { snapshots: result.snapshots, error: result.error, isLoading: result.isLoading };
}
