import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import {
  openThreadInActivePane,
  planThreadOpen,
  shouldCloseSplitForRoute,
} from "./threadOpenTarget";
import { useThreadSplitStore, type PendingPaneSwap } from "./threadSplitStore";

const threadRef = (environmentId: string, threadId: string) => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});

const ROUTE_REF = threadRef("env-a", "thread-route");
const SECONDARY_REF = threadRef("env-a", "thread-secondary");
const OTHER_REF = threadRef("env-b", "thread-other");

beforeEach(() => {
  useThreadSplitStore.setState({
    secondaryRef: null,
    splitMounted: false,
    activePaneId: "primary",
    splitRatio: 0.5,
    pendingSwap: null,
  });
});

describe("planThreadOpen", () => {
  const mountedSplit = {
    routeThreadRef: ROUTE_REF,
    splitMounted: true,
    activePaneId: "primary" as const,
    secondaryRef: SECONDARY_REF,
  };

  it("navigates the primary route while no split is rendered", () => {
    // Also covers a parked secondaryRef on a too-narrow viewport.
    expect(
      planThreadOpen({
        targetRef: OTHER_REF,
        routeThreadRef: ROUTE_REF,
        splitMounted: false,
        activePaneId: "secondary",
        secondaryRef: SECONDARY_REF,
      }),
    ).toEqual({ kind: "navigate-primary" });
  });

  it("focuses the primary pane when the target is already routed", () => {
    expect(planThreadOpen({ ...mountedSplit, targetRef: ROUTE_REF })).toEqual({
      kind: "focus-pane",
      paneId: "primary",
    });
  });

  it("focuses the secondary pane when the target is already open there", () => {
    // The reported bug: navigating instead would trip the duplicate-thread
    // guard and fold the split.
    expect(
      planThreadOpen({ ...mountedSplit, targetRef: SECONDARY_REF, activePaneId: "secondary" }),
    ).toEqual({ kind: "focus-pane", paneId: "secondary" });
  });

  it("focuses the secondary pane even with a draft primary", () => {
    expect(
      planThreadOpen({
        targetRef: SECONDARY_REF,
        routeThreadRef: null,
        splitMounted: true,
        activePaneId: "secondary",
        secondaryRef: SECONDARY_REF,
      }),
    ).toEqual({ kind: "focus-pane", paneId: "secondary" });
  });

  it("routes a fresh target to the active pane", () => {
    expect(planThreadOpen({ ...mountedSplit, targetRef: OTHER_REF })).toEqual({
      kind: "navigate-primary",
    });
    expect(
      planThreadOpen({ ...mountedSplit, targetRef: OTHER_REF, activePaneId: "secondary" }),
    ).toEqual({ kind: "open-secondary" });
  });

  it("lets a pane override beat the live active pane", () => {
    expect(
      planThreadOpen({
        ...mountedSplit,
        targetRef: OTHER_REF,
        activePaneId: "primary",
        paneOverride: "secondary",
      }),
    ).toEqual({ kind: "open-secondary" });
  });
});

describe("openThreadInActivePane", () => {
  it("replaces the secondary thread when the secondary pane is active", () => {
    useThreadSplitStore.getState().openSecondaryThread(SECONDARY_REF);
    useThreadSplitStore.getState().setSplitMounted(true);

    let navigated = 0;
    openThreadInActivePane({
      targetRef: OTHER_REF,
      routeThreadRef: ROUTE_REF,
      navigateToPrimary: () => {
        navigated += 1;
      },
    });
    expect(navigated).toBe(0);
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(OTHER_REF);
  });

  it("activates the pane already showing the target instead of navigating", () => {
    useThreadSplitStore.getState().openSecondaryThread(SECONDARY_REF);
    useThreadSplitStore.getState().setSplitMounted(true);

    let navigated = 0;
    openThreadInActivePane({
      targetRef: SECONDARY_REF,
      routeThreadRef: ROUTE_REF,
      paneOverride: "primary",
      navigateToPrimary: () => {
        navigated += 1;
      },
    });
    expect(navigated).toBe(0);
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(SECONDARY_REF);
    expect(useThreadSplitStore.getState().activePaneId).toBe("secondary");
  });

  it("navigates the primary route when the primary pane is active", () => {
    useThreadSplitStore.getState().openSecondaryThread(SECONDARY_REF);
    useThreadSplitStore.getState().setSplitMounted(true);
    useThreadSplitStore.getState().setActivePane("primary");

    let navigated = 0;
    openThreadInActivePane({
      targetRef: OTHER_REF,
      routeThreadRef: ROUTE_REF,
      navigateToPrimary: () => {
        navigated += 1;
      },
    });
    expect(navigated).toBe(1);
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(SECONDARY_REF);
  });

  it("reports the executed plan and surfaces the navigation promise", async () => {
    // The command palette awaited navigation before the split routing landed;
    // a rejection must still reach its run-command error handling.
    const failure = new Error("navigation rejected");
    const navigated = openThreadInActivePane({
      targetRef: OTHER_REF,
      routeThreadRef: ROUTE_REF,
      navigateToPrimary: () => Promise.reject(failure),
    });
    expect(navigated.plan).toEqual({ kind: "navigate-primary" });
    await expect(navigated.completion).rejects.toBe(failure);

    useThreadSplitStore.getState().openSecondaryThread(SECONDARY_REF);
    useThreadSplitStore.getState().setSplitMounted(true);
    const opened = openThreadInActivePane({
      targetRef: OTHER_REF,
      routeThreadRef: ROUTE_REF,
      navigateToPrimary: () => undefined,
    });
    expect(opened.plan).toEqual({ kind: "open-secondary" });
    expect(opened.completion).toBeNull();
  });
});

describe("shouldCloseSplitForRoute", () => {
  const duplicateKey = scopedThreadKey(SECONDARY_REF);
  const freshSwap: PendingPaneSwap = {
    expectedRouteKey: scopedThreadKey(OTHER_REF),
    startedRouteKey: duplicateKey,
    restoreSecondaryRef: OTHER_REF,
    expiresAt: 10_000,
  };

  it("closes on a plain duplicate and stays quiet otherwise", () => {
    expect(
      shouldCloseSplitForRoute({
        routeThreadKey: duplicateKey,
        secondaryKey: duplicateKey,
        pendingSwap: null,
        now: 0,
      }),
    ).toBe(true);
    expect(
      shouldCloseSplitForRoute({
        routeThreadKey: scopedThreadKey(ROUTE_REF),
        secondaryKey: duplicateKey,
        pendingSwap: null,
        now: 0,
      }),
    ).toBe(false);
    expect(
      shouldCloseSplitForRoute({
        routeThreadKey: null,
        secondaryKey: duplicateKey,
        pendingSwap: null,
        now: 0,
      }),
    ).toBe(false);
  });

  it("holds off while a fresh swap latch vouches for the duplicate", () => {
    expect(
      shouldCloseSplitForRoute({
        routeThreadKey: duplicateKey,
        secondaryKey: duplicateKey,
        pendingSwap: freshSwap,
        now: 5_000,
      }),
    ).toBe(false);
  });

  it("treats an expired latch as no latch", () => {
    expect(
      shouldCloseSplitForRoute({
        routeThreadKey: duplicateKey,
        secondaryKey: duplicateKey,
        pendingSwap: freshSwap,
        now: 10_001,
      }),
    ).toBe(true);
  });
});
