import { readActivePaneThreadTarget } from "../components/thread-split/threadOpenTarget";
import { registerCommands } from "../shortcuts/dispatcher";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { KeybindingCommand } from "@t3tools/contracts";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { Outlet, createFileRoute, redirect, useMatches, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  canSnooze,
  canSnoozeUntilDone,
  effectiveSnoozed,
} from "@t3tools/client-runtime/state/thread-settled";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isElectron } from "../env";
import { ThreadRouteView } from "../components/ThreadRouteView";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useThreadActions } from "../hooks/useThreadActions";
import { getClientSettings } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { readEnvironmentSupportsSnoozeUntilDone, readThreadShell } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isEditableFocused } from "../lib/editableFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { resolveShortcutCommand } from "../keybindings";
import { createLastVisitedThreadShortcut, threadVisitHistory } from "../threadLastVisited";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { SplitThreadLayout } from "~/components/thread-split/SplitThreadLayout";
import { canSwapThreadPanes, swapThreadPanes } from "~/components/thread-split/swapThreadPanes";
import {
  focusOtherThreadPane,
  useThreadSplitStore,
} from "~/components/thread-split/threadSplitStore";
import { openThreadInActivePane } from "~/components/thread-split/threadOpenTarget";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { hasOpenArchiveUndoBlockingLayer } from "../archiveUndo";
import {
  buildThreadRouteParams,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "../threadRoutes";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  rememberDraftThreadRef,
  resolveVisitTarget,
  trackVisitedThreadShell,
} from "../threadVisitTargets";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";

function ChatRouteGlobalShortcuts() {
  const router = useRouter();
  const { attemptArchiveThread, snoozeThread } = useThreadActions();
  const runThreadCommand = useEffectEvent((command: KeybindingCommand, event: KeyboardEvent) => {
    const target = readActivePaneThreadTarget(
      resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {}),
    );
    const threadRef = target?.kind === "server" ? target.threadRef : null;
    if (command === "threadPane.focusOther") {
      if (!focusOtherThreadPane()) return false;
    } else if (command === "threadPane.swap") {
      const routeTarget = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
      const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
      if (!canSwapThreadPanes(routeThreadRef)) return false;
      void swapThreadPanes({
        routeThreadRef,
        navigateToThread: (ref) =>
          router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(ref),
          }),
      });
    } else {
      if (!threadRef) return false;
      const shell = readThreadShell(threadRef);
      if (shell?.archivedAt != null) return false;
      if (command === "thread.archive") {
        if (hasOpenArchiveUndoBlockingLayer()) return false;
        if (shell?.archivedAt !== null) return false;
        void attemptArchiveThread(threadRef);
      } else {
        event.preventDefault();
        event.stopPropagation();
        if (command === "thread.snoozeUntilDone" && event.repeat) return;
        if (
          command === "thread.snoozeUntilDone" &&
          getClientSettings().snoozeShortcutUntilDone &&
          shell != null &&
          readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) &&
          readEnvironmentSupportsSnoozeUntilDone(threadRef.environmentId) &&
          !effectiveSnoozed(shell, { now: new Date().toISOString() }) &&
          canSnooze(shell) &&
          canSnoozeUntilDone(shell)
        ) {
          void snoozeThread(threadRef, null, { untilDone: true }).then((result) => {
            if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to snooze thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          });
          return;
        }
        openCommandPalette({
          open: command === "thread.rename" ? "rename-thread" : "snooze-thread",
        });
        return;
      }
    }
    event.preventDefault();
    event.stopPropagation();
  });

  // oxlint-disable-next-line t3code/react-effect-budget -- owns global shortcut and focused-visit subscriptions for the visible chat route
  useEffect(() => {
    const readRouteTarget = () =>
      resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    const readFocusedTarget = () => readActivePaneThreadTarget(readRouteTarget());
    let trackedKey: string | null = null;
    let releaseTrackedShell: (() => void) | undefined;
    const recordVisit = () => {
      const target = readFocusedTarget();
      threadVisitHistory.record(target, resolveVisitTarget);
      const key = threadRouteTargetKey(target);
      if (key !== trackedKey) {
        releaseTrackedShell?.();
        releaseTrackedShell =
          target?.kind === "server" ? trackVisitedThreadShell(target.threadRef) : undefined;
        trackedKey = key;
      }
      if (target?.kind === "draft") rememberDraftThreadRef(target.draftId);
    };
    const readContext = () => {
      const target = readFocusedTarget();
      const threadRef = target?.kind === "server" ? target.threadRef : null;
      return {
        terminalOpen: threadRef
          ? selectThreadTerminalUiState(
              useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
              threadRef,
            ).terminalOpen
          : false,
        previewOpen: threadRef
          ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) ===
            "preview"
          : false,
      };
    };
    const previousThreadShortcut = createLastVisitedThreadShortcut({
      isDesktop: isElectron,
      pendingRelease: { key: null },
      resolveCommand: (event) =>
        event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]")
          ? null
          : resolveShortcutCommand(event, appAtomRegistry.get(primaryServerKeybindingsAtom), {
              context: {
                ...readContext(),
                terminalFocus: isTerminalFocused(),
                previewFocus: isPreviewFocused(),
                editableFocus: isEditableFocused(event.target),
                modelPickerOpen: isModelPickerOpen(),
              },
            }),
      isBlocked: () =>
        isCommandPaletteOpen() || isModelPickerOpen() || hasOpenArchiveUndoBlockingLayer(),
      resolveTarget: () =>
        threadVisitHistory.resolveTarget(readFocusedTarget(), resolveVisitTarget),
      openThread: (target) => {
        useThreadSelectionStore.getState().clearSelection();
        if (target.kind === "draft") {
          const split = useThreadSplitStore.getState();
          if (split.splitMounted && split.activePaneId === "secondary") split.closeSplit();
          void router.navigate({ to: "/draft/$draftId", params: { draftId: target.draftId } });
          return;
        }
        const route = readRouteTarget();
        const { completion } = openThreadInActivePane({
          targetRef: target.threadRef,
          routeThreadRef: route?.kind === "server" ? route.threadRef : null,
          navigateToPrimary: () =>
            router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(target.threadRef),
            }),
        });
        completion?.catch(() =>
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not open the previous thread",
              description: "Navigation to the thread failed.",
            }),
          ),
        );
      },
    });
    const disposeCommands = registerCommands(
      {
        "threadPane.focusOther": (event) => runThreadCommand("threadPane.focusOther", event),
        "threadPane.swap": (event) => runThreadCommand("threadPane.swap", event),
        "thread.rename": (event) => runThreadCommand("thread.rename", event),
        "thread.snooze": (event) => runThreadCommand("thread.snooze", event),
        "thread.snoozeUntilDone": (event) => runThreadCommand("thread.snoozeUntilDone", event),
        "thread.archive": (event) => runThreadCommand("thread.archive", event),
      },
      { when: () => !isCommandPaletteOpen(), context: readContext },
    );
    window.addEventListener("keydown", previousThreadShortcut.onKeyDown, true);
    window.addEventListener("keyup", previousThreadShortcut.onKeyUp, true);
    const unsubscribes = [
      router.subscribe("onResolved", recordVisit),
      useComposerDraftStore.subscribe(recordVisit),
      useThreadSplitStore.subscribe(recordVisit),
    ];
    recordVisit();
    return () => {
      disposeCommands();
      window.removeEventListener("keydown", previousThreadShortcut.onKeyDown, true);
      window.removeEventListener("keyup", previousThreadShortcut.onKeyUp, true);
      for (const unsubscribe of unsubscribes) unsubscribe();
      releaseTrackedShell?.();
    };
  }, [router]);
  return null;
}

function threadRouteTargetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const threadTarget = useThreadRouteTarget();
  // Read matches, not location, so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  // Settings and Usage render over the thread that opened them, so ChatView never remounts.
  const [backgroundTarget, setBackgroundTarget] = useState(threadTarget);
  if (!modalOpen && threadRouteTargetKey(backgroundTarget) !== threadRouteTargetKey(threadTarget)) {
    setBackgroundTarget(threadTarget);
  }
  const shownTarget = modalOpen ? backgroundTarget : threadTarget;
  return (
    <>
      {!modalOpen ? <ChatRouteGlobalShortcuts /> : null}
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      <SplitThreadLayout background={modalOpen}>
        {shownTarget ? (
          <ThreadRouteView target={shownTarget} background={modalOpen} />
        ) : modalOpen ? (
          <SidebarInset className="h-dvh" />
        ) : (
          <Outlet />
        )}
      </SplitThreadLayout>
      {modalOpen ? <Outlet /> : null}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
