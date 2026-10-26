import { useState } from "react";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";

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
