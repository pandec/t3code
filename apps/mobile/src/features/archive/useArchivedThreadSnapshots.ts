import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  createRecentArchivedThreadsAtoms,
  makeArchivedThreadsEnvironmentKey,
  makeRecentArchivedThreadsKey,
  type RecentArchivedThreadSnapshotsState,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import { useThreadLifecycleIntents } from "../../state/thread-lifecycle-outbox";
import {
  deriveThreadLifecyclePresentation,
  type ThreadLifecyclePresentation,
} from "../../state/thread-lifecycle-outbox-model";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
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
  labelPrefix: "mobile:archived-thread-snapshots",
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
  const refresh = () => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  };

  return { ...result, refresh };
}

// Fork: the home list and split sidebar's recent-archive shelf, refetched on
// shell archive changes.
const recentArchivedThreads = createRecentArchivedThreadsAtoms(connectionAtomRuntime, {
  labelPrefix: "mobile:recent-archived-threads",
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
): RecentArchivedThreadSnapshotsState {
  const key = useMemo(
    () => makeRecentArchivedThreadsKey(environmentIds, visibleCount),
    [environmentIds, visibleCount],
  );
  return useAtomValue(recentArchivedThreads.snapshotsAtom(key));
}

/** Canonical unarchived shells with pending archive/unarchive intents applied. */
export function useThreadLifecyclePresentation(
  canonicalThreads: ReadonlyArray<EnvironmentThreadShell>,
): ThreadLifecyclePresentation {
  const intents = useThreadLifecycleIntents();
  const hiddenKeys = useAtomValue(environmentThreadShells.hiddenThreadKeysAtom);
  const hidingAnywhere = useAtomValue(environmentThreadShells.anyEnvironmentHidingAtom);
  const liveRefs = useAtomValue(environmentThreadShells.threadRefsAtom);
  return useMemo(() => {
    if (!hidingAnywhere && hiddenKeys.size === 0)
      return deriveThreadLifecyclePresentation(canonicalThreads, intents);
    const loadedKeys = new Set(liveRefs.map(threadKey));
    const visibleIntents = Object.fromEntries(
      Object.entries(intents).filter(([, intent]) => {
        const key = threadKey(intent);
        return !hiddenKeys.has(key) && (!hidingAnywhere || loadedKeys.has(key));
      }),
    );
    return deriveThreadLifecyclePresentation(canonicalThreads, visibleIntents);
  }, [canonicalThreads, intents, hiddenKeys, hidingAnywhere, liveRefs]);
}
