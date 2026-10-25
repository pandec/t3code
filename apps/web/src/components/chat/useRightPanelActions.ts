import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { Dispatch } from "react";
import type { ThreadPreviewState } from "../../previewStateStore";
import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { isAbsolutePath } from "@t3tools/shared/path";
import { useNavigate } from "@tanstack/react-router";
import { copyFilePathToClipboard, type FilePathCopyKind } from "~/fileContextMenu";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useThreadPaneId } from "../thread-split/threadPaneContext";
import {
  closeActiveThreadPane,
  isThreadPaneActive,
  useThreadSplitStore,
} from "../thread-split/threadSplitStore";
import { resolveExplicitDiffOpenOnActivate } from "../ChatView.logic";
import { useStableCallback } from "../../hooks/useStableCallback";
import { type ScopedThreadRef, type RunId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type SetStateAction, useEffect } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useDiffPanelStore } from "../../diffPanelStore";
import { type ThreadPanelPresentation } from "../../rightPanelLayout";
import {
  selectActiveRightPanel,
  type RightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { setActivePreviewTab } from "../../previewStateStore";
import { BrowserSettingsReadError } from "../../browser/openFileInPreview";
import { addBrowserSurface } from "../preview/addBrowserSurface";
import { subscribePreviewAction } from "../preview/previewActionBus";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import type { threadPullRequestPanelTarget } from "../pullRequest/pullRequestDetail.logic";
import type { useDeviceState } from "../../state/device";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { openDeviceSetupDialog } from "./ChatOverlayHosts";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatShortcutCommands } from "./useChatShortcuts";
interface RightPanelActionsInput {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeProject: EnvironmentProject | null;
  readonly activeRightPanelSurface: RightPanelSurface | null;
  readonly activePreviewState: ThreadPreviewState;
  readonly deviceState: ReturnType<typeof useDeviceState>["state"];
  readonly pullRequestPanelTarget: ReturnType<typeof threadPullRequestPanelTarget> | null;
  readonly threadPanelPresentation: ThreadPanelPresentation;
  readonly isServerThread: boolean;
  readonly isGitRepo: boolean;
  readonly browserAvailable: boolean;
  readonly canOperatePreview: boolean;
  readonly diffOpen: boolean;
  readonly previewPanelOpen: boolean;
  readonly rightPanelOpen: boolean;
  readonly canMaximizeRightPanel: boolean;
  readonly rightPanelMaximized: boolean;
  readonly supportsPullRequests: boolean;
  readonly pullRequestsSurfaceAvailable: boolean;
  readonly activeWorkspaceRoot: string | undefined;
  readonly activeThreadKey: string | null;
  readonly threadSplitActive: boolean;
  readonly explicitDiffOpenRef: { current: ScopedThreadRef | null };
  readonly setTerminalFocusRequestId: Dispatch<SetStateAction<number>>;
  readonly onDiffPanelOpen: (() => void) | undefined;
  readonly closeRightPanelSurface: (surface: RightPanelSurface) => void;
}

/**
 * Opening, closing, and arranging the right panel's surfaces: browser, diff, files, pull
 * requests, device, and terminal tabs.
 */
export function useRightPanelActions(input: RightPanelActionsInput) {
  const {
    closeRightPanelSurface,
    activeThreadRef,
    activeProject,
    activeRightPanelSurface,
    activePreviewState,
    deviceState,
    pullRequestPanelTarget,
    threadPanelPresentation,
    isServerThread,
    isGitRepo,
    browserAvailable,
    canOperatePreview,
    diffOpen,
    previewPanelOpen,
    rightPanelOpen,
    canMaximizeRightPanel,
    rightPanelMaximized,
    supportsPullRequests,
    pullRequestsSurfaceAvailable,
    activeWorkspaceRoot,
    activeThreadKey,
    threadSplitActive,
    explicitDiffOpenRef,
    setTerminalFocusRequestId,
    onDiffPanelOpen,
  } = input;

  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const navigate = useNavigate();
  const threadPaneId = useThreadPaneId();
  const onToggleDiff = () => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
    }
    if (activeThreadRef) {
      useRightPanelStore.getState().toggle(activeThreadRef, "diff");
    }
  };
  const onToggleDiffStable = useStableCallback(onToggleDiff);
  const createBrowserSurface = (profileId?: string) => {
    if (!activeThreadRef || !canOperatePreview) return;
    void addBrowserSurface({
      threadRef: activeThreadRef,
      openPreview,
      ...(profileId === undefined ? {} : { profileId }),
    }).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      if (error instanceof BrowserSettingsReadError) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open browser",
            description: error.message,
          }),
        );
      }
    });
  };
  const createBrowserSurfaceStable = useStableCallback(createBrowserSurface);
  const addDiffSurface = () => {
    if (!activeThreadRef || !isServerThread || !isGitRepo) return;
    useDiffPanelStore.getState().selectGitScope(activeThreadRef, "branch");
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  };
  const addDiffSurfaceStable = useStableCallback(addDiffSurface);
  const openChangesFromThreadPanel = () => {
    addDiffSurface();
  };
  const openChangesFromThreadPanelStable = useStableCallback(openChangesFromThreadPanel);
  const addFilesSurface = () => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().open(activeThreadRef, "files");
  };
  const addFilesSurfaceStable = useStableCallback(addFilesSurface);
  const addPullRequestsSurface = () => {
    if (!activeThreadRef || !pullRequestsSurfaceAvailable) return;
    useRightPanelStore.getState().open(activeThreadRef, "pull-requests");
  };
  const addPullRequestsSurfaceStable = useStableCallback(addPullRequestsSurface);
  const addDeviceSurface = () => {
    if (!activeThreadRef) return;
    if (!deviceState.onboardingCompleted || deviceState.hostStatus === "disabled") {
      openDeviceSetupDialog(scopedThreadKey(activeThreadRef));
      return;
    }
    useRightPanelStore.getState().open(activeThreadRef, "device");
  };
  const addDeviceSurfaceStable = useStableCallback(addDeviceSurface);
  const openFileSurface = (relativePath: string) => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().openFile(activeThreadRef, relativePath);
  };
  const openFileSurfaceStable = useStableCallback(openFileSurface);
  const closePreviewPanel = () => {
    if (activeThreadRef) {
      if (activeRightPanelSurface?.kind === "preview" && activeRightPanelSurface.resourceId) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadRef, browserMiniPlayerSource(activeRightPanelSurface.resourceId));
      } else if (activeRightPanelSurface?.kind === "device" && activeRightPanelSurface.target) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadRef, { kind: "device", ...activeRightPanelSurface.target });
      }
      useRightPanelStore.getState().setMaximized(activeThreadRef, false);
      useRightPanelStore.getState().close(activeThreadRef);
    }
  };
  const closePreviewPanelStable = useStableCallback(closePreviewPanel);
  // Split view (fork): both panes' sheets share the right edge, so a claim from
  // the other pane closes this one. A claim for the same thread (both panes show
  // it mid swap) must not close it, since panel state is per thread.
  useEffect(() => {
    if (!threadSplitActive || !rightPanelOpen || activeThreadKey === null) return;
    useThreadSplitStore
      .getState()
      .claimSplitSheet({ paneId: threadPaneId, threadKey: activeThreadKey });
    return useThreadSplitStore.subscribe((state) => {
      const owner = state.splitSheetOwner;
      if (owner === null || owner.paneId === threadPaneId) return;
      if (owner.threadKey !== activeThreadKey) closePreviewPanelStable();
    });
  }, [activeThreadKey, closePreviewPanelStable, rightPanelOpen, threadPaneId, threadSplitActive]);
  const togglePreviewPanel = () => {
    if (!activeThreadRef || !browserAvailable) return;
    if (previewPanelOpen) {
      closePreviewPanel();
      return;
    }
    if (!canOperatePreview) return;
    const activeTabId = activePreviewState.activeTabId;
    if (activeTabId) {
      useRightPanelStore.getState().openBrowser(activeThreadRef, activeTabId);
    } else {
      createBrowserSurface();
    }
  };
  const togglePreviewPanelStable = useStableCallback(togglePreviewPanel);
  const activateRightPanelSurface = (surface: RightPanelSurface) => {
    if (!activeThreadRef) return;
    explicitDiffOpenRef.current = resolveExplicitDiffOpenOnActivate({
      surfaceKind: surface.kind,
      diffOpen,
      activeThreadRef,
    });
    useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
    if (surface.kind === "preview" && surface.resourceId) {
      setActivePreviewTab(activeThreadRef, surface.resourceId);
    }
    if (surface.kind === "terminal") {
      setTerminalFocusRequestId((value) => value + 1);
    }
    if (surface.kind === "diff" && !diffOpen) {
      onDiffPanelOpen?.();
    }
  };
  const activateRightPanelSurfaceStable = useStableCallback(activateRightPanelSurface);
  const toggleRightPanel = () => {
    if (!activeThreadRef) return;
    if (rightPanelOpen) {
      closePreviewPanel();
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
  };
  const toggleRightPanelStable = useStableCallback(toggleRightPanel);
  const toggleThreadPanel = () => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().toggleThreadPanel(activeThreadRef, threadPanelPresentation);
  };
  const toggleThreadPanelStable = useStableCallback(toggleThreadPanel);
  const toggleRightPanelMaximized = () => {
    if (!canMaximizeRightPanel || !activeThreadRef) return;
    useRightPanelStore.getState().setMaximized(activeThreadRef, !rightPanelMaximized);
  };
  const toggleRightPanelMaximizedStable = useStableCallback(toggleRightPanelMaximized);
  const moveRightPanelSurface = (surfaceId: string, toIndex: number) => {
    if (activeThreadRef)
      useRightPanelStore.getState().moveSurface(activeThreadRef, surfaceId, toIndex);
  };
  const moveRightPanelSurfaceStable = useStableCallback(moveRightPanelSurface);
  const copyRightPanelFilePath = (relativePath: string, kind: FilePathCopyKind) => {
    // A host file's path is already full. Anything else needs the workspace
    // root; joining onto an empty root would fabricate a path from `/`.
    if (kind === "relative" || isAbsolutePath(relativePath)) {
      const hostPath =
        activeWorkspaceRoot === undefined
          ? relativePath
          : resolvePathLinkTarget(relativePath, activeWorkspaceRoot);
      void copyFilePathToClipboard(formatFilePathForClipboard(relativePath, hostPath), kind);
      return;
    }
    if (activeWorkspaceRoot === undefined) {
      toastManager.add({
        type: "error",
        title: "Failed to copy full path",
        description: "The project root is not loaded yet.",
      });
      return;
    }
    void copyFilePathToClipboard(
      formatFilePathForClipboard(resolvePathLinkTarget(relativePath, activeWorkspaceRoot)),
      kind,
    );
  };
  const copyRightPanelFilePathStable = useStableCallback(copyRightPanelFilePath);
  const addPullRequestSurface = () => {
    if (!supportsPullRequests || activeThreadRef === null || pullRequestPanelTarget === null)
      return;
    useRightPanelStore.getState().openPullRequest(activeThreadRef, pullRequestPanelTarget);
  };
  const addPullRequestSurfaceStable = useStableCallback(addPullRequestSurface);
  const onOpenTurnDiff = (runId: RunId, filePath?: string) => {
    if (!isServerThread || !activeThreadRef) return;
    const diffOpen =
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, activeThreadRef) === "diff";
    explicitDiffOpenRef.current = diffOpen ? null : activeThreadRef;
    useDiffPanelStore.getState().selectTurn(activeThreadRef, runId, filePath);
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  };
  const onOpenTurnDiffStable = useStableCallback(onOpenTurnDiff);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        // The bus is untargeted; with the split open only the active pane
        // reacts, or one shortcut would toggle previews in both panes.
        if (!isThreadPaneActive(threadPaneId)) return;
        if (action === "toggle-panel") togglePreviewPanelStable();
      }),
    [threadPaneId, togglePreviewPanelStable],
  );

  const shortcuts = {
    "rightPanel.toggle": () => toggleRightPanel(),
    "rightPanel.toggleMaximized": ({ event }) => {
      if (!event.repeat) toggleRightPanelMaximized();
    },
    "threadPanel.toggle": () => toggleThreadPanel(),
    "rightPanel.close": ({ event }) => {
      if (!activeRightPanelSurface) {
        // Nothing open in the panel: while split, close this pane's thread
        // and keep the other one; otherwise leave the event alone so the
        // shortcut keeps its native meaning (close window on desktop,
        // close tab in a browser).
        const closedPane = closeActiveThreadPane((ref) =>
          navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) }),
        );
        if (!closedPane) return false;
        // Immediate: closing the secondary activates the primary pane
        // synchronously, and its window listener must not also act on
        // this keypress (e.g. close a terminal it just refocused).
        event.stopImmediatePropagation();
        return;
      }
      if (!event.repeat) closeRightPanelSurface(activeRightPanelSurface);
    },
    "diff.toggle": () => onToggleDiff(),
  } satisfies ChatShortcutCommands;

  return {
    shortcuts,
    activateRightPanelSurfaceStable,
    addDeviceSurfaceStable,
    addDiffSurfaceStable,
    addFilesSurfaceStable,
    addPullRequestSurfaceStable,
    addPullRequestsSurfaceStable,
    closePreviewPanelStable,
    copyRightPanelFilePathStable,
    createBrowserSurface,
    createBrowserSurfaceStable,
    moveRightPanelSurfaceStable,
    onOpenTurnDiffStable,
    onToggleDiffStable,
    openChangesFromThreadPanelStable,
    openFileSurfaceStable,
    toggleRightPanelMaximizedStable,
    toggleRightPanelStable,
    toggleThreadPanelStable,
  };
}
