import type { WorkspaceState } from "../../state/workspaceModel";

export function isWorkspaceConnectionSynchronizing(state: WorkspaceState): boolean {
  return (
    state.networkStatus !== "offline" &&
    state.connectionError === null &&
    (state.connectingEnvironments.length > 0 || state.hasPendingShellSnapshot)
  );
}

export function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  return (
    state.networkStatus === "offline" ||
    state.connectionError !== null ||
    state.hasConnectingEnvironment ||
    state.hasPendingShellSnapshot ||
    (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
  );
}

export function workspaceConnectionStatusLabel(state: WorkspaceState): string {
  if (state.networkStatus === "offline") return "You are offline";
  if (state.connectionError !== null) return state.connectionError;
  if (state.connectingEnvironments.length === 1) {
    return `Reconnecting to ${state.connectingEnvironments[0]!.environmentLabel}`;
  }
  if (state.connectingEnvironments.length > 1) {
    return `Reconnecting ${state.connectingEnvironments.length} environments`;
  }
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot ? "Syncing threads..." : "Loading threads...";
  }
  return "Not connected";
}

export function workspaceConnectionStatusShortLabel(state: WorkspaceState): string {
  if (state.networkStatus === "offline") return "Offline";
  if (state.connectionError !== null) return "Connection issue";
  if (state.connectingEnvironments.length > 0) return "Reconnecting…";
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot ? "Syncing…" : "Loading…";
  }
  return "Not connected";
}

export interface WorkspaceConnectionStatusPresentation {
  readonly fullLabel: string;
  readonly shortLabel: string;
  readonly synchronizing: boolean;
}

export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
): WorkspaceConnectionStatusPresentation {
  return {
    fullLabel: workspaceConnectionStatusLabel(state),
    shortLabel: workspaceConnectionStatusShortLabel(state),
    synchronizing: isWorkspaceConnectionSynchronizing(state),
  };
}
