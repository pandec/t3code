import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { ComposerHandleRef } from "../../composerHandleContext";

import {
  activateThreadPane,
  capturePaletteOwnerPane,
  clampSplitRatio,
  focusOtherThreadPane,
  isThreadPaneActive,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  paletteOwnerPane,
  PENDING_SWAP_TTL_MS,
  registerThreadPaneComposer,
  useThreadSplitStore,
} from "./threadSplitStore";

const threadRef = (environmentId: string, threadId: string) => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});

const REF_A = threadRef("env-a", "thread-1");
const REF_B = threadRef("env-b", "thread-1");

// SplitThreadLayout owns splitMounted via an effect; tests simulate it.
function mountSplit() {
  useThreadSplitStore.getState().setSplitMounted(true);
}

beforeEach(() => {
  useThreadSplitStore.setState({
    secondaryRef: null,
    splitMounted: false,
    activePaneId: "primary",
    splitRatio: 0.5,
    pendingSwap: null,
  });
  registerThreadPaneComposer("primary", null);
  registerThreadPaneComposer("secondary", null);
});

describe("useThreadSplitStore", () => {
  it("opens the secondary pane focused and closes back to primary", () => {
    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(REF_A);
    expect(useThreadSplitStore.getState().activePaneId).toBe("secondary");

    useThreadSplitStore.getState().closeSplit();
    expect(useThreadSplitStore.getState().secondaryRef).toBeNull();
    expect(useThreadSplitStore.getState().activePaneId).toBe("primary");
  });

  it("treats same thread id in another environment as a different thread", () => {
    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    useThreadSplitStore.getState().openSecondaryThread(REF_B);
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(REF_B);
  });

  it("re-picking the current secondary thread only refocuses the pane", () => {
    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    useThreadSplitStore.getState().setActivePane("primary");
    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(REF_A);
    expect(useThreadSplitStore.getState().activePaneId).toBe("secondary");
  });
});

describe("isThreadPaneActive", () => {
  it("treats every pane as active while the split is closed", () => {
    expect(isThreadPaneActive("primary")).toBe(true);
    expect(isThreadPaneActive("secondary")).toBe(true);
  });

  it("treats every pane as active while a picked split is not rendered", () => {
    // A secondary thread stays picked when the viewport narrows or a
    // non-chat route unmounts the layout; the single visible pane must keep
    // owning every shortcut or the app goes keyboard-dead.
    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    expect(useThreadSplitStore.getState().activePaneId).toBe("secondary");
    expect(isThreadPaneActive("primary")).toBe(true);
    expect(isThreadPaneActive("secondary")).toBe(true);
  });

  it("grants ownership only to the active pane while the split is rendered", () => {
    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    mountSplit();
    expect(isThreadPaneActive("secondary")).toBe(true);
    expect(isThreadPaneActive("primary")).toBe(false);

    useThreadSplitStore.getState().setActivePane("primary");
    expect(isThreadPaneActive("primary")).toBe(true);
    expect(isThreadPaneActive("secondary")).toBe(false);
  });
});

describe("focusOtherThreadPane", () => {
  it("is a no-op while the split is closed", () => {
    expect(focusOtherThreadPane()).toBe(false);
    expect(useThreadSplitStore.getState().activePaneId).toBe("primary");
  });

  it("is a no-op while a picked split is not rendered", () => {
    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    expect(focusOtherThreadPane()).toBe(false);
    expect(useThreadSplitStore.getState().activePaneId).toBe("secondary");
  });

  it("toggles the active pane and focuses its composer handle", () => {
    const focused: string[] = [];
    const primaryComposerRef = {
      current: { focusAtEnd: () => focused.push("primary") },
    } as unknown as ComposerHandleRef;
    registerThreadPaneComposer("primary", primaryComposerRef);
    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    mountSplit();

    expect(focusOtherThreadPane()).toBe(true);
    expect(useThreadSplitStore.getState().activePaneId).toBe("primary");
    expect(focused).toEqual(["primary"]);

    expect(focusOtherThreadPane()).toBe(true);
    expect(useThreadSplitStore.getState().activePaneId).toBe("secondary");
  });
});

describe("pane swap latch", () => {
  const ROUTE_REF = threadRef("env-a", "thread-route");

  function openMountedSplit() {
    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    mountSplit();
  }

  it("swaps the secondary, returns the navigation target, and keeps the active side", () => {
    openMountedSplit();
    useThreadSplitStore.getState().setActivePane("secondary");

    const target = useThreadSplitStore.getState().beginPaneSwap(ROUTE_REF);
    expect(target).toEqual(REF_A);
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(ROUTE_REF);
    expect(useThreadSplitStore.getState().activePaneId).toBe("secondary");
    expect(useThreadSplitStore.getState().pendingSwap).not.toBeNull();
  });

  it("refuses without a secondary, while unmounted, or while a swap is in flight", () => {
    expect(useThreadSplitStore.getState().beginPaneSwap(ROUTE_REF)).toBeNull();

    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    expect(useThreadSplitStore.getState().beginPaneSwap(ROUTE_REF)).toBeNull();

    mountSplit();
    expect(useThreadSplitStore.getState().beginPaneSwap(ROUTE_REF)).not.toBeNull();
    expect(useThreadSplitStore.getState().beginPaneSwap(ROUTE_REF)).toBeNull();
  });

  it("settle clears the latch and keeps the swapped secondary", () => {
    openMountedSplit();
    useThreadSplitStore.getState().beginPaneSwap(ROUTE_REF);
    useThreadSplitStore.getState().settlePaneSwap();
    expect(useThreadSplitStore.getState().pendingSwap).toBeNull();
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(ROUTE_REF);
  });

  it("abort restores the old secondary", () => {
    openMountedSplit();
    useThreadSplitStore.getState().beginPaneSwap(ROUTE_REF);
    useThreadSplitStore.getState().abortPaneSwap();
    expect(useThreadSplitStore.getState().pendingSwap).toBeNull();
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(REF_A);
  });

  it("abort yields to a secondary the user replaced mid-flight", () => {
    openMountedSplit();
    useThreadSplitStore.getState().beginPaneSwap(ROUTE_REF);
    useThreadSplitStore.getState().openSecondaryThread(REF_B);
    // The latch survives the pick (its late route arrival must still be
    // recognized), but aborting must not clobber the newer secondary.
    expect(useThreadSplitStore.getState().pendingSwap).not.toBeNull();
    useThreadSplitStore.getState().abortPaneSwap();
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(REF_B);
    expect(useThreadSplitStore.getState().pendingSwap).toBeNull();
  });

  it("closeSplit clears an in-flight latch", () => {
    openMountedSplit();
    useThreadSplitStore.getState().beginPaneSwap(ROUTE_REF);
    expect(useThreadSplitStore.getState().pendingSwap).not.toBeNull();
    useThreadSplitStore.getState().closeSplit();
    expect(useThreadSplitStore.getState().pendingSwap).toBeNull();
  });
});

describe("pane swap expiry", () => {
  const ROUTE_REF = threadRef("env-a", "thread-route");

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts and restores the old secondary when the navigation never arrives", () => {
    // No re-render happens while a navigation stalls, so only the store's
    // own timer can release the latch (and re-enable every swap affordance).
    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    mountSplit();
    useThreadSplitStore.getState().beginPaneSwap(ROUTE_REF);
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(ROUTE_REF);

    vi.advanceTimersByTime(PENDING_SWAP_TTL_MS);
    expect(useThreadSplitStore.getState().pendingSwap).toBeNull();
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(REF_A);
  });

  it("a settled swap's expiry timer never fires", () => {
    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    mountSplit();
    useThreadSplitStore.getState().beginPaneSwap(ROUTE_REF);
    useThreadSplitStore.getState().settlePaneSwap();

    vi.advanceTimersByTime(PENDING_SWAP_TTL_MS * 2);
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(ROUTE_REF);
    expect(useThreadSplitStore.getState().pendingSwap).toBeNull();
  });
});

describe("activateThreadPane", () => {
  it("activates the pane and focuses its composer handle", () => {
    const focused: string[] = [];
    const secondaryComposerRef = {
      current: { focusAtEnd: () => focused.push("secondary") },
    } as unknown as ComposerHandleRef;
    registerThreadPaneComposer("secondary", secondaryComposerRef);
    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    mountSplit();
    useThreadSplitStore.getState().setActivePane("primary");

    activateThreadPane("secondary");
    expect(useThreadSplitStore.getState().activePaneId).toBe("secondary");
    expect(focused).toEqual(["secondary"]);
  });
});

describe("paletteOwnerPane", () => {
  it("round-trips the active pane captured at palette open", () => {
    useThreadSplitStore.getState().openSecondaryThread(REF_A);
    mountSplit();
    capturePaletteOwnerPane();
    expect(paletteOwnerPane()).toBe("secondary");

    // Live pane moves (dialog focus traffic) must not leak into the snapshot.
    useThreadSplitStore.getState().setActivePane("primary");
    expect(paletteOwnerPane()).toBe("secondary");

    capturePaletteOwnerPane();
    expect(paletteOwnerPane()).toBe("primary");
  });
});

describe("clampSplitRatio", () => {
  it("clamps into the allowed pane range and rejects junk", () => {
    expect(clampSplitRatio(0.1)).toBe(MIN_SPLIT_RATIO);
    expect(clampSplitRatio(0.9)).toBe(MAX_SPLIT_RATIO);
    expect(clampSplitRatio(0.6)).toBe(0.6);
    expect(clampSplitRatio(Number.NaN)).toBe(0.5);
  });
});

// This suite runs without a DOM; the store only touches `window` through
// guarded accessors, so a plain stub is enough to model restricted hosts.
describe("blocked storage", () => {
  const globalWithWindow = globalThis as { window?: unknown };

  const importFreshStore = async () => {
    vi.resetModules();
    return import("./threadSplitStore");
  };

  afterEach(() => {
    delete globalWithWindow.window;
    vi.resetModules();
  });

  it("falls back to the default ratio when the localStorage property throws", async () => {
    globalWithWindow.window = {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    };
    const store = await importFreshStore();
    expect(store.useThreadSplitStore.getState().splitRatio).toBe(0.5);
    // Writes must stay silent too.
    store.useThreadSplitStore.getState().setSplitRatio(0.6);
    expect(store.useThreadSplitStore.getState().splitRatio).toBe(0.6);
  });

  it("survives a storage whose operations throw after resolving", async () => {
    globalWithWindow.window = {
      localStorage: {
        getItem(): string | null {
          throw new Error("SecurityError");
        },
        setItem(): void {
          throw new Error("SecurityError");
        },
      },
    };
    const store = await importFreshStore();
    expect(store.useThreadSplitStore.getState().splitRatio).toBe(0.5);
    store.useThreadSplitStore.getState().setSplitRatio(0.6);
    expect(store.useThreadSplitStore.getState().splitRatio).toBe(0.6);
  });
});
