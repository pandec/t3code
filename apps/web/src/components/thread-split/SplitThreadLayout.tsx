import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { ComposerHandleContext, useComposerHandleContext } from "../../composerHandleContext";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { ServerThreadPaneHost } from "./ServerThreadPaneHost";
import { ThreadPaneContext } from "./threadPaneContext";
import {
  clampSplitRatio,
  noteThreadPaneFocus,
  reclaimThreadPaneFocus,
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
  // secondary's thread means it "moved" there, so the split closes.
  useEffect(() => {
    if (
      secondaryRef !== null &&
      routeThreadRef !== null &&
      scopedThreadKey(routeThreadRef) === scopedThreadKey(secondaryRef)
    ) {
      closeSplit();
    }
  }, [closeSplit, routeThreadRef, secondaryRef]);

  const splitOpen = secondaryRef !== null && isWideEnoughForSplit;

  return (
    <SplitThreadPanes secondaryRef={splitOpen ? secondaryRef : null}>{children}</SplitThreadPanes>
  );
}

function SplitThreadPanes({
  children,
  secondaryRef,
}: {
  children: ReactNode;
  secondaryRef: ScopedThreadRef | null;
}) {
  const splitRatio = useThreadSplitStore((state) => state.splitRatio);
  const setSplitMounted = useThreadSplitStore((state) => state.setSplitMounted);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const splitOpen = secondaryRef !== null;

  // splitMounted is the store's single source of truth for "two panes are on
  // screen"; every active-pane gate reads it, so it must track the rendered
  // state exactly — including this layout unmounting on a non-chat route.
  useEffect(() => {
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
      {splitOpen ? <SplitResizeHandle containerRef={containerRef} /> : null}
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
        setActivePane(paneId);
        reclaimThreadPaneFocus(paneId);
      }}
      onFocusCapture={(event) => {
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
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const setSplitRatio = useThreadSplitStore((state) => state.setSplitRatio);
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

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="relative z-40 h-full w-1 shrink-0 cursor-col-resize bg-border/60 hover:bg-primary/40 data-[dragging=true]:bg-primary/60"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const container = containerRef.current;
        if (!container) return;
        const bounds = container.getBoundingClientRect();
        if (bounds.width <= 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = "true";
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
        delete event.currentTarget.dataset.dragging;
        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        setSplitRatio(dragState.ratio);
      }}
      onPointerCancel={(event) => {
        dragStateRef.current = null;
        delete event.currentTarget.dataset.dragging;
        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        // Snap back to the committed ratio.
        applyRatio(useThreadSplitStore.getState().splitRatio);
      }}
    />
  );
}
