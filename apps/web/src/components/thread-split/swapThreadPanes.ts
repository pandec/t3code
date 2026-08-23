/**
 * Swap the two split panes' threads (fork feature). The secondary side is
 * plain store state, but the primary side is the URL route, so a swap is
 * "set secondary to the old primary, then navigate to the old secondary"
 * under the store's pendingSwap latch (see threadSplitStore).
 */
import type { ScopedThreadRef } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { activateThreadPane, useThreadSplitStore } from "./threadSplitStore";

/**
 * Swap is offered only while two server threads are actually on screen: a
 * draft primary has nothing to hand to the secondary pane, and a swap
 * already in flight must finish first.
 */
export function canSwapThreadPanes(routeThreadRef: ScopedThreadRef | null): boolean {
  const state = useThreadSplitStore.getState();
  return (
    state.splitMounted &&
    state.secondaryRef !== null &&
    routeThreadRef !== null &&
    state.pendingSwap === null
  );
}

/**
 * Run the swap. Returns false when it could not start or the navigation was
 * rejected (the store is rolled back and a toast shown). On success the
 * latch stays set — SplitThreadLayout's route effect settles it when the
 * expected route arrives, which is also what keeps the same physical side
 * active.
 */
export async function swapThreadPanes(input: {
  routeThreadRef: ScopedThreadRef | null;
  navigateToThread: (ref: ScopedThreadRef) => void | Promise<unknown>;
}): Promise<boolean> {
  if (input.routeThreadRef === null) {
    return false;
  }
  const target = useThreadSplitStore.getState().beginPaneSwap(input.routeThreadRef);
  if (target === null) {
    return false;
  }
  try {
    await input.navigateToThread(target);
  } catch {
    useThreadSplitStore.getState().abortPaneSwap();
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not swap split threads",
        description: "Navigation to the other pane's thread failed.",
      }),
    );
    return false;
  }
  // The active side keeps its role, but its ChatView remounted with the other
  // thread (and a triggering button or shortcut may hold DOM focus) — reclaim
  // focus here so every invocation path behaves the same. The queued intent
  // also survives an overlay's close-time restore (palette action).
  activateThreadPane(useThreadSplitStore.getState().activePaneId);
  return true;
}
