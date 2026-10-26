import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { TerminalContextSelection } from "../../lib/terminalContext";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";
import { useThreadRefs } from "../../state/entities";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  reconcileMountedTerminalThreadIds,
} from "../ChatView.logic";
import {
  PersistentThreadTerminalDrawer,
  type PersistentTerminalLaunchContext,
} from "../PersistentThreadTerminals";
import { useThreadPaneId } from "../thread-split/threadPaneContext";
import { useThreadSplitStore } from "../thread-split/threadSplitStore";

interface ChatTerminalDrawersProps {
  readonly activeThreadKey: string | null;
  /** The pane's route thread, which a secondary split pane owns the terminals of. */
  readonly routeThreadKey: string;
  readonly activeTerminalOpen: boolean;
  readonly composerHeight: number;
  readonly launchContext: PersistentTerminalLaunchContext | null;
  readonly splitShortcutLabel: string | undefined;
  readonly splitVerticalShortcutLabel: string | undefined;
  readonly newShortcutLabel: string | undefined;
  readonly closeShortcutLabel: string | undefined;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

/**
 * Keeps terminal drawers mounted for recently open threads, so switching back
 * to one finds its sessions as they were. Every thread's terminal and draft
 * state feeds the reconcile, so it subscribes here instead of in ChatView.
 */
export function ChatTerminalDrawers(props: ChatTerminalDrawersProps) {
  const { activeThreadKey, routeThreadKey } = props;
  const isSecondaryPane = useThreadPaneId() === "secondary";
  // Deliberately not mounted-gated: terminal ownership must swap in the same
  // commit the secondary thread is picked or dropped, or both panes would
  // attach the same terminal for a frame. While a picked split is not
  // rendered this only costs a prewarmed hidden surface.
  const splitReservedTerminalThreadKey = useThreadSplitStore((state) =>
    state.secondaryRef !== null ? scopedThreadKey(state.secondaryRef) : null,
  );
  const openTerminalThreadKeys = useTerminalUiStateStore(
    useShallow((state) =>
      Object.entries(state.terminalUiStateByThreadKey).flatMap(
        ([nextThreadKey, nextTerminalUiState]) =>
          nextTerminalUiState.terminalOpen ? [nextThreadKey] : [],
      ),
    ),
  );
  const serverThreadRefs = useThreadRefs();
  const serverThreadKeys = serverThreadRefs.map(scopedThreadKey);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftThreadKeys = Object.values(draftThreadsByThreadKey).map((draftThread) =>
    scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
  );
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const activeTerminalDrawerPresence = usePanelPresence(
    Boolean(activeThreadKey && props.activeTerminalOpen),
    true,
    panelAnimationsActive,
    activeThreadKey,
    panelAnimationDurationMs,
  );
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);
  const existingOpenTerminalThreadKeys = (() => {
    const existingThreadKeys = new Set<string>([...serverThreadKeys, ...draftThreadKeys]);
    return openTerminalThreadKeys.filter((nextThreadKey) => {
      if (!existingThreadKeys.has(nextThreadKey)) return false;
      // With the split open each terminal needs exactly one owner, or two
      // ChatViews would mount duplicate surfaces for every open terminal:
      // the secondary pane owns only its own thread's terminals and the
      // primary pane owns everything else.
      if (isSecondaryPane) return nextThreadKey === routeThreadKey;
      return (
        splitReservedTerminalThreadKey === null || nextThreadKey !== splitReservedTerminalThreadKey
      );
    });
  })();
  const reconciledMountedTerminalThreadKeys = reconcileMountedTerminalThreadIds({
    currentThreadIds: mountedTerminalThreadKeys,
    openThreadIds: existingOpenTerminalThreadKeys,
    activeThreadId: activeThreadKey,
    activeThreadTerminalOpen: activeTerminalDrawerPresence.present,
    maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  });
  if (
    reconciledMountedTerminalThreadKeys.length !== mountedTerminalThreadKeys.length ||
    reconciledMountedTerminalThreadKeys.some(
      (threadKey, index) => threadKey !== mountedTerminalThreadKeys[index],
    )
  ) {
    setMountedTerminalThreadKeys(reconciledMountedTerminalThreadKeys);
  }
  const mountedTerminalThreadRefs = mountedTerminalThreadKeys.flatMap((mountedThreadKey) => {
    const mountedThreadRef = parseScopedThreadKey(mountedThreadKey);
    return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : [];
  });

  return mountedTerminalThreadRefs.map(({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
    <PersistentThreadTerminalDrawer
      key={mountedThreadKey}
      threadRef={mountedThreadRef}
      threadId={mountedThreadRef.threadId}
      active={mountedThreadKey === activeThreadKey}
      composerHeight={mountedThreadKey === activeThreadKey ? props.composerHeight : 0}
      launchContext={mountedThreadKey === activeThreadKey ? props.launchContext : null}
      splitShortcutLabel={props.splitShortcutLabel}
      splitVerticalShortcutLabel={props.splitVerticalShortcutLabel}
      newShortcutLabel={props.newShortcutLabel}
      closeShortcutLabel={props.closeShortcutLabel}
      keybindings={props.keybindings}
      onAddTerminalContext={props.onAddTerminalContext}
    />
  ));
}
