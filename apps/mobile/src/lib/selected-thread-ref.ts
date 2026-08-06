import type { NavigationState } from "@react-navigation/native";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

// Routes presented as sheets/overlays ON TOP of the workspace. They must not
// influence the adaptive workspace layout: opening Settings over Home should
// not flip the sidebar in or change the active thread.
export const WORKSPACE_OVERLAY_ROUTES = new Set([
  "ConnectOnboarding",
  "Connections",
  "ConnectionsNew",
  "GitBranches",
  "GitCommit",
  "GitConfirm",
  "GitOverview",
  "NewTaskSheet",
  "SettingsLegal",
  "SettingsSheet",
  "ThreadReviewComment",
]);

// Overlay routes that are still scoped to a thread (linked under
// THREAD_LINKING_PREFIX and carrying environmentId/threadId params). They
// must not affect the adaptive workspace layout — hence membership in
// WORKSPACE_OVERLAY_ROUTES above — but they DO identify which thread is
// selected: a deep link or restored stack can land on one of these with no
// underlying "Thread" route present at all, and the selected thread ref
// must still resolve from the overlay's own params in that case.
const THREAD_SCOPED_OVERLAY_ROUTES = new Set([
  "GitBranches",
  "GitCommit",
  "GitConfirm",
  "GitOverview",
  "ThreadReviewComment",
]);

/**
 * Routes relevant for deriving the selected thread ref: every non-overlay
 * route, plus thread-scoped overlays (which carry their own thread params
 * even though they're excluded from the workspace layout).
 */
function threadRefRoutes(state: NavigationState) {
  return state.routes.filter(
    (route) =>
      !WORKSPACE_OVERLAY_ROUTES.has(route.name) || THREAD_SCOPED_OVERLAY_ROUTES.has(route.name),
  );
}

function firstRouteParam(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") return null;
  const trimmed = first.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function selectedWorkspaceThreadRef(state: NavigationState): ScopedThreadRef | null {
  const route = threadRefRoutes(state).at(-1);
  const params = route?.params as Record<string, unknown> | undefined;
  const environmentId = firstRouteParam(params?.environmentId);
  const threadId = firstRouteParam(params?.threadId);
  if (environmentId === null || threadId === null) return null;
  try {
    return {
      environmentId: EnvironmentId.make(environmentId),
      threadId: ThreadId.make(threadId),
    };
  } catch {
    return null;
  }
}
