import { useEffect, useState } from "react";
import * as Schema from "effect/Schema";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { useLocalStorage } from "../../hooks/useLocalStorage";

import type { SidebarThreadSummary } from "../../types";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  type SidebarThreadStatus,
} from "../Sidebar.logic";

const ACTIVE_WORK_STATUSES: ReadonlySet<SidebarThreadStatus> = new Set([
  "working",
  "monitoring",
  "waiting",
  "approval",
  "input",
  "request",
]);

/** Fork: the Active filter keeps threads the user marked plus threads that are
    running or need the user right now. */
export function isSidebarActiveWorkThread(
  thread: Parameters<typeof resolveSidebarThreadStatus>[0] &
    Pick<SidebarThreadSummary, "activeMarkedAt">,
): boolean {
  return (
    thread.activeMarkedAt != null || ACTIVE_WORK_STATUSES.has(resolveSidebarThreadStatus(thread))
  );
}

function isEligible(thread: SidebarThreadSummary, now: string): boolean {
  return (
    thread.archivedAt === null &&
    thread.settledOverride !== "settled" &&
    !effectiveSnoozed(thread, { now })
  );
}

export function nextActiveWorkThreadKeys(
  previous: readonly string[],
  enabled: boolean,
  threads: readonly SidebarThreadSummary[],
  now: string,
  liveEnvironmentIds: ReadonlySet<EnvironmentId>,
): readonly string[] {
  if (!enabled) return previous.length === 0 ? previous : [];
  // Live snapshots omit archived/deleted threads; missing offline shells prove no removal.
  const present = new Set(
    threads.map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  const next = new Set(
    previous.filter((key) => {
      const ref = parseScopedThreadKey(key);
      return ref !== null && (!liveEnvironmentIds.has(ref.environmentId) || present.has(key));
    }),
  );
  for (const thread of threads) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (!isEligible(thread, now)) next.delete(key);
    else if (isSidebarActiveWorkThread(thread)) next.add(key);
  }
  return next.size === previous.length && previous.every((key) => next.has(key))
    ? previous
    : [...next];
}

export function matchesSidebarActiveWorkFilter(
  thread: SidebarThreadSummary,
  options: {
    readonly retainedKeys: ReadonlySet<string>;
    readonly includeDone: boolean;
    readonly routeThreadKey: string | null;
    readonly now: string;
    readonly localLastVisitedAt?: string | undefined;
  },
): boolean {
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  if (key === options.routeThreadKey) return true;
  if (!isEligible(thread, options.now)) return false;
  return (
    options.retainedKeys.has(key) ||
    isSidebarActiveWorkThread(thread) ||
    (options.includeDone &&
      resolveSidebarThreadStatus(thread) === "ready" &&
      hasUnseenCompletion({
        ...thread,
        lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, options.localLastVisitedAt),
      }))
  );
}

const RETAINED_KEYS_SCHEMA = Schema.Array(Schema.String);
const NO_RETAINED_KEYS: readonly string[] = [];

export function useActiveWorkThreadKeys(
  enabled: boolean,
  threads: readonly SidebarThreadSummary[],
  now: string,
  liveEnvironmentIds: ReadonlySet<EnvironmentId>,
): ReadonlySet<string> {
  const [stored, setStored] = useLocalStorage(
    "t3code:sidebar:active-work-thread-keys",
    NO_RETAINED_KEYS,
    RETAINED_KEYS_SCHEMA,
  );
  const next = nextActiveWorkThreadKeys(stored, enabled, threads, now, liveEnvironmentIds);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Persist filter membership across sidebar remounts and reloads.
  useEffect(() => {
    if (next !== stored) {
      setStored((previous) =>
        nextActiveWorkThreadKeys(previous, enabled, threads, now, liveEnvironmentIds),
      );
    }
  }, [enabled, liveEnvironmentIds, next, now, setStored, stored, threads]);
  return new Set(next);
}

export type SidebarShelfKey = "pinned" | "active" | "working" | "snoozed" | "settled";

interface ActiveWorkFoldState {
  readonly enabled: boolean;
  readonly shelves: ReadonlySet<SidebarShelfKey>;
  readonly groups: ReadonlySet<string>;
}

function toggled<T>(set: ReadonlySet<T>, key: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}

function without<T>(set: ReadonlySet<T>, key: T): ReadonlySet<T> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

const NO_FOLDS = new Set<never>();

/** Fork: while the Active filter is on, every section opens and folds live in
    memory only, so turning the filter off restores the remembered folds. */
export function useActiveWorkFolds(enabled: boolean) {
  const [state, setState] = useState<ActiveWorkFoldState>({
    enabled,
    shelves: NO_FOLDS,
    groups: NO_FOLDS,
  });
  const current =
    state.enabled === enabled ? state : { enabled, shelves: NO_FOLDS, groups: NO_FOLDS };
  if (current !== state) setState(current);
  return {
    folds: current,
    toggleShelf: (key: SidebarShelfKey) =>
      setState((value) => ({ ...value, shelves: toggled(value.shelves, key) })),
    expandShelf: (key: SidebarShelfKey) =>
      setState((value) => ({ ...value, shelves: without(value.shelves, key) })),
    toggleGroup: (id: string) =>
      setState((value) => ({ ...value, groups: toggled(value.groups, id) })),
    expandGroup: (id: string) =>
      setState((value) => ({ ...value, groups: without(value.groups, id) })),
  };
}
