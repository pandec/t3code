import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams, type HistoryState } from "@tanstack/react-router";
import { useCallback, useMemo, type MouseEvent } from "react";

import { buildThreadRouteParams, resolveThreadRouteRef } from "../../threadRoutes";
import {
  openThreadInActivePane,
  threadOpenHashRouteRef,
  type ThreadOpenResult,
} from "./threadOpenTarget";
import { useThreadPaneId } from "./threadPaneContext";

/** A URL hash to land with the opened thread; see threadOpenHashRouteRef. */
export interface ThreadOpenHash {
  hash: string;
  state?: HistoryState;
}

/**
 * Open a thread from inside a pane (fork feature): it lands in the pane the
 * action came from, or focuses the pane already showing it, instead of always
 * replacing the primary route.
 */
export function useOpenThreadInPane(): (
  targetRef: ScopedThreadRef,
  withHash?: ThreadOpenHash,
) => ThreadOpenResult {
  const navigate = useNavigate();
  const paneId = useThreadPaneId();
  // The router's (primary) thread, not the pane's own.
  const { environmentId, threadId } = useParams({ strict: false });
  const routeThreadRef = useMemo(
    () => resolveThreadRouteRef({ environmentId, threadId }),
    [environmentId, threadId],
  );
  return useCallback(
    (targetRef: ScopedThreadRef, withHash?: ThreadOpenHash) => {
      const navigateWithHash = (ref: ScopedThreadRef) =>
        navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(ref),
          ...(withHash
            ? {
                hash: withHash.hash,
                resetScroll: false,
                ...(withHash.state ? { state: withHash.state } : {}),
              }
            : {}),
        });
      const result = openThreadInActivePane({
        targetRef,
        routeThreadRef,
        paneOverride: paneId,
        navigateToPrimary: () => navigateWithHash(targetRef),
      });
      if (withHash && result.plan.kind !== "navigate-primary") {
        const hashRouteRef = threadOpenHashRouteRef({
          plan: result.plan,
          targetRef,
          routeThreadRef,
        });
        if (hashRouteRef) void navigateWithHash(hashRouteRef);
      }
      return result;
    },
    [navigate, paneId, routeThreadRef],
  );
}

/**
 * Click handler for an in-app thread link: a plain click opens the thread in
 * this pane like useOpenThreadInPane; modified clicks keep the link's own
 * new-tab and new-window behavior.
 */
export function useThreadLinkClick(
  targetRef: ScopedThreadRef | null,
): (event: MouseEvent<HTMLElement>) => void {
  const openThreadInPane = useOpenThreadInPane();
  return useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (
        targetRef === null ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      void openThreadInPane(targetRef);
    },
    [openThreadInPane, targetRef],
  );
}
