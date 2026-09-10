import {
  EnvironmentId,
  ProjectId,
  type OrchestrationGetRecentArchivedThreadsResult,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import { scopeThreadShell, type EnvironmentThreadShell } from "./models.ts";

export interface ArchivedSnapshotEntry {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationShellSnapshot;
}

export interface ArchivedThreadSnapshotsState {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
}

export interface RecentArchivedSnapshotEntry {
  readonly environmentId: EnvironmentId;
  readonly threads: OrchestrationShellSnapshot["threads"];
  readonly totalArchivedCount: number;
}

export interface RecentArchivedThreadSnapshotsState {
  readonly snapshots: ReadonlyArray<RecentArchivedSnapshotEntry>;
  readonly invalidationSequences: ReadonlyMap<EnvironmentId, number>;
  readonly error: string | null;
  readonly isLoading: boolean;
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

export interface RecentArchivedThreadsTarget {
  readonly environmentId: EnvironmentId;
  /** Projects the shelf may show for this environment; absent means all of
      them. Mirrors the client's project filter so the server-side window and
      total count agree with the rest of the list. */
  readonly projectIds?: ReadonlyArray<ProjectId>;
}

export function makeRecentArchivedThreadsKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
  visibleCount: number,
  projectIdsByEnvironment?: ReadonlyMap<EnvironmentId, ReadonlyArray<ProjectId>>,
): string {
  return JSON.stringify({
    targets: pipe(
      environmentIds,
      Arr.sort(environmentIdOrder),
      Arr.map((environmentId) => {
        const projectIds = projectIdsByEnvironment?.get(environmentId);
        return projectIds === undefined
          ? [environmentId]
          : [environmentId, pipe(projectIds, Arr.sort(Order.String))];
      }),
    ),
    visibleCount,
  });
}

export function parseRecentArchivedThreadsKey(key: string): {
  readonly targets: ReadonlyArray<RecentArchivedThreadsTarget>;
  readonly visibleCount: number;
} {
  const parsed = JSON.parse(key) as {
    readonly targets: ReadonlyArray<readonly [string, ReadonlyArray<string>?]>;
    readonly visibleCount: number;
  };
  return {
    targets: parsed.targets.map(([environmentId, projectIds]) => ({
      environmentId: EnvironmentId.make(environmentId),
      ...(projectIds === undefined
        ? {}
        : { projectIds: projectIds.map((projectId) => ProjectId.make(projectId)) }),
    })),
    visibleCount: parsed.visibleCount,
  };
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

export function createRecentArchivedThreadSnapshotsAtomFamily<E>(options: {
  readonly supportsRecentAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
  readonly supportsRecentProjectFilterAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
  readonly getRecentAtom: (
    environmentId: EnvironmentId,
    limit: number,
    projectIds?: ReadonlyArray<ProjectId>,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationGetRecentArchivedThreadsResult, E>>;
  readonly getFallbackAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationShellSnapshot, E>>;
  readonly getInvalidationSequenceAtom: (environmentId: EnvironmentId) => Atom.Atom<number>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) => {
    const { targets, visibleCount } = parseRecentArchivedThreadsKey(key);
    return Atom.make((get): RecentArchivedThreadSnapshotsState => {
      const snapshots: RecentArchivedSnapshotEntry[] = [];
      const invalidationSequences = new Map<EnvironmentId, number>();
      let error: string | null = null;
      let isLoading = false;

      for (const { environmentId, projectIds } of targets) {
        invalidationSequences.set(
          environmentId,
          get(options.getInvalidationSequenceAtom(environmentId)),
        );
        const supportsRecent =
          get(options.supportsRecentAtom(environmentId)) &&
          (projectIds === undefined || get(options.supportsRecentProjectFilterAtom(environmentId)));
        if (supportsRecent) {
          const result = get(options.getRecentAtom(environmentId, visibleCount, projectIds));
          isLoading ||= result.waiting;
          const value = Option.getOrNull(AsyncResult.value(result));
          if (value !== null) {
            snapshots.push({
              environmentId,
              threads: value.threads,
              totalArchivedCount: value.totalArchivedCount,
            });
          }
          if (error === null && result._tag === "Failure") {
            error = "Failed to load recent archived threads.";
          }
        } else {
          // The fallback snapshot is the whole archive (also the route for
          // servers that can't filter), so the project filter applies here.
          const result = get(options.getFallbackAtom(environmentId));
          isLoading ||= result.waiting;
          const value = Option.getOrNull(AsyncResult.value(result));
          if (value !== null) {
            const threads =
              projectIds === undefined
                ? value.threads
                : value.threads.filter((thread) => projectIds.includes(thread.projectId));
            snapshots.push({
              environmentId,
              threads,
              totalArchivedCount: threads.length,
            });
          }
          if (error === null && result._tag === "Failure") {
            error = "Failed to load recent archived threads.";
          }
        }
      }

      return { snapshots, invalidationSequences, error, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${key}`));
  });
}

function archivedTimestamp(thread: OrchestrationShellSnapshot["threads"][number]): number {
  const value = Date.parse(thread.archivedAt ?? thread.updatedAt ?? thread.createdAt);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

/**
 * The newest archived threads across every environment, already scoped so
 * callers can render them like any other thread shell. `totalCount` is the
 * unclipped total, which is what the section header reports.
 *
 * `selectedThreadKey` names the open thread; when it is archived but falls
 * beyond the clip, its row is appended anyway so navigation never loses the
 * thread being read — the same pull the settled tail does. This only reaches
 * as far as the snapshots do: an environment's recent-archived query is
 * server-limited, so a selected thread outside that window stays absent.
 */
export function selectRecentArchivedThreads(
  snapshots: ReadonlyArray<RecentArchivedSnapshotEntry>,
  visibleCount: number,
  selectedThreadKey: string | null = null,
): {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly totalCount: number;
} {
  const threads = snapshots.flatMap(({ environmentId, threads }) =>
    threads
      .filter((thread) => thread.archivedAt !== null)
      .map((thread) => scopeThreadShell(environmentId, thread)),
  );
  threads.sort(
    (left, right) =>
      archivedTimestamp(right) - archivedTimestamp(left) || right.id.localeCompare(left.id),
  );
  const clipCount = Math.max(0, visibleCount);
  const visible = threads.slice(0, clipCount);
  if (selectedThreadKey !== null) {
    const selected = threads
      .slice(clipCount)
      .find(
        (thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === selectedThreadKey,
      );
    if (selected !== undefined) visible.push(selected);
  }
  return {
    threads: visible,
    totalCount: snapshots.reduce((total, snapshot) => total + snapshot.totalArchivedCount, 0),
  };
}
