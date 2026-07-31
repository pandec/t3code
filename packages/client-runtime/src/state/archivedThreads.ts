import { EnvironmentId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

export interface ArchivedSnapshotEntry {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationShellSnapshot;
}

export interface ArchivedThreadSnapshotsState {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
}

export interface RecentArchivedThread {
  readonly environmentId: EnvironmentId;
  readonly thread: OrchestrationShellSnapshot["threads"][number];
}

const ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR = "\u001f";
const environmentIdOrder = Order.String as Order.Order<EnvironmentId>;

export function makeArchivedThreadsEnvironmentKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
): string {
  return pipe(environmentIds, Arr.sort(environmentIdOrder), (sortedEnvironmentIds) =>
    sortedEnvironmentIds.join(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
  );
}

export function parseArchivedThreadsEnvironmentKey(key: string): ReadonlyArray<EnvironmentId> {
  if (key.length === 0) {
    return [];
  }
  return pipe(
    key.split(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
    Arr.map((environmentId) => EnvironmentId.make(environmentId)),
  );
}

export function createArchivedThreadSnapshotsAtomFamily<E>(options: {
  readonly getSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationShellSnapshot, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((environmentKey: string) =>
    Atom.make((get): ArchivedThreadSnapshotsState => {
      const snapshots: ArchivedSnapshotEntry[] = [];
      let error: string | null = null;
      let isLoading = false;

      for (const environmentId of parseArchivedThreadsEnvironmentKey(environmentKey)) {
        const result = get(options.getSnapshotAtom(environmentId));
        isLoading ||= result.waiting;

        const snapshot = Option.getOrNull(AsyncResult.value(result));
        if (snapshot !== null) {
          snapshots.push({ environmentId, snapshot });
        }

        if (error === null && result._tag === "Failure") {
          error = "Failed to load archived threads.";
        }
      }

      return { snapshots, error, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${environmentKey}`)),
  );
}

function archivedTimestamp(thread: OrchestrationShellSnapshot["threads"][number]): number {
  const value = Date.parse(thread.archivedAt ?? thread.updatedAt ?? thread.createdAt);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

export function selectRecentArchivedThreads(
  snapshots: ReadonlyArray<ArchivedSnapshotEntry>,
  visibleCount: number,
): {
  readonly threads: ReadonlyArray<RecentArchivedThread>;
  readonly totalCount: number;
} {
  const threads = snapshots.flatMap(({ environmentId, snapshot }) =>
    snapshot.threads
      .filter((thread) => thread.archivedAt !== null)
      .map((thread) => ({ environmentId, thread })),
  );
  threads.sort(
    (left, right) =>
      archivedTimestamp(right.thread) - archivedTimestamp(left.thread) ||
      String(right.thread.id).localeCompare(String(left.thread.id)),
  );
  return {
    threads: threads.slice(0, Math.max(0, visibleCount)),
    totalCount: threads.length,
  };
}
