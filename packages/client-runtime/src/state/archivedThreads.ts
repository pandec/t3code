import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  type OrchestrationV2ArchivedShellSnapshot,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import { presentThreadShell, type EnvironmentThreadShell } from "./models.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentShellState } from "./shell.ts";

export interface ArchivedSnapshotEntry {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationV2ArchivedShellSnapshot;
}

export interface ArchivedThreadSnapshotsState {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
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

export function createArchivedThreadSnapshotsAtomFamily<E>(options: {
  readonly getSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, E>>;
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

// Fork: the recent-archive shelf (web sidebar, mobile home and split sidebar).

export interface RecentArchivedSnapshotEntry {
  readonly environmentId: EnvironmentId;
  /** Newest archive first, already presented for list rows. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly totalArchivedCount: number;
}

export interface RecentArchivedThreadSnapshotsState {
  readonly snapshots: ReadonlyArray<RecentArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
}

/** What an environment's server offers, from its advertised capabilities. */
export interface RecentArchivedThreadsSupport {
  readonly recent: boolean;
  readonly projectFilter: boolean;
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

function presentArchived(
  environmentId: EnvironmentId,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads.flatMap((thread) =>
    thread.archivedAt === null || thread.lineage.relationshipToParent === "subagent"
      ? []
      : [presentThreadShell(environmentId, thread)],
  );
}

/**
 * The shelf's per-environment windows. Each environment runs the bounded
 * `getRecentArchivedThreads` query, refetched whenever its shell stream
 * reports an archive-membership change (`archiveInvalidationSequence`).
 * Servers without the query fall back to the full archive snapshot for an
 * unfiltered shelf; a filtered shelf never pages the unbounded archive, so
 * an empty filter or a server without filter support contributes nothing.
 */
export function createRecentArchivedThreadsAtoms<R, E, FE>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly labelPrefix: string;
    readonly shellStateValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<EnvironmentShellState>;
    readonly serverConfigsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>;
    readonly getFallbackAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, FE>>;
  },
) {
  const invalidationAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) => get(options.shellStateValueAtom(environmentId)).archiveInvalidationSequence ?? 0,
    ).pipe(Atom.withLabel(`${options.labelPrefix}:invalidation:${environmentId}`)),
  );
  const supportAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): RecentArchivedThreadsSupport => {
      const capabilities = get(options.serverConfigsAtom).get(environmentId)?.environment
        .capabilities;
      return {
        recent: capabilities?.recentArchivedThreads === true,
        projectFilter: capabilities?.recentArchivedThreadsProjectFilter === true,
      };
    }),
  );
  const recentQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: `${options.labelPrefix}:query`,
    tag: ORCHESTRATION_V2_WS_METHODS.getRecentArchivedThreads,
    staleTimeMs: 30_000,
    refreshIntervalMs: 60_000,
    refreshTrigger: ({ environmentId }) => invalidationAtom(environmentId),
  });
  const recentAtom = (
    environmentId: EnvironmentId,
    limit: number,
    projectIds?: ReadonlyArray<ProjectId>,
  ) =>
    recentQuery({
      environmentId,
      // The family keys on the serialized input, so keep the list sorted.
      input: {
        limit,
        ...(projectIds === undefined ? {} : { projectIds: [...projectIds].sort() }),
      },
    });
  const fallbackAtom = Atom.family((environmentId: EnvironmentId) =>
    options
      .getFallbackAtom(environmentId)
      .pipe(Atom.makeRefreshOnSignal(invalidationAtom(environmentId))),
  );

  const snapshotsAtom = Atom.family((key: string) => {
    const { targets, visibleCount } = parseRecentArchivedThreadsKey(key);
    return Atom.make((get): RecentArchivedThreadSnapshotsState => {
      const snapshots: RecentArchivedSnapshotEntry[] = [];
      let error: string | null = null;
      let isLoading = false;
      const read = <A, X>(
        environmentId: EnvironmentId,
        result: AsyncResult.AsyncResult<A, X>,
        toEntry: (value: A) => Omit<RecentArchivedSnapshotEntry, "environmentId">,
      ) => {
        isLoading ||= result.waiting;
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) snapshots.push({ environmentId, ...toEntry(value) });
        if (error === null && result._tag === "Failure") {
          error = "Failed to load recent archived threads.";
        }
      };

      for (const { environmentId, projectIds } of targets) {
        const support = get(supportAtom(environmentId));
        if (
          projectIds !== undefined &&
          (projectIds.length === 0 || !support.recent || !support.projectFilter)
        ) {
          snapshots.push({ environmentId, threads: [], totalArchivedCount: 0 });
          continue;
        }
        if (support.recent) {
          read(
            environmentId,
            get(recentAtom(environmentId, visibleCount, projectIds)),
            (value) => ({
              threads: presentArchived(environmentId, value.threads),
              totalArchivedCount: value.totalArchivedCount,
            }),
          );
        } else {
          read(environmentId, get(fallbackAtom(environmentId)), (value) => {
            const threads = presentArchived(environmentId, value.threads);
            return { threads, totalArchivedCount: threads.length };
          });
        }
      }

      return { snapshots, error, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${key}`));
  });

  return { snapshotsAtom, recentAtom };
}

function archivedTimestamp(thread: EnvironmentThreadShell): number {
  const value = Date.parse(thread.archivedAt ?? thread.updatedAt ?? thread.createdAt);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

/**
 * The newest archived threads across every environment. `totalCount` is the
 * unclipped total, which is what the shelf header reports.
 *
 * `selectedThreadKey` names the open thread; when it is archived but falls
 * beyond the clip, its row is appended anyway so navigation never loses the
 * thread being read. This only reaches as far as the snapshots do: each
 * environment's window is server-limited, so a selected thread outside it
 * stays absent.
 */
export function selectRecentArchivedThreads(
  snapshots: ReadonlyArray<RecentArchivedSnapshotEntry>,
  visibleCount: number,
  selectedThreadKey: string | null = null,
): {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly totalCount: number;
} {
  const threads = snapshots
    .flatMap((snapshot) => snapshot.threads)
    .sort(
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
