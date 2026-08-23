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

// `window` alone is not enough: the test runner and other embedded hosts define
// a window without `localStorage`, and this store is constructed at import time.
// Restricted hosts go further: the property access and every Storage operation
// can throw a SecurityError. Dragging the splitter writes at pointer-move rate,
// so the handle resolves once and is dropped on the first failing operation
// instead of throwing (and catching) per move.
let resolvedStorage: Storage | null | undefined;

function splitRatioStorage(): Storage | null {
  if (resolvedStorage === undefined) {
    try {
      resolvedStorage = typeof window === "undefined" ? null : (window.localStorage ?? null);
    } catch {
      resolvedStorage = null;
    }
  }
  return resolvedStorage;
}

function readStoredSplitRatio(): number {
  const storage = splitRatioStorage();
  if (storage === null) {
    return DEFAULT_SPLIT_RATIO;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(SPLIT_RATIO_STORAGE_KEY);
  } catch {
    resolvedStorage = null;
    return DEFAULT_SPLIT_RATIO;
  }
  // Number("") is 0, which would clamp to the minimum instead of the default.
  if (raw === null || raw.trim().length === 0) {
    return DEFAULT_SPLIT_RATIO;
  }
  return clampSplitRatio(Number(raw));
}

/**
 * In-flight pane swap. Swapping sets the secondary to the old primary and
 * then navigates the primary route to the old secondary — between those two
 * steps the route still equals the new secondary, which the duplicate-thread
 * guard would read as "moved" and fold the split. The latch tells the guard
 * to hold off until the route arrives (or the swap visibly failed).
 */
export interface PendingPaneSwap {
  /** Where the primary route is headed: the old secondary thread. */
  expectedRouteKey: string;
  /** The route (old primary) at swap start — also the new secondary's key. */
  startedRouteKey: string;
  /** The old secondary ref, restored if the swap aborts. */
  restoreSecondaryRef: ScopedThreadRef;
  expiresAt: number;
}

const PENDING_SWAP_TTL_MS = 5_000;

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
  pendingSwap: PendingPaneSwap | null;
  openSecondaryThread: (ref: ScopedThreadRef) => void;
  closeSplit: () => void;
  setSplitMounted: (mounted: boolean) => void;
  setActivePane: (paneId: ThreadPaneId) => void;
  setSplitRatio: (ratio: number) => void;
  beginPaneSwap: (routeThreadRef: ScopedThreadRef) => ScopedThreadRef | null;
  settlePaneSwap: () => void;
  abortPaneSwap: () => void;
}

export const useThreadSplitStore = create<ThreadSplitStore>((set, get) => ({
  secondaryRef: null,
  splitMounted: false,
  activePaneId: "primary",
  splitRatio: readStoredSplitRatio(),
  pendingSwap: null,

  openSecondaryThread: (ref) => {
    // The pick usually comes from the command palette, whose close restores
    // focus to the trigger in the primary pane a beat later — the intent
    // makes that restore bounce into the pane the user just opened.
    requestThreadPaneFocus("secondary");
    const current = get().secondaryRef;
    // An explicit pick overrides any in-flight swap: keeping the latch alive
    // would let its abort path later clobber the thread the user just chose.
    if (current && scopedThreadKey(current) === scopedThreadKey(ref)) {
      set({ activePaneId: "secondary", pendingSwap: null });
      return;
    }
    set({ secondaryRef: ref, activePaneId: "secondary", pendingSwap: null });
  },

  closeSplit: () => {
    if (get().secondaryRef === null) return;
    set({ secondaryRef: null, activePaneId: "primary", pendingSwap: null });
    // The close control usually lives in the secondary pane, whose unmount
    // would drop DOM focus to <body>; hand it to the surviving pane instead.
    focusThreadPane("primary");
  },

  beginPaneSwap: (routeThreadRef) => {
    const state = get();
    if (state.secondaryRef === null || !state.splitMounted) {
      return null;
    }
    if (state.pendingSwap !== null && Date.now() <= state.pendingSwap.expiresAt) {
      return null;
    }
    const target = state.secondaryRef;
    // Deliberately leaves activePaneId alone: the threads trade sides, and the
    // side the user was working on should stay the one that owns shortcuts.
    set({
      secondaryRef: routeThreadRef,
      pendingSwap: {
        expectedRouteKey: scopedThreadKey(target),
        startedRouteKey: scopedThreadKey(routeThreadRef),
        restoreSecondaryRef: target,
        expiresAt: Date.now() + PENDING_SWAP_TTL_MS,
      },
    });
    return target;
  },

  settlePaneSwap: () => {
    if (get().pendingSwap === null) return;
    set({ pendingSwap: null });
  },

  abortPaneSwap: () => {
    const state = get();
    const pending = state.pendingSwap;
    if (pending === null) return;
    // Restore only when the secondary is still the one the swap installed —
    // a pick that replaced it mid-flight is newer user intent and wins.
    if (
      state.secondaryRef !== null &&
      scopedThreadKey(state.secondaryRef) === pending.startedRouteKey
    ) {
      set({ secondaryRef: pending.restoreSecondaryRef, pendingSwap: null });
      return;
    }
    set({ pendingSwap: null });
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
    // Persistence is best-effort: a full or read-only storage must not break
    // the drag that triggered the write, and one failure stops further tries.
    try {
      splitRatioStorage()?.setItem(SPLIT_RATIO_STORAGE_KEY, String(next));
    } catch {
      resolvedStorage = null;
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

/**
 * One-shot intent that survives an overlay's close-time focus restore. A
 * palette pick activates a pane, but the closing dialog then restores focus
 * to its trigger in the other pane, which would silently re-activate it.
 * While the intent is fresh, that stray focus gets bounced to the intended
 * pane instead; a real pointerdown anywhere cancels it as user intent.
 */
let pendingPaneFocus: { paneId: ThreadPaneId; expiresAt: number } | null = null;
const PENDING_PANE_FOCUS_TTL_MS = 1_500;

export function requestThreadPaneFocus(paneId: ThreadPaneId): void {
  pendingPaneFocus = { paneId, expiresAt: Date.now() + PENDING_PANE_FOCUS_TTL_MS };
}

export function cancelPendingThreadPaneFocus(): void {
  pendingPaneFocus = null;
}

/**
 * Called from a pane's focus-capture. Returns true when the focus event was
 * a stray restore into the wrong pane and has been re-routed — the caller
 * must then leave the active pane unchanged.
 */
export function redirectStrayThreadPaneFocus(focusedPaneId: ThreadPaneId): boolean {
  const pending = pendingPaneFocus;
  if (pending === null) {
    return false;
  }
  pendingPaneFocus = null;
  if (Date.now() > pending.expiresAt || pending.paneId === focusedPaneId) {
    return false;
  }
  focusThreadPane(pending.paneId);
  return true;
}

function focusThreadPane(paneId: ThreadPaneId): void {
  const runtime = paneRuntimes[paneId];
  const lastFocused = runtime.lastFocused;
  if (lastFocused && lastFocused.isConnected) {
    lastFocused.focus();
    // A connected element can still refuse focus (disabled, hidden, inert);
    // fall through to the composer or root instead of leaving focus behind.
    if (document.activeElement === lastFocused) {
      return;
    }
  }
  if (runtime.composer?.current) {
    runtime.composer.current.focusAtEnd();
    return;
  }
  runtime.root?.focus();
}

/**
 * The composer that overlay actions (palette inserts, close-time focus)
 * should target: the secondary pane's while it is rendered and active, null
 * otherwise — callers fall back to the app-root (primary) handle.
 */
export function activeThreadPaneComposerHandle(): ComposerHandleRef | null {
  const state = useThreadSplitStore.getState();
  if (!state.splitMounted || state.activePaneId !== "secondary") {
    return null;
  }
  return paneRuntimes.secondary.composer;
}

/**
 * Overlay close hook (command palette): return focus to the active pane.
 * Falls through to the pane root when it shows a composer-less notice, so
 * dismissing an overlay never silently hands ownership to the other pane.
 * Returns false when the primary/app-root composer is the right target
 * anyway, so callers can keep their default.
 */
export function focusActiveThreadPane(): boolean {
  const state = useThreadSplitStore.getState();
  if (!state.splitMounted || state.activePaneId !== "secondary") {
    return false;
  }
  focusThreadPane("secondary");
  return true;
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

/**
 * Make a pane active and hand it focus. Used when a sidebar click or palette
 * pick targets a thread that is already on screen: nothing navigates, so the
 * pane must be activated explicitly. The focus intent covers the palette case
 * (the closing dialog's focus restore would otherwise bounce activation back);
 * the direct focus covers the sidebar case, where no overlay close follows.
 */
export function activateThreadPane(paneId: ThreadPaneId): void {
  requestThreadPaneFocus(paneId);
  useThreadSplitStore.getState().setActivePane(paneId);
  focusThreadPane(paneId);
}

/**
 * The pane that owned focus when the command palette opened. Thread picks
 * must target this snapshot, not the live active pane: the dialog's own
 * focus juggling (close-time restores, list focus) can move the live value
 * while the palette is open.
 */
let paletteOwnerPaneId: ThreadPaneId = "primary";

export function capturePaletteOwnerPane(): void {
  paletteOwnerPaneId = useThreadSplitStore.getState().activePaneId;
}

export function paletteOwnerPane(): ThreadPaneId {
  return paletteOwnerPaneId;
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
