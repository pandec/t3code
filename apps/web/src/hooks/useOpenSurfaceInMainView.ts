import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { type LinkedThreadSurface, linkedThreadRouteParams } from "../linkedThreadSurface";
import { type ThreadSurface, useRightPanelStore } from "../rightPanelStore";
import { useOpenThreadInPane } from "../components/thread-split/useOpenThreadInPane";

/**
 * Moves a side thread's tab from `panelRef`'s panel to its pane's main view. The tab closes,
 * without the cleanup Close does, so the way back does not show the thread beside itself.
 */
export function useOpenSurfaceInMainView(panelRef: ScopedThreadRef | null) {
  const navigate = useNavigate();
  const openThreadInPane = useOpenThreadInPane();
  return (surface: ThreadSurface | LinkedThreadSurface) => {
    if (panelRef === null) return;
    useRightPanelStore.getState().closeSurface(panelRef, surface.id);
    if (surface.kind === "linked-thread") {
      void navigate({
        to: "/linked/$viaEnvironmentId/$linkedEnvironmentId/$linkedThreadId",
        params: linkedThreadRouteParams(surface),
      });
      return;
    }
    openThreadInPane(scopeThreadRef(panelRef.environmentId, surface.threadId));
  };
}
