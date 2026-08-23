/**
 * Sidebar decoration source for the split view (fork feature). One
 * subscription with a string-stable selector — call it once at the list
 * level and compare row keys against it, never subscribe per row.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { useThreadSplitStore } from "./threadSplitStore";

/** Which side of the split a sidebar row's thread occupies, if any. */
export type SplitPaneMarker = "left" | "right";

/**
 * The secondary pane's thread key while two panes are actually rendered,
 * null otherwise. The primary side needs no hook: it is the route thread the
 * sidebar already tracks.
 */
export function useSplitSecondaryThreadKey(): string | null {
  return useThreadSplitStore((state) =>
    state.splitMounted && state.secondaryRef !== null ? scopedThreadKey(state.secondaryRef) : null,
  );
}
