import { Outlet, createFileRoute, redirect, useParams, useRouter } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { ThreadRouteView } from "../components/ThreadRouteView";
import { useClientSettings, useLegacySidebarEnabled } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { readThreadShell, useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isEditableFocused } from "../lib/editableFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { undoLatestThreadAction } from "../hooks/showThreadUndoNotice";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { SplitThreadLayout } from "~/components/thread-split/SplitThreadLayout";
import { canSwapThreadPanes, swapThreadPanes } from "~/components/thread-split/swapThreadPanes";
import {
  focusOtherThreadPane,
  useThreadSplitStore,
} from "~/components/thread-split/threadSplitStore";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { hasOpenArchiveUndoBlockingLayer } from "../archiveUndo";
import { useThreadActions } from "../hooks/useThreadActions";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const router = useRouter();
  const { attemptArchiveThread } = useThreadActions();
  const projectGroupCount = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }).length,
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  // Split view: thread-targeted shortcuts and their `when` context follow the
  // active pane, so mod+shift+E can never archive the thread the user is not
  // looking at while the secondary pane holds focus.
  const secondaryActiveThreadRef = useThreadSplitStore((state) =>
    state.splitMounted && state.activePaneId === "secondary" ? state.secondaryRef : null,
  );
  const shortcutThreadRef = secondaryActiveThreadRef ?? routeThreadRef;
  const terminalOpen = useTerminalUiStateStore((state) =>
    shortcutThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, shortcutThreadRef)
          .terminalOpen
      : false,
  );
  // The `previewOpen` shortcut-context flag here uses the store-only value;
  // the URL-aware arbitration lives inside ChatView's `onTogglePreview`,
  // which we invoke via the action bus to avoid duplicating the rule.
  const previewOpen = useRightPanelStore((state) =>
    shortcutThreadRef
      ? selectActiveRightPanel(state.byThreadKey, shortcutThreadRef) === "preview"
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });

      if (isCommandPaletteOpen()) {
        return;
      }

      if (command === "thread.undo") {
        if (event.repeat || isModelPickerOpen() || hasOpenArchiveUndoBlockingLayer()) return;
        if (undoLatestThreadAction()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        // The default sidebar routes creation through the command palette
        // whenever there is a real choice to make; the legacy sidebar (and
        // single-project setups) keep the immediate contextual create.
        if (!legacySidebarEnabled && projectGroupCount > 1) {
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "threadPane.focusOther") {
        if (focusOtherThreadPane()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (command === "threadPane.swap") {
        // Swaps the primary route thread with the secondary pane's — needs
        // two server threads on screen, so a draft primary leaves the key
        // to its default behavior.
        if (!canSwapThreadPanes(routeThreadRef)) return;
        event.preventDefault();
        event.stopPropagation();
        void swapThreadPanes({
          routeThreadRef,
          navigateToThread: (ref) =>
            router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(ref),
            }),
        });
        return;
      }

      if (command === "thread.rename" || command === "thread.snooze") {
        if (!shortcutThreadRef) return;
        // An unloaded shell passes: the palette holds the intent until the
        // thread hydrates. Only a loaded, archived thread has nothing to open.
        if (readThreadShell(shortcutThreadRef)?.archivedAt != null) return;
        event.preventDefault();
        event.stopPropagation();
        openCommandPalette({
          open: command === "thread.rename" ? "rename-thread" : "snooze-thread",
        });
        return;
      }

      if (command === "thread.archive") {
        if (!shortcutThreadRef) return;
        if (hasOpenArchiveUndoBlockingLayer()) return;
        event.preventDefault();
        event.stopPropagation();
        if (readThreadShell(shortcutThreadRef)?.archivedAt !== null) return;
        void attemptArchiveThread(shortcutThreadRef);
        return;
      }

      if (command === "preview.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!shortcutThreadRef) return;
        if (!isPreviewSupportedInRuntime()) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open T3 Code in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
        return;
      }

      // The remaining preview commands only fire when the panel is the
      // currently-focused tenant. The `when: previewFocus` rule already
      // gates this, but defend against the keybinding being misconfigured.
      if (
        command === "preview.refresh" ||
        command === "preview.focusUrl" ||
        command === "preview.zoomIn" ||
        command === "preview.zoomOut" ||
        command === "preview.resetZoom"
      ) {
        event.preventDefault();
        event.stopPropagation();
        const action =
          command === "preview.refresh"
            ? "refresh"
            : command === "preview.focusUrl"
              ? "focus-url"
              : command === "preview.zoomIn"
                ? "zoom-in"
                : command === "preview.zoomOut"
                  ? "zoom-out"
                  : "reset-zoom";
        dispatchPreviewAction(action);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    attemptArchiveThread,
    clearSelection,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    previewOpen,
    projectGroupCount,
    routeThreadRef,
    shortcutThreadRef,
    selectedThreadKeysSize,
    legacySidebarEnabled,
    terminalOpen,
    router,
  ]);

  return null;
}

function ChatRouteLayout() {
  // Both thread routes render here, not in their own leaf components, so the
  // draft-to-thread promotion keeps one ChatView mounted across the swap.
  const threadTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <SplitThreadLayout>
        {threadTarget ? <ThreadRouteView target={threadTarget} /> : <Outlet />}
      </SplitThreadLayout>
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
