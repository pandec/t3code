/**
 * Session-local state for the two-pane thread split view (fork feature).
 *
 * The primary pane is always the routed thread — the URL never learns about
 * the split. The secondary pane shows one server thread picked by the user
 * and lives only for the session: no persistence, no route, no drafts.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";

import type { ComposerHandleRef } from "../../composerHandleContext";

export type ThreadPaneId = "primary" | "secondary";

/** Split is only offered when both panes get a workable column. */
export const THREAD_SPLIT_MEDIA_QUERY = "(min-width: 64rem)";

export const MIN_SPLIT_RATIO = 0.25;
export const MAX_SPLIT_RATIO = 0.75;
const DEFAULT_SPLIT_RATIO = 0.5;
const SPLIT_RATIO_STORAGE_KEY = "t3code:thread-split-ratio";

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_SPLIT_RATIO;
  }
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

function readStoredSplitRatio(): number {
  if (typeof window === "undefined") {
    return DEFAULT_SPLIT_RATIO;
  }
  const raw = window.localStorage.getItem(SPLIT_RATIO_STORAGE_KEY);
  // Number("") is 0, which would clamp to the minimum instead of the default.
  if (raw === null || raw.trim().length === 0) {
    return DEFAULT_SPLIT_RATIO;
  }
  return clampSplitRatio(Number(raw));
}

interface ThreadSplitStore {
  secondaryRef: ScopedThreadRef | null;
  /**
   * True only while SplitThreadLayout actually renders two panes. This is
   * stricter than `secondaryRef !== null`: a picked secondary thread survives
   * a too-narrow viewport or a visit to a non-chat route, but during that
   * time the app must behave as a single pane or every active-pane gate
   * would go dead in the only visible view.
   */
  splitMounted: boolean;
  activePaneId: ThreadPaneId;
  splitRatio: number;
  openSecondaryThread: (ref: ScopedThreadRef) => void;
  closeSplit: () => void;
  setSplitMounted: (mounted: boolean) => void;
  setActivePane: (paneId: ThreadPaneId) => void;
  setSplitRatio: (ratio: number) => void;
}

export const useThreadSplitStore = create<ThreadSplitStore>((set, get) => ({
  secondaryRef: null,
  splitMounted: false,
  activePaneId: "primary",
  splitRatio: readStoredSplitRatio(),

  openSecondaryThread: (ref) => {
    const current = get().secondaryRef;
    if (current && scopedThreadKey(current) === scopedThreadKey(ref)) {
      set({ activePaneId: "secondary" });
      return;
    }
    set({ secondaryRef: ref, activePaneId: "secondary" });
  },

  closeSplit: () => {
    if (get().secondaryRef === null) return;
    set({ secondaryRef: null, activePaneId: "primary" });
  },

  setSplitMounted: (mounted) => {
    if (get().splitMounted === mounted) return;
    set({ splitMounted: mounted });
  },

  setActivePane: (paneId) => {
    if (get().activePaneId === paneId) return;
    set({ activePaneId: paneId });
  },

  setSplitRatio: (ratio) => {
    const next = clampSplitRatio(ratio);
    if (get().splitRatio === next) return;
    set({ splitRatio: next });
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(next));
    }
  },
}));

/**
 * Event-time ownership check for window-level listeners that exist once per
 * mounted ChatView. While the split is not actually rendered every pane is
 * the owner; while it is, only the active pane may act, so a shortcut can
 * never fire in both panes at once.
 */
export function isThreadPaneActive(paneId: ThreadPaneId): boolean {
  const state = useThreadSplitStore.getState();
  return !state.splitMounted || state.activePaneId === paneId;
}

// Focus plumbing lives outside the zustand state: DOM nodes and imperative
// composer handles are not render state, and focus moves must read them at
// event time without subscribing anyone.
interface ThreadPaneRuntime {
  root: HTMLElement | null;
  lastFocused: HTMLElement | null;
  composer: ComposerHandleRef | null;
}

const paneRuntimes: Record<ThreadPaneId, ThreadPaneRuntime> = {
  primary: { root: null, lastFocused: null, composer: null },
  secondary: { root: null, lastFocused: null, composer: null },
};

export function registerThreadPaneRoot(paneId: ThreadPaneId, root: HTMLElement | null): void {
  paneRuntimes[paneId].root = root;
  if (root === null) {
    paneRuntimes[paneId].lastFocused = null;
  }
}

export function registerThreadPaneComposer(
  paneId: ThreadPaneId,
  composer: ComposerHandleRef | null,
): void {
  paneRuntimes[paneId].composer = composer;
}

export function noteThreadPaneFocus(paneId: ThreadPaneId, element: EventTarget | null): void {
  if (element instanceof HTMLElement) {
    paneRuntimes[paneId].lastFocused = element;
  }
}

function focusThreadPane(paneId: ThreadPaneId): void {
  const runtime = paneRuntimes[paneId];
  const lastFocused = runtime.lastFocused;
  if (lastFocused && lastFocused.isConnected) {
    lastFocused.focus();
    return;
  }
  if (runtime.composer?.current) {
    runtime.composer.current.focusAtEnd();
    return;
  }
  runtime.root?.focus();
}

/**
 * A pointerdown that prevents default (toolbar buttons, drag affordances)
 * keeps DOM focus where it was — possibly in the other pane. Active pane and
 * real focus must not diverge: global focus probes (getTerminalFocusOwner)
 * would describe the other pane's terminal while this pane's handlers act on
 * it. Deferred a tick so it runs after the event cascade's default focusing.
 */
export function reclaimThreadPaneFocus(paneId: ThreadPaneId): void {
  window.setTimeout(() => {
    const state = useThreadSplitStore.getState();
    if (!state.splitMounted || state.activePaneId !== paneId) return;
    const otherRoot = paneRuntimes[paneId === "primary" ? "secondary" : "primary"].root;
    const activeElement = document.activeElement;
    if (otherRoot && activeElement instanceof HTMLElement && otherRoot.contains(activeElement)) {
      focusThreadPane(paneId);
    }
  }, 0);
}

/** Jump focus to the other pane. Returns false while the split is not rendered. */
export function focusOtherThreadPane(): boolean {
  const state = useThreadSplitStore.getState();
  if (!state.splitMounted || state.secondaryRef === null) {
    return false;
  }
  const nextPaneId: ThreadPaneId = state.activePaneId === "primary" ? "secondary" : "primary";
  state.setActivePane(nextPaneId);
  focusThreadPane(nextPaneId);
  return true;
}
