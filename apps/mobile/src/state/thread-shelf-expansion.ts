import type { Preferences } from "../persistence/mobile-preferences";

/** The thread list's collapsible shelves, in the order they render. */
export type ThreadShelfId = "pinned" | "active" | "snoozed" | "settled" | "archived";

const SHELF_PREFERENCE_KEYS = {
  pinned: "sidebarPinnedShelfExpanded",
  active: "sidebarActiveShelfExpanded",
  snoozed: "sidebarSnoozedShelfExpanded",
  settled: "sidebarSettledShelfExpanded",
  archived: "sidebarArchivedShelfExpanded",
} as const satisfies Record<ThreadShelfId, keyof Preferences>;

/**
 * Fold state for one shelf. Pinned, active, and settled start expanded;
 * snoozed and archived start folded. A stored choice overrides these defaults, including
 * while preferences are still loading: `preferences` is empty until they
 * arrive, so an untouched shelf never latches the pre-hydration default.
 */
export function resolveThreadShelfExpanded(input: {
  readonly shelf: ThreadShelfId;
  readonly preferences: Preferences;
}): boolean {
  const stored = input.preferences[SHELF_PREFERENCE_KEYS[input.shelf]];
  if (typeof stored === "boolean") return stored;
  switch (input.shelf) {
    case "pinned":
    case "active":
    case "settled":
      return true;
    default:
      return false;
  }
}

/** The preference patch a shelf toggle writes. */
export function threadShelfExpandedPatch(
  shelf: ThreadShelfId,
  expanded: boolean,
): Partial<Preferences> {
  return { [SHELF_PREFERENCE_KEYS[shelf]]: expanded };
}
