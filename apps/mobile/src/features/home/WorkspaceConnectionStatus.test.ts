import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceState } from "../../state/workspaceModel";
import {
  isWorkspaceConnectionSynchronizing,
  shouldShowWorkspaceConnectionStatus,
  workspaceConnectionStatusLabel,
  workspaceConnectionStatusPresentation,
  workspaceConnectionStatusShortLabel,
} from "./workspace-connection-status";

function workspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasConnections: true,
    hasLoadedShellSnapshot: true,
    hasPendingShellSnapshot: false,
    hasReadyEnvironment: true,
    hasConnectingEnvironment: false,
    connectingEnvironments: [],
    connectionState: "connected",
    connectionError: null,
    shellSnapshotError: null,
    latestCachedSnapshotReceivedAt: null,
    networkStatus: "online",
    ...overrides,
  };
}

describe("workspace connection status", () => {
  it("stays hidden while a ready environment is connected", () => {
    expect(shouldShowWorkspaceConnectionStatus(workspaceState())).toBe(false);
  });

  it("surfaces offline snapshots", () => {
    const state = workspaceState({ networkStatus: "offline", hasReadyEnvironment: false });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state)).toBe("You are offline");
    expect(workspaceConnectionStatusShortLabel(state)).toBe("Offline");
    expect(isWorkspaceConnectionSynchronizing(state)).toBe(false);
  });

  it("names the environment while reconnecting", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      hasReadyEnvironment: false,
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "Julius’s Mac mini",
          displayUrl: "",
          isRelayManaged: false,
          connectionState: "reconnecting",
          connectionError: null,
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state)).toBe("Reconnecting to Julius’s Mac mini");
    expect(workspaceConnectionStatusShortLabel(state)).toBe("Reconnecting…");
    expect(isWorkspaceConnectionSynchronizing(state)).toBe(true);
  });

  it("surfaces connection errors before the generic disconnected fallback", () => {
    const state = workspaceState({
      connectionError: "Could not reach Julius’s Mac mini",
      hasLoadedShellSnapshot: false,
      hasReadyEnvironment: false,
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state)).toBe("Could not reach Julius’s Mac mini");
    expect(workspaceConnectionStatusShortLabel(state)).toBe("Connection issue");
    expect(isWorkspaceConnectionSynchronizing(state)).toBe(false);
  });

  it("shows shell catch-up while cached threads remain visible", () => {
    const state = workspaceState({ hasPendingShellSnapshot: true });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state)).toBe("Syncing threads...");
    expect(workspaceConnectionStatusShortLabel(state)).toBe("Syncing…");
    expect(isWorkspaceConnectionSynchronizing(state)).toBe(true);
  });

  it("distinguishes initial shell loading from cached catch-up", () => {
    const state = workspaceState({
      hasLoadedShellSnapshot: false,
      hasPendingShellSnapshot: true,
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state)).toBe("Loading threads...");
    expect(workspaceConnectionStatusShortLabel(state)).toBe("Loading…");
  });

  it("uses a compact disconnected fallback without exposing raw errors", () => {
    const connectionError = "Authentication failed with private account details";
    const state = workspaceState({
      connectionError,
      hasReadyEnvironment: false,
    });

    expect(workspaceConnectionStatusShortLabel(state)).toBe("Connection issue");
    expect(workspaceConnectionStatusShortLabel(state)).not.toContain(connectionError);
  });

  it("prioritizes an error consistently when another environment is reconnecting", () => {
    const connectionError = "Could not reach Space Mac";
    const state = workspaceState({
      connectionError,
      hasConnectingEnvironment: true,
      hasReadyEnvironment: false,
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "Grey Mac",
          displayUrl: "",
          isRelayManaged: false,
          connectionState: "reconnecting",
          connectionError: null,
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      fullLabel: connectionError,
      shortLabel: "Connection issue",
      synchronizing: false,
    });
  });
});
