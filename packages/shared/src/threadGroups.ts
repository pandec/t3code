import * as Effect from "effect/Effect";
import type { ThreadGroup } from "@t3tools/contracts";

/** Merge per group so edits on disconnected servers preserve unrelated groups.
 * Deleted entries remain in the catalog to prevent resurrection on reconnect. */
export function mergeThreadGroups(
  ...catalogs: ReadonlyArray<ReadonlyArray<ThreadGroup>>
): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();
  for (const catalog of catalogs) {
    for (const group of catalog) {
      const previous = groups.get(group.id);
      if (
        !previous ||
        group.revision > previous.revision ||
        (group.revision === previous.revision && JSON.stringify(group) > JSON.stringify(previous))
      ) {
        groups.set(group.id, group);
      }
    }
  }
  return [...groups.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function visibleThreadGroups(catalog: ReadonlyArray<ThreadGroup>): ThreadGroup[] {
  return catalog
    .filter((group) => !group.deleted)
    .sort(
      (a, b) =>
        Number(b.aboveActive === true) - Number(a.aboveActive === true) ||
        (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1),
    );
}

/** Insert Active into the visible, sorted catalog for every client's list and editor. */
export function threadGroupSections(groups: readonly ThreadGroup[]): Array<ThreadGroup | null> {
  return [
    ...groups.filter((group) => group.aboveActive === true),
    null,
    ...groups.filter((group) => group.aboveActive !== true),
  ];
}

export function nextThreadGroupRevision(
  catalog: ReadonlyArray<ThreadGroup>,
  now: number,
  editId: string,
): string {
  const latest = catalog.reduce(
    (max, group) => Math.max(max, Number(group.revision.split(":")[0]) || 0),
    0,
  );
  return `${String(Math.max(now, latest + 1)).padStart(16, "0")}:${editId}`;
}

export function threadGroupId(
  thread: { readonly customGroupId?: string | null | undefined },
  groups: ReadonlyArray<ThreadGroup>,
): string | null {
  return groups.some((group) => !group.deleted && group.id === thread.customGroupId)
    ? (thread.customGroupId ?? null)
    : null;
}

/** Retry transient replication failures twice, stopping when superseded or disconnected. */
export async function retryThreadGroupSync(
  persist: () => Promise<boolean>,
  signal: AbortSignal,
): Promise<void> {
  for (const delay of [0, 1_000, 2_000]) {
    if (signal.aborted) return;
    if (delay > 0) {
      await Effect.runPromiseExit(Effect.sleep(delay), { signal });
    }
    if (signal.aborted || (await persist())) return;
  }
}
