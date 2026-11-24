import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  planPinnedReorder,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import {
  isListedThreadLineage,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadGroup,
} from "@t3tools/contracts";
import { threadGroupId } from "@t3tools/shared/threadGroups";

type OrderThread = ThreadSnoozeShell &
  Pick<
    EnvironmentThreadShell,
    | "id"
    | "environmentId"
    | "createdAt"
    | "unsettledAt"
    | "archivedAt"
    | "settledOverride"
    | "pinnedAt"
    | "pinOrderKey"
    | "activeOrderKey"
    | "customGroupId"
    | "lineage"
  >;

interface ThreadMoveToTopPlan {
  readonly section: "pinned" | "active";
  readonly assignments: ReadonlyArray<{
    readonly threadRef: ScopedThreadRef;
    readonly orderKey: string;
  }>;
  readonly disabledReason?: string;
}

function rowKey(thread: OrderThread): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/**
 * Plan against the full group so search, filters, and collapsed rows cannot change "top".
 * `activeKeyOrdered`: whether Active and custom groups display in `activeOrderKey` order;
 * the Working shelf and folder mode sort them by activity, so no Active move applies.
 */
export function planThreadMoveToTop(input: {
  readonly threads: readonly OrderThread[];
  readonly threadRef: ScopedThreadRef | null;
  readonly groups: readonly ThreadGroup[];
  readonly now: string;
  readonly activeKeyOrdered: boolean;
  readonly canReorder: (environmentId: EnvironmentId, section: "pinned" | "active") => boolean;
}): ThreadMoveToTopPlan | null {
  if (input.threadRef === null) return null;
  const movedKey = scopedThreadKey(input.threadRef);
  const thread = input.threads.find((row) => rowKey(row) === movedKey);
  const isEligible = (row: OrderThread) =>
    isListedThreadLineage(row.lineage) &&
    row.archivedAt === null &&
    row.settledOverride !== "settled" &&
    !effectiveSnoozed(row, { now: input.now });
  if (!thread || !isEligible(thread)) return null;
  const section = thread.pinnedAt != null ? "pinned" : "active";
  if (section === "active" && !input.activeKeyOrdered) return null;
  if (!input.canReorder(thread.environmentId, section)) return null;
  const groupId = threadGroupId(thread, input.groups);
  const members = input.threads.filter(
    (row) =>
      isEligible(row) &&
      (section === "pinned"
        ? row.pinnedAt != null
        : row.pinnedAt == null && threadGroupId(row, input.groups) === groupId),
  );
  const ordered =
    section === "pinned"
      ? sortPinnedThreadsByOrderKey(members)
      : sortActiveThreadsByOrderKey(members);
  if (rowKey(ordered[0]!) === movedKey) {
    return { section, assignments: [], disabledReason: "Already at top" };
  }
  const byKey = new Map(members.map((row) => [rowKey(row), row]));
  const assignments = planPinnedReorder({
    orderedIds: [movedKey, ...ordered.map(rowKey).filter((key) => key !== movedKey)],
    // Retained positions in other groups and shelves remain reserved, as in dragging.
    keysById: new Map(
      input.threads.map((row) => [
        rowKey(row),
        section === "pinned" ? row.pinOrderKey : row.activeOrderKey,
      ]),
    ),
    movedId: movedKey,
  }).map(({ id, orderKey }) => {
    const row = byKey.get(id)!;
    return { threadRef: scopeThreadRef(row.environmentId, row.id), orderKey };
  });
  if (assignments.some(({ threadRef }) => !input.canReorder(threadRef.environmentId, section))) {
    return {
      section,
      assignments: [],
      disabledReason: "Update the servers for these threads to support ordering",
    };
  }
  return { section, assignments };
}
