import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { buildThreadRouteParams, resolveThreadRouteRef } from "../../threadRoutes";
import { openThreadInActivePane, type ThreadOpenResult } from "./threadOpenTarget";
import { useThreadPaneId } from "./threadPaneContext";

/**
 * Open a thread from inside a pane (fork feature): it lands in the pane the
 * action came from, or focuses the pane already showing it, instead of always
 * replacing the primary route.
 */
export function useOpenThreadInPane(): (targetRef: ScopedThreadRef) => ThreadOpenResult {
  const navigate = useNavigate();
  const paneId = useThreadPaneId();
  // The router's (primary) thread, not the pane's own.
  const { environmentId, threadId } = useParams({ strict: false });
  const routeThreadRef = useMemo(
    () => resolveThreadRouteRef({ environmentId, threadId }),
    [environmentId, threadId],
  );
  return useCallback(
    (targetRef: ScopedThreadRef) =>
      openThreadInActivePane({
        targetRef,
        routeThreadRef,
        paneOverride: paneId,
        navigateToPrimary: () =>
          navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(targetRef) }),
      }),
    [navigate, paneId, routeThreadRef],
  );
}
