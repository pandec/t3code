import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { requestThreadPaneFocus, useThreadSplitStore } from "./threadSplitStore";

const THREAD_ITEM_VALUE_PREFIX = "thread:";

/**
 * Derives "open in split" picker items from the palette's existing thread
 * items (same titles, descriptions, icons, and search behavior) by rebinding
 * each item's action to the secondary pane. Relies on thread item values
 * carrying the scoped thread key (`thread:<environmentId>:<threadId>`).
 */
export function buildOpenInSplitThreadItems(input: {
  threadItems: ReadonlyArray<CommandPaletteActionItem>;
  routeThreadRef: ScopedThreadRef | null;
  secondaryRef: ScopedThreadRef | null;
}): CommandPaletteActionItem[] {
  const excludedThreadKeys = new Set<string>();
  if (input.routeThreadRef) {
    excludedThreadKeys.add(scopedThreadKey(input.routeThreadRef));
  }
  if (input.secondaryRef) {
    excludedThreadKeys.add(scopedThreadKey(input.secondaryRef));
  }

  return input.threadItems.flatMap((item) => {
    if (!item.value.startsWith(THREAD_ITEM_VALUE_PREFIX)) {
      return [];
    }
    const threadKey = item.value.slice(THREAD_ITEM_VALUE_PREFIX.length);
    if (excludedThreadKeys.has(threadKey)) {
      return [];
    }
    const threadRef = parseScopedThreadKey(threadKey);
    if (threadRef === null) {
      return [];
    }
    return [
      {
        ...item,
        value: `open-in-split:${threadKey}`,
        run: async () => {
          // The closing palette restores focus to its trigger in the primary
          // pane a beat later; the intent bounces that restore into the pane
          // the user just opened.
          requestThreadPaneFocus("secondary");
          useThreadSplitStore.getState().openSecondaryThread(threadRef);
        },
      },
    ];
  });
}
