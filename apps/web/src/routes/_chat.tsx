import { Outlet, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useClientSettings } from "../hooks/useSettings";
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
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { primaryServerKeybindingsAtom } from "~/state/server";
import {
  archiveUndoHistory,
  hasOpenArchiveUndoBlockingLayer,
  isArchiveUndoShortcut,
  isEditableKeyboardTarget,
  resolveEmptyDraftIdForArchiveUndo,
} from "../archiveUndo";
import { hasComposerDraftContent, useComposerDraftStore } from "../composerDraftStore";
import { draftSubmissionTracker } from "../draftSubmissionState";
import { useUnarchiveThread } from "../hooks/useThreadActions";
import {
  buildThreadRouteParams,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "../threadRoutes";

function readCurrentRouteTarget(router: ReturnType<typeof useRouter>): ThreadRouteTarget | null {
  const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
  return resolveThreadRouteTarget(params);
}

function readEmptyNewThreadDraftId(router: ReturnType<typeof useRouter>): string | null {
  const target = readCurrentRouteTarget(router);
  if (target?.kind !== "draft") {
    return null;
  }
  const composerState = useComposerDraftStore.getState();
  const draftSession = composerState.getDraftSession(target.draftId);
  const hasObservedThread = Boolean(
    draftSession &&
    (draftSession.promotedTo ||
      readThreadShell(scopeThreadRef(draftSession.environmentId, draftSession.threadId))),
  );
  const hasStartedSubmission = draftSubmissionTracker.hasStarted(target.draftId);
  if (hasObservedThread) {
    draftSubmissionTracker.clear(target.draftId);
  }
  return resolveEmptyDraftIdForArchiveUndo(
    target,
    hasComposerDraftContent(composerState.getComposerDraft(target.draftId)),
    hasObservedThread || hasStartedSubmission,
  );
}

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const sidebarV2Enabled = useClientSettings((settings) => settings.sidebarV2Enabled);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const router = useRouter();
  const unarchiveThread = useUnarchiveThread();
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
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  // The `previewOpen` shortcut-context flag here uses the store-only value;
  // the URL-aware arbitration lives inside ChatView's `onTogglePreview`,
  // which we invoke via the action bus to avoid duplicating the rule.
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
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
        },
      });

      if (isCommandPaletteOpen()) {
        return;
      }

      if (
        isArchiveUndoShortcut(event) &&
        !isEditableKeyboardTarget(event.target) &&
        !hasOpenArchiveUndoBlockingLayer()
      ) {
        const candidate = archiveUndoHistory.take();
        if (candidate) {
          const emptyDraftId = readEmptyNewThreadDraftId(router);

          event.preventDefault();
          event.stopPropagation();
          void (async () => {
            const result = await unarchiveThread(candidate.threadRef);
            if (result._tag === "Failure") {
              archiveUndoHistory.restore(candidate);
              if (!isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Failed to restore thread",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  }),
                );
              }
              return;
            }

            if (emptyDraftId && readEmptyNewThreadDraftId(router) === emptyDraftId) {
              const navigationResult = await Promise.resolve(
                router.navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(candidate.threadRef),
                }),
              ).then(
                () => ({ _tag: "Success" as const }),
                (error: unknown) => ({ _tag: "Failure" as const, error }),
              );
              if (navigationResult._tag === "Failure") {
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Thread restored, but could not open it",
                    description:
                      navigationResult.error instanceof Error
                        ? navigationResult.error.message
                        : "An error occurred.",
                  }),
                );
              }
              return;
            }

            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: "Thread restored",
                description: candidate.threadTitle,
              }),
            );
          })();
          return;
        }
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
        // Sidebar v2 routes creation through the command palette whenever
        // there is a real choice to make; v1 (and single-project setups)
        // keep the immediate contextual create.
        if (sidebarV2Enabled && projectGroupCount > 1) {
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

      if (command === "preview.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!routeThreadRef) return;
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
    clearSelection,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    previewOpen,
    projectGroupCount,
    routeThreadRef,
    selectedThreadKeysSize,
    sidebarV2Enabled,
    terminalOpen,
    router,
    unarchiveThread,
  ]);

  return null;
}

function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <Outlet />
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
