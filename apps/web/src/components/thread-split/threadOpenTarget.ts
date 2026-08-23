/**
 * Active-pane-aware thread opening (fork feature). The sidebar and the
 * command palette both funnel plain thread picks through here so the picked
 * thread lands in the pane the user is working in, instead of always
 * replacing the primary route.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { PendingPaneSwap, ThreadPaneId } from "./threadSplitStore";
import { activateThreadPane, useThreadSplitStore } from "./threadSplitStore";

export type ThreadOpenPlan =
  | { kind: "navigate-primary" }
  | { kind: "open-secondary" }
  | { kind: "focus-pane"; paneId: ThreadPaneId };

/**
 * Decide where a picked thread should open. Pure so the branch matrix is
 * testable without a DOM:
 *
 * 1. No rendered split → plain primary navigation (also covers a parked
 *    secondaryRef on a too-narrow viewport).
 * 2. Already the routed thread → focus the primary pane, never re-navigate.
 * 3. Already the secondary thread → focus the secondary pane. Navigating
 *    instead would trip the duplicate-thread guard and fold the split.
 * 4. Otherwise the active pane (or the caller's snapshot of it) receives it.
 */
export function planThreadOpen(input: {
  targetRef: ScopedThreadRef;
  routeThreadRef: ScopedThreadRef | null;
  splitMounted: boolean;
  activePaneId: ThreadPaneId;
  secondaryRef: ScopedThreadRef | null;
  paneOverride?: ThreadPaneId;
}): ThreadOpenPlan {
  if (!input.splitMounted) {
    return { kind: "navigate-primary" };
  }
  const targetKey = scopedThreadKey(input.targetRef);
  if (input.routeThreadRef !== null && scopedThreadKey(input.routeThreadRef) === targetKey) {
    return { kind: "focus-pane", paneId: "primary" };
  }
  if (input.secondaryRef !== null && scopedThreadKey(input.secondaryRef) === targetKey) {
    return { kind: "focus-pane", paneId: "secondary" };
  }
  if ((input.paneOverride ?? input.activePaneId) === "primary") {
    return { kind: "navigate-primary" };
  }
  return { kind: "open-secondary" };
}

export interface ThreadOpenResult {
  /** Which branch executed — callers key follow-up work off this. */
  plan: ThreadOpenPlan;
  /**
   * The primary navigation's promise when the plan navigated, so callers
   * that awaited navigation before (the command palette's error handling)
   * still see rejections. Null for the store-only branches.
   */
  completion: Promise<unknown> | null;
}

/**
 * Execute a thread pick against the live split state. `paneOverride` is for
 * the command palette, which must use the pane snapshotted at open time
 * rather than the live value.
 */
export function openThreadInActivePane(input: {
  targetRef: ScopedThreadRef;
  routeThreadRef: ScopedThreadRef | null;
  paneOverride?: ThreadPaneId;
  navigateToPrimary: () => void | Promise<unknown>;
}): ThreadOpenResult {
  const state = useThreadSplitStore.getState();
  const plan = planThreadOpen({
    targetRef: input.targetRef,
    routeThreadRef: input.routeThreadRef,
    splitMounted: state.splitMounted,
    activePaneId: state.activePaneId,
    secondaryRef: state.secondaryRef,
    ...(input.paneOverride ? { paneOverride: input.paneOverride } : {}),
  });
  switch (plan.kind) {
    case "navigate-primary": {
      const navigation = input.navigateToPrimary();
      return { plan, completion: navigation instanceof Promise ? navigation : null };
    }
    case "open-secondary":
      state.openSecondaryThread(input.targetRef);
      return { plan, completion: null };
    case "focus-pane":
      activateThreadPane(plan.paneId);
      return { plan, completion: null };
  }
}

/**
 * The duplicate-thread guard's decision: the primary route landing on the
 * secondary's thread normally folds the split ("the thread moved there"),
 * except while a fresh pane swap is in flight — mid-swap the route briefly
 * equals the new secondary by construction.
 */
export function shouldCloseSplitForRoute(input: {
  routeThreadKey: string | null;
  secondaryKey: string | null;
  pendingSwap: PendingPaneSwap | null;
  now: number;
}): boolean {
  if (input.routeThreadKey === null || input.secondaryKey === null) {
    return false;
  }
  if (input.routeThreadKey !== input.secondaryKey) {
    return false;
  }
  return input.pendingSwap === null || input.now > input.pendingSwap.expiresAt;
}
