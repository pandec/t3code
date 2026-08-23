import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ArrowLeftRightIcon, ReplaceIcon, XIcon } from "lucide-react";

import { openCommandPalette } from "../../commandPaletteBus";
import { ComposerHandleContext, useComposerHandleContext } from "../../composerHandleContext";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../../threadRoutes";
import { swapThreadPanes } from "./swapThreadPanes";
import { ServerThreadPaneHost } from "./ServerThreadPaneHost";
import { shouldCloseSplitForRoute } from "./threadOpenTarget";
import { ThreadPaneContext } from "./threadPaneContext";
import { PaneControlButton } from "./ThreadPaneControls";
import {
  activateThreadPane,
  cancelPendingThreadPaneFocus,
  clampSplitRatio,
  noteThreadPaneFocus,
  reclaimThreadPaneFocus,
  redirectStrayThreadPaneFocus,
  registerThreadPaneComposer,
  registerThreadPaneRoot,
  THREAD_SPLIT_MEDIA_QUERY,
  useThreadSplitStore,
  type ThreadPaneId,
} from "./threadSplitStore";

// The 20rem pane floor yields to a percentage in narrow containers (the grid
// sits beside a user-resizable sidebar), so the tracks can never overflow the
// clipped grid root and push the secondary pane off-screen.
const SPLIT_GRID_TEMPLATE_COLUMNS =
  "minmax(min(20rem, 45%), var(--thread-split-a)) auto minmax(min(20rem, 45%), var(--thread-split-b))";
const SINGLE_GRID_TEMPLATE_COLUMNS = "minmax(0, 1fr)";

// Module-level so route changes made while the chat layout is unmounted
// (e.g. picking another thread from Settings) still register as a change on
// remount — a component ref would re-initialize and miss them.
const UNOBSERVED_ROUTE_THREAD_KEY = Symbol("unobserved");
const lastSeenRouteThreadKey: { value: string | null | typeof UNOBSERVED_ROUTE_THREAD_KEY } = {
  value: UNOBSERVED_ROUTE_THREAD_KEY,
};

/**
 * Wraps the chat routes' content. The tree shape is identical whether the
 * split is open or closed — only the separator and the secondary pane mount
 * and unmount — so toggling the split never remounts the routed ChatView
 * instance. (Its right panel still remounts on toggle: the split forces the
 * sheet presentation, which lives in a different tree position than the
 * inline one.) No diff worker pool is hoisted here on purpose: the pool is a
 * module singleton, so both panes' ChatView-level providers already share it.
 */
export function SplitThreadLayout({ children }: { children: ReactNode }) {
  const secondaryRef = useThreadSplitStore((state) => state.secondaryRef);
  const closeSplit = useThreadSplitStore((state) => state.closeSplit);
  const isWideEnoughForSplit = useMediaQuery(THREAD_SPLIT_MEDIA_QUERY);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });

  // The primary composer handle is the app-root one (the secondary pane gets
  // its own provider below, so the root ref only ever belongs to the primary).
  const primaryComposerRef = useComposerHandleContext();
  useEffect(() => {
    registerThreadPaneComposer("primary", primaryComposerRef);
    return () => registerThreadPaneComposer("primary", null);
  }, [primaryComposerRef]);

  // No duplicate thread across panes: navigating the primary pane onto the
  // secondary's thread means it "moved" there, so the split closes — except
  // mid-swap, where that duplicate is a transient the latch vouches for. An
  // expired latch means the swap navigation never arrived; restoring the old
  // secondary is the better degraded outcome than folding the split.
  const pendingSwap = useThreadSplitStore((state) => state.pendingSwap);
  const abortPaneSwap = useThreadSplitStore((state) => state.abortPaneSwap);
  const routeThreadKey = routeThreadRef === null ? null : scopedThreadKey(routeThreadRef);
  useEffect(() => {
    const shouldClose = shouldCloseSplitForRoute({
      routeThreadKey,
      secondaryKey: secondaryRef === null ? null : scopedThreadKey(secondaryRef),
      pendingSwap,
      now: Date.now(),
    });
    if (!shouldClose) return;
    if (pendingSwap !== null) {
      abortPaneSwap();
      return;
    }
    closeSplit();
  }, [abortPaneSwap, closeSplit, pendingSwap, routeThreadKey, secondaryRef]);

  // A primary route change made outside both pane roots (sidebar, palette,
  // deep link) retargets the primary pane — attention (and shortcut
  // ownership, e.g. mod+shift+E archive) must follow, or the secondary pane
  // would keep swallowing thread-targeted shortcuts after the user switched
  // threads. A pane swap is the exception: the threads traded sides on
  // purpose, so the side the user was working on keeps its activation.
  useEffect(() => {
    if (lastSeenRouteThreadKey.value === routeThreadKey) return;
    const isFirstObservation = lastSeenRouteThreadKey.value === UNOBSERVED_ROUTE_THREAD_KEY;
    lastSeenRouteThreadKey.value = routeThreadKey;
    if (isFirstObservation) return;
    const state = useThreadSplitStore.getState();
    const pending = state.pendingSwap;
    if (pending !== null) {
      state.settlePaneSwap();
      if (routeThreadKey === pending.expectedRouteKey) return;
    }
    state.setActivePane("primary");
  }, [routeThreadKey]);

  const splitOpen = secondaryRef !== null && isWideEnoughForSplit;

  return (
    <SplitThreadPanes
      secondaryRef={splitOpen ? secondaryRef : null}
      routeThreadRef={routeThreadRef}
    >
      {children}
    </SplitThreadPanes>
  );
}

function SplitThreadPanes({
  children,
  secondaryRef,
  routeThreadRef,
}: {
  children: ReactNode;
  secondaryRef: ScopedThreadRef | null;
  routeThreadRef: ScopedThreadRef | null;
}) {
  const splitRatio = useThreadSplitStore((state) => state.splitRatio);
  const setSplitMounted = useThreadSplitStore((state) => state.setSplitMounted);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const splitOpen = secondaryRef !== null;

  // splitMounted is the store's single source of truth for "two panes are on
  // screen"; every active-pane gate reads it, so it must track the rendered
  // state exactly — including this layout unmounting on a non-chat route.
  // Layout effect on purpose: a passive effect would leave a stale-true
  // window after the secondary pane is removed from the tree, during which
  // the only visible pane still rejects shortcuts.
  useLayoutEffect(() => {
    setSplitMounted(splitOpen);
    return () => setSplitMounted(false);
  }, [setSplitMounted, splitOpen]);

  return (
    <div
      ref={containerRef}
      className="grid h-full min-h-0 min-w-0 flex-1 overflow-hidden"
      data-thread-split-root={splitOpen ? "open" : "closed"}
      style={
        {
          gridTemplateColumns: splitOpen
            ? SPLIT_GRID_TEMPLATE_COLUMNS
            : SINGLE_GRID_TEMPLATE_COLUMNS,
          "--thread-split-a": `${splitRatio}fr`,
          "--thread-split-b": `${1 - splitRatio}fr`,
        } as React.CSSProperties
      }
    >
      <ThreadPaneSection paneId="primary" showActiveIndicator={splitOpen}>
        {children}
      </ThreadPaneSection>
      {splitOpen ? (
        <SplitResizeHandle containerRef={containerRef} routeThreadRef={routeThreadRef} />
      ) : null}
      {secondaryRef !== null ? (
        <ThreadPaneSection paneId="secondary" showActiveIndicator>
          <ThreadPaneContext value="secondary">
            <SecondaryPaneComposerScope>
              <ServerThreadPaneHost threadRef={secondaryRef} />
            </SecondaryPaneComposerScope>
          </ThreadPaneContext>
        </ThreadPaneSection>
      ) : null}
    </div>
  );
}

function SecondaryPaneComposerScope({ children }: { children: ReactNode }) {
  // A fresh handle ref shields the secondary composer from the app-root
  // ComposerHandleContext, whose single ref would otherwise be claimed by
  // whichever ChatComposer mounted last.
  const composerRef = useRef<ChatComposerHandle | null>(null);
  useEffect(() => {
    registerThreadPaneComposer("secondary", composerRef);
    return () => registerThreadPaneComposer("secondary", null);
  }, []);
  return <ComposerHandleContext value={composerRef}>{children}</ComposerHandleContext>;
}

function ThreadPaneSection({
  children,
  paneId,
  showActiveIndicator,
}: {
  children: ReactNode;
  paneId: ThreadPaneId;
  showActiveIndicator: boolean;
}) {
  const isActive = useThreadSplitStore((state) => state.activePaneId === paneId);
  const setActivePane = useThreadSplitStore((state) => state.setActivePane);

  const attachRoot = useCallback(
    (element: HTMLElement | null) => {
      registerThreadPaneRoot(paneId, element);
    },
    [paneId],
  );

  return (
    <section
      ref={attachRoot}
      tabIndex={-1}
      data-thread-pane-id={paneId}
      data-active={isActive ? "true" : "false"}
      className="relative h-full min-h-0 min-w-0 outline-none"
      onPointerDownCapture={() => {
        // A real click is user intent — it beats any queued pane-focus grant.
        cancelPendingThreadPaneFocus();
        setActivePane(paneId);
        reclaimThreadPaneFocus(paneId);
      }}
      onFocusCapture={(event) => {
        if (redirectStrayThreadPaneFocus(paneId)) return;
        setActivePane(paneId);
        noteThreadPaneFocus(paneId, event.target);
      }}
    >
      {children}
      {showActiveIndicator && isActive ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-50 ring-1 ring-primary/25 ring-inset"
        />
      ) : null}
    </section>
  );
}

function SplitResizeHandle({
  containerRef,
  routeThreadRef,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  routeThreadRef: ScopedThreadRef | null;
}) {
  const setSplitRatio = useThreadSplitStore((state) => state.setSplitRatio);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    ratio: number;
    // Captured once at pointerdown: reading getBoundingClientRect per
    // pointermove would force a synchronous layout of both panes on every
    // move, defeating the rAF write coalescing below.
    boundsLeft: number;
    boundsWidth: number;
  } | null>(null);
  const frameRef = useRef<number | null>(null);

  const applyRatio = useCallback(
    (ratio: number) => {
      const container = containerRef.current;
      if (!container) return;
      container.style.setProperty("--thread-split-a", `${ratio}fr`);
      container.style.setProperty("--thread-split-b", `${1 - ratio}fr`);
    },
    [containerRef],
  );

  const endDrag = useCallback(() => {
    delete wrapperRef.current?.dataset.dragging;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  // The wrapper is the visible 1px line and owns the grid track; the drag
  // surface is a wider invisible child so the divider is grabbable without
  // fattening the line. The control cluster is a sibling of the drag surface,
  // so its clicks can never start a drag, and data-dragging on the wrapper
  // hides the cluster while resizing so a drag can't end on a button.
  return (
    <div
      ref={wrapperRef}
      className="group/split-handle relative z-40 h-full w-1 shrink-0 bg-border/60 hover:bg-primary/40 data-[dragging=true]:bg-primary/60"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        className="absolute inset-y-0 -right-1 -left-1 cursor-col-resize"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const container = containerRef.current;
          if (!container) return;
          const bounds = container.getBoundingClientRect();
          if (bounds.width <= 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          if (wrapperRef.current) {
            wrapperRef.current.dataset.dragging = "true";
          }
          dragStateRef.current = {
            pointerId: event.pointerId,
            ratio: useThreadSplitStore.getState().splitRatio,
            boundsLeft: bounds.left,
            boundsWidth: bounds.width,
          };
        }}
        onPointerMove={(event) => {
          const dragState = dragStateRef.current;
          if (!dragState || dragState.pointerId !== event.pointerId) return;
          dragState.ratio = clampSplitRatio(
            (event.clientX - dragState.boundsLeft) / dragState.boundsWidth,
          );
          if (frameRef.current === null) {
            frameRef.current = window.requestAnimationFrame(() => {
              frameRef.current = null;
              const current = dragStateRef.current;
              if (current) applyRatio(current.ratio);
            });
          }
        }}
        onPointerUp={(event) => {
          const dragState = dragStateRef.current;
          if (!dragState || dragState.pointerId !== event.pointerId) return;
          dragStateRef.current = null;
          endDrag();
          setSplitRatio(dragState.ratio);
        }}
        onPointerCancel={() => {
          dragStateRef.current = null;
          endDrag();
          // Snap back to the committed ratio.
          applyRatio(useThreadSplitStore.getState().splitRatio);
        }}
      />
      <SplitPaneControls routeThreadRef={routeThreadRef} />
    </div>
  );
}

/**
 * Hover-revealed pane controls anchored near the top of the divider. They
 * live on the boundary instead of either pane's titlebar so they never cover
 * the header actions, and they read as owning the split rather than one
 * side. Reveal is a one-shot opacity transition (no continuous animation);
 * focus-within keeps the buttons reachable by keyboard.
 */
function SplitPaneControls({ routeThreadRef }: { routeThreadRef: ScopedThreadRef | null }) {
  const router = useRouter();
  const swapPending = useThreadSplitStore((state) => state.pendingSwap !== null);
  const closeSplit = useThreadSplitStore((state) => state.closeSplit);
  const swapEnabled = routeThreadRef !== null && !swapPending;

  return (
    <div
      data-thread-split-controls
      className="pointer-events-none absolute top-[calc(var(--workspace-topbar-height)+0.5rem)] left-1/2 z-50 flex -translate-x-1/2 flex-col gap-1 rounded-md border border-border bg-background p-1 opacity-0 shadow-sm transition-opacity [-webkit-app-region:no-drag] group-focus-within/split-handle:pointer-events-auto group-focus-within/split-handle:opacity-100 group-hover/split-handle:pointer-events-auto group-hover/split-handle:opacity-100 group-data-[dragging=true]/split-handle:pointer-events-none group-data-[dragging=true]/split-handle:opacity-0"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <PaneControlButton
        label={
          routeThreadRef === null ? "Swap split threads (needs two threads)" : "Swap split threads"
        }
        tooltipSide="right"
        disabled={!swapEnabled}
        onClick={() => {
          void swapThreadPanes({
            routeThreadRef,
            navigateToThread: (ref) =>
              router.navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(ref),
              }),
          }).then((swapped) => {
            // The click parked focus on this cluster button; hand it back to
            // the pane that owns the shortcuts.
            if (swapped) activateThreadPane(useThreadSplitStore.getState().activePaneId);
          });
        }}
      >
        <ArrowLeftRightIcon className="size-4" />
      </PaneControlButton>
      <PaneControlButton
        label="Switch split thread"
        tooltipSide="right"
        onClick={() => openCommandPalette({ open: "open-in-split" })}
      >
        <ReplaceIcon className="size-4" />
      </PaneControlButton>
      <PaneControlButton label="Close split view" tooltipSide="right" onClick={closeSplit}>
        <XIcon className="size-4" />
      </PaneControlButton>
    </div>
  );
}
