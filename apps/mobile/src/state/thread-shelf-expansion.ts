import type { Preferences } from "../persistence/mobile-preferences";

/** The thread list's collapsible shelves, in the order they render. */
export type ThreadShelfId = "older" | "snoozed" | "settled" | "archived";

const SHELF_PREFERENCE_KEYS = {
  older: "sidebarOlderShelfExpanded",
  snoozed: "sidebarSnoozedShelfExpanded",
  settled: "sidebarSettledShelfExpanded",
  archived: "sidebarArchivedShelfExpanded",
} as const satisfies Record<ThreadShelfId, keyof Preferences>;

/**
 * Fold state for one shelf: the stored choice when there is one, otherwise the
 * shelf's starting state.
 *
 * Older follows its Extras setting, settled opens because recent history is
 * the common lookup, and snoozed and archived stay folded — both are work the
 * user deliberately put away. A stored value always wins, including while
 * preferences are still loading: `preferences` is empty until they arrive, so
 * an untouched shelf never latches the pre-hydration default.
 */
export function resolveThreadShelfExpanded(input: {
  readonly shelf: ThreadShelfId;
  readonly preferences: Preferences;
  readonly olderCollapsedByDefault: boolean;
}): boolean {
  const stored = input.preferences[SHELF_PREFERENCE_KEYS[input.shelf]];
  if (typeof stored === "boolean") return stored;
  switch (input.shelf) {
    case "older":
      return !input.olderCollapsedByDefault;
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
  switch (shelf) {
    case "older":
      return { sidebarOlderShelfExpanded: expanded };
    case "snoozed":
      return { sidebarSnoozedShelfExpanded: expanded };
    case "settled":
      return { sidebarSettledShelfExpanded: expanded };
    case "archived":
      return { sidebarArchivedShelfExpanded: expanded };
  }
}
