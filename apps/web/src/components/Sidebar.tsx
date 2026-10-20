import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { ThreadHoverCard, ThreadHoverCardPopup } from "./ThreadHoverCard";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";
import { ThreadTerminalStatusButton } from "./ThreadStatusIndicators";
import { ThreadContextDragGhost } from "./chat/ThreadContextDragGhost";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag as moveThreadContextDragGhost,
} from "./chat/threadContextDrag";
import { useThreadGroupCatalog } from "../hooks/useThreadGroups";
import { threadGroupId, threadGroupSections } from "@t3tools/shared/threadGroups";
import { groupMovableThreads, moveThreadsToGroup } from "~/lib/threadGroupMove";
import { openThreadGroupsDialog } from "./sidebar/threadGroupsDialogStore";
import { discardComposerDraft } from "../lib/discardComposerDraft";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";
import {
  DndContext,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  canSnooze,
  effectiveSnoozed,
  canSnoozeUntilDone,
  hasPendingArchive,
  resolveArchiveToggleAction,
  snoozeWakeSortMs,
  threadWokeAt,
  threadWokeOnFinishedWork,
  UNTIL_DONE_SNOOZE_LABEL,
} from "@t3tools/client-runtime/state/thread-settled";
import { createInboxReturnTracker } from "@t3tools/client-runtime/state/thread-inbox";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import {
  resolveSettledThreadTimestamp,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import {
  resolveThreadProviderStack,
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  canForkConversation,
  canForkImportedSessionDriver,
} from "@t3tools/client-runtime/state/thread-fork";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedProjectKey,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  type AccentTintIntensityPercent,
  AuthOrchestrationOperateScope,
  type ContextMenuItem,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ProjectId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type SidebarProjectAccentColor,
  type SidebarThreadProviderIconVisibility,
  type ThreadId,
} from "@t3tools/contracts";

import {
  clampArchivedSectionVisibleCount,
  type TimestampFormat,
} from "@t3tools/contracts/settings";
import { selectRecentArchivedThreads } from "@t3tools/client-runtime/state/threads";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArchiveIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  ClockIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GitForkIcon,
  GroupIcon,
  InboxIcon,
  ListFilterIcon,
  MessageCircleQuestionIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldQuestionIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  Volume2Icon,
  VolumeIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useRouter } from "@tanstack/react-router";

import { useRightPanelStore } from "../rightPanelStore";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { cn, isMacPlatform } from "~/lib/utils";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { readLocalApi } from "../localApi";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { selectProjectGroupingSettings } from "../logicalProject";
import {
  projectGroupsSpanEnvironments,
  getSidebarProjectSettingsKey,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { useUiStateStore } from "../uiStateStore";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import {
  requestBulkThreadUnpinConfirmation,
  useAcknowledgeThreadWoke,
  useThreadActions,
} from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSidebarProjectGroups } from "../hooks/useSidebarProjectGroups";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { registerSettleAndAdvance } from "../settleAndAdvance";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
import { useAccentTintSettings, useClientSettings } from "../hooks/useSettings";
import {
  useProjectAccentColorByKey,
  useProjectAccentColorMigration,
  useProjectAccentColors,
} from "../hooks/useProjectAccentColors";
import { projectAccentTintStyle } from "../projectAccentTint";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { useNowSecond } from "../hooks/useNowSecond";
import {
  useEnvironmentIdentities,
  useConnectedEnvironmentIds,
  useEnvironmentMachines,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import {
  readThreadShell,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { primaryServerKeybindingsAtom } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { threadEnvironment } from "../state/threads";
import { useEnvironmentQuery } from "../state/query";
import { useThreadSearch } from "../state/queries";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { buildThreadRouteParams, resolveActiveThreadRouteRef } from "../threadRoutes";
import { formatCompactRelativeTimeLabel, parseTimestampDate } from "../timestampFormat";
import { useRecentArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import type { SidebarThreadSummary } from "../types";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuId,
} from "./threadActionMenu.logic";
import { openThreadInActivePane } from "./thread-split/threadOpenTarget";
import {
  SplitPaneMarkerIcon,
  useSplitSecondaryThreadKey,
  type SplitPaneMarker,
} from "./thread-split/SplitPaneMarker";
import { SidebarEnvironmentFilterMenu } from "./sidebar/SidebarEnvironmentFilter";
import { resolveSidebarEmptyStateCause } from "./sidebar/sidebarEmptyState";
import { useSidebarEnvironmentFilter } from "./sidebar/useSidebarEnvironmentFilter";
import {
  animateSidebarLayoutChanges,
  applySidebarThreadDrop,
  filterSidebarV2VisibleThreads,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
  formatWorkingDurationLabel,
  hasUnseenCompletion,
  isSidebarNestedLinkClick,
  isSidebarProjectScopeIsolated,
  isSidebarThreadWorking,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  planSidebarThreadDrop,
  resolveAdjacentThreadId,
  resolveSidebarSweepKeys,
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  resolveSidebarProjectScope,
  resolveSidebarProjectScopePhysicalKeys,
  resolveSidebarThreadSection,
  resolveSidebarRowAccessibility,
  type SidebarDropVerb,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  searchSidebarThreads,
  shouldCreateNewThreadInCurrentProject,
  shouldNavigateAfterThreadPark,
  shouldRecedeSidebarThread,
  shouldReleaseSidebarGroupDrop,
  isSidebarGroupMarker,
  resolveWorkingStartedAt,
  sidebarProjectScopeSignature,
  sidebarListItemId,
  sidebarMarkerId,
  sidebarThreadKeyAtY,
  sortInboxThreadsByReturn,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  toggleSidebarProjectHidden,
  toggleSidebarProjectIsolation,
  toggleSidebarProjectSelection,
  useThreadJumpHintVisibility,
  useRetainedValue,
  useSidebarRowSubscriptionLease,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarProjectScope,
  type SidebarSection,
} from "./Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  restrictBelowSidebarLabel,
} from "./Sidebar.drag";
import { SidebarDragLifecycle, SidebarPointerSensor } from "./Sidebar.pointer";
import { createSidebarListMotion } from "./Sidebar.motion";
import {
  ThreadPullRequestBadgeControl,
  ThreadPullRequestsMiniList,
  ThreadWorktreeIndicator,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  terminalStatusFromRunningIds,
  type TerminalStatusIndicator,
  useLinkedThreadPullRequest,
  ThreadSearchPullRequestNumber,
} from "./ThreadStatusIndicators";
import { resolveSnoozePresets, snoozeWakeLabel, type SnoozePreset } from "./Sidebar.snooze";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";
import { ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import {
  deriveProviderEntriesByEnvironment,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { toggleLoadedListeningTrack, useThreadListeningState } from "../state/listeningPlayback";
import { useStableCallback } from "../hooks/useStableCallback";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button, InlineButton } from "./ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "./ui/menu";
import { SidebarContent, SidebarGroup, SidebarMenuButton, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { MiddleTruncate } from "./ui/middle-truncate";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  useThreadHasUnsentDraft,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../composerDraftStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";

// The fields thread rows show. Provider status pushes refresh `checkedAt`,
// status and auth on every provider; leaving those out keeps each
// environment's map, and every memoized row, stable across them.
type SidebarProviderEntry = Pick<
  ProviderInstanceEntry,
  | "instanceId"
  | "driverKind"
  | "displayName"
  | "accentColor"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "models"
>;

function sameSidebarProviderEntries(
  left: ReadonlyMap<string, SidebarProviderEntry>,
  right: ReadonlyMap<string, SidebarProviderEntry>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [instanceId, entry] of right) {
    const other = left.get(instanceId);
    if (
      other === undefined ||
      other.driverKind !== entry.driverKind ||
      other.displayName !== entry.displayName ||
      other.accentColor !== entry.accentColor ||
      other.acpRegistryAgentId !== entry.acpRegistryAgentId ||
      other.acpRegistryIconUrl !== entry.acpRegistryIconUrl ||
      other.models !== entry.models
    ) {
      return false;
    }
  }
  return true;
}

// Threads on non-primary environments (T3 Connect, hosted) resolve their
// provider entry from their own environment's config: default instance ids
// are driver slugs, so a flat map would collide across environments.
const sidebarProviderEntriesAtom = Atom.make((get) => {
  const providersByEnvironment = get(environmentPresentations.providersByEnvironmentAtom);
  const derived = deriveProviderEntriesByEnvironment(
    [...get(environmentPresentations.serverConfigsAtom)].map(
      ([environmentId, config]) =>
        [environmentId, providersByEnvironment.get(environmentId) ?? [], config.settings] as const,
    ),
  );
  const previous = Option.getOrNull(
    get.self<ReadonlyMap<string, ReadonlyMap<string, SidebarProviderEntry>>>(),
  );
  const next = new Map<string, ReadonlyMap<string, SidebarProviderEntry>>();
  let changed = previous === null || previous.size !== derived.size;
  for (const [environmentId, entries] of derived) {
    const prior = previous?.get(environmentId);
    if (prior !== undefined && sameSidebarProviderEntries(prior, entries)) {
      next.set(environmentId, prior);
    } else {
      next.set(environmentId, entries);
      changed = true;
    }
  }
  return !changed && previous !== null ? previous : next;
}).pipe(Atom.withLabel("sidebar-provider-entries"));

const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, SidebarProviderEntry> = new Map();
// Collapsed shelves share one empty list so a route change alone does not
// give the sidebar list a new identity.
const EMPTY_THREADS: readonly EnvironmentThreadShell[] = [];

const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;
// Keep the v2 keys so existing shelf preferences survive the v2-to-default rename.
const SETTLED_SHELF_EXPANDED_KEY = "t3code:sidebar-v2:settled-expanded";
const SNOOZED_SHELF_EXPANDED_KEY = "t3code:sidebar-v2:snoozed-expanded";
const PINNED_SHELF_EXPANDED_KEY = "t3code:sidebar-v2:pinned-expanded";
// Fork: the built-in Active group has its own header and folds like Pinned.
const ACTIVE_SHELF_EXPANDED_KEY = "t3code:sidebar-v2:active-expanded";
const COLLAPSED_GROUP_IDS_SCHEMA = Schema.Array(Schema.String);
const DRAFTS_SHELF_EXPANDED_KEY = "t3code:sidebar-v2:drafts-expanded";
const WORKING_SHELF_EXPANDED_KEY = "t3code:sidebar:working-expanded";
const ARCHIVED_SHELF_EXPANDED_KEY = "t3code:sidebar-v2:archived-expanded";

const inboxReturns = createInboxReturnTracker();

type SidebarOptimisticDrop = {
  readonly key: string;
  /** Fork: custom group before and after an active drop. */
  readonly sourceCustomGroupId: string | null;
  readonly customGroupId: string | null;
  readonly customGroupSeen: boolean;
  /** Identifies this drop across the customGroupSeen update. */
  readonly token: object;
  readonly sourceSection: SidebarSection;
  readonly section: "pinned" | "active" | "settled";
  readonly occurredAt: string;
  readonly clearsSnooze: boolean;
  readonly order: readonly string[] | null;
  readonly keysAtDrop: ReadonlyMap<string, string | null>;
  readonly assignedKeys: ReadonlyMap<string, string>;
};

interface SidebarThreadPartitionInput {
  readonly threads: readonly EnvironmentThreadShell[];
  // Fork: the environment filter and the project scope/hide multi-select.
  readonly environmentScope: ReadonlySet<string> | null;
  readonly environmentScopeActive: boolean;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly hiddenProjectKeys: ReadonlySet<string>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly optimisticDrop: SidebarOptimisticDrop | null;
  readonly workingShelfEnabled: boolean;
  // Snooze wakes depend on the clock, so the minute tick and the precise
  // snooze-wake tick are inputs: a new key repartitions.
  readonly clockKey: string;
}

function threadShellKey(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

const NO_DRAGGED_ORDER: readonly string[] = [];
const NO_DRAGGED_ORDERS: {
  readonly settledOrder: readonly string[];
  readonly activeOrder: readonly string[] | undefined;
} = { settledOrder: NO_DRAGGED_ORDER, activeOrder: undefined };

// Where the dragged row would sort if dropped on the settled or the
// time-ordered active shelf; the strategy previews those slots.
function resolveDraggedOrders(input: {
  readonly drag: { readonly activeKey: string; readonly occurredAt: string };
  readonly threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly settledThreads: readonly EnvironmentThreadShell[];
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly workingShelfEnabled: boolean;
}): typeof NO_DRAGGED_ORDERS {
  const { drag, threadByKey, settledThreads, activeThreads, workingShelfEnabled } = input;
  const thread = threadByKey.get(drag.activeKey);
  if (thread === undefined) return NO_DRAGGED_ORDERS;
  const others = (list: readonly EnvironmentThreadShell[]) =>
    list.filter((candidate) => threadShellKey(candidate) !== drag.activeKey);
  return {
    settledOrder: sortSettledThreads([
      ...others(settledThreads),
      applySidebarThreadDrop(thread, "settled", drag.occurredAt),
    ]).map(threadShellKey),
    activeOrder: workingShelfEnabled
      ? sortInboxThreadsByReturn(
          [...others(activeThreads), applySidebarThreadDrop(thread, "active", drag.occurredAt)],
          inboxReturns.returnedAt,
        ).map(threadShellKey)
      : undefined,
  };
}

function routeThreadOnly(
  threads: readonly EnvironmentThreadShell[],
  routeThreadKey: string | null,
): readonly EnvironmentThreadShell[] {
  if (routeThreadKey === null) return EMPTY_THREADS;
  const routeThread = threads.find((thread) => threadShellKey(thread) === routeThreadKey);
  return routeThread === undefined ? EMPTY_THREADS : [routeThread];
}

function partitionSidebarThreads(input: SidebarThreadPartitionInput) {
  const {
    threads,
    environmentScope,
    environmentScopeActive,
    scopedProjectKeys,
    hiddenProjectKeys,
    serverConfigs,
    optimisticDrop,
    workingShelfEnabled,
  } = input;
  const preciseNow = new Date().toISOString();
  // Subagent child threads live in the parent's Agents surface, not the
  // sidebar roster (v2 models them as real threads with lineage). Each fork
  // filter is then evaluated separately so the empty state can be attributed
  // by counterfactual — "would clearing just this one admit a row?" — rather
  // than by which filters happen to be switched on.
  let admittedWithoutEnvironment = 0;
  let admittedWithoutProjects = 0;
  const visible: EnvironmentThreadShell[] = [];
  for (const thread of filterSidebarV2VisibleThreads(threads, null)) {
    const projectKey = `${thread.environmentId}:${thread.projectId}`;
    const passesEnvironment =
      environmentScope === null || environmentScope.has(thread.environmentId);
    const passesProjects =
      !hiddenProjectKeys.has(projectKey) &&
      (scopedProjectKeys === null || scopedProjectKeys.has(projectKey));
    if (passesProjects) admittedWithoutEnvironment += 1;
    if (passesEnvironment) admittedWithoutProjects += 1;
    if (passesEnvironment && passesProjects) visible.push(thread);
  }
  inboxReturns.observe(workingShelfEnabled ? threads : null);
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const inbox = (thread: EnvironmentThreadShell) =>
    workingShelfEnabled && isSidebarThreadWorking(thread) ? working : active;
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const draggable = new Set<string>();
  const activeReorderable = new Set<string>();
  for (const thread of visible) {
    const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
    const supportsSettlement = capabilities?.threadSettlement === true;
    const supportsSnooze = capabilities?.threadSnooze === true;
    const threadKey = threadShellKey(thread);
    if (capabilities?.threadActiveReorder === true) activeReorderable.add(threadKey);
    if (capabilities?.threadPinning === true && capabilities.threadPinReorder === true) {
      draggable.add(threadKey);
    }
    if (optimisticDrop?.key === threadKey) {
      const dropped = applySidebarThreadDrop(
        thread,
        optimisticDrop.section,
        optimisticDrop.occurredAt,
        optimisticDrop.assignedKeys.get(threadKey),
      );
      const projected =
        optimisticDrop.section === "active"
          ? { ...dropped, customGroupId: optimisticDrop.customGroupId }
          : dropped;
      (optimisticDrop.section === "pinned"
        ? pinned
        : optimisticDrop.section === "settled"
          ? settled
          : inbox(projected)
      ).push(
        optimisticDrop.clearsSnooze
          ? projected
          : {
              ...projected,
              snoozedAt: thread.snoozedAt,
              snoozedUntil: thread.snoozedUntil,
              snoozedUntilRunId: thread.snoozedUntilRunId ?? null,
            },
      );
    } else {
      const section = resolveSidebarThreadSection({
        snoozed: supportsSnooze && effectiveSnoozed(thread, { now: preciseNow }),
        settled: supportsSettlement && thread.settledOverride === "settled",
        pinned: thread.pinnedAt != null,
      });
      (section === "snoozed"
        ? snoozed
        : section === "settled"
          ? settled
          : section === "pinned"
            ? pinned
            : inbox(thread)
      ).push(thread);
    }
  }
  // Server capability only gates DRAGGING — it must not influence the
  // sort, or mixed-version fleets would render different pinned orders on
  // web and mobile from the same data.
  const sortedPinned = sortPinnedThreadsForSidebar(pinned);
  const sortedActive = workingShelfEnabled
    ? sortInboxThreadsByReturn(active, inboxReturns.returnedAt)
    : sortThreadsForSidebar(active);
  return {
    pinnedThreads:
      optimisticDrop?.section !== "pinned" || optimisticDrop.order === null
        ? sortedPinned
        : orderItemsByPreferredIds({
            items: sortedPinned,
            preferredIds: optimisticDrop.order,
            getId: threadShellKey,
          }),
    draggableThreadKeys: draggable,
    activeReorderableThreadKeys: activeReorderable,
    activeThreads:
      optimisticDrop?.section !== "active" || optimisticDrop.order === null
        ? sortedActive
        : orderItemsByPreferredIds({
            items: sortedActive,
            preferredIds: optimisticDrop.order,
            getId: threadShellKey,
          }),
    workingThreads: sortWorkingThreadsBySend(working),
    snoozedThreads: snoozed.toSorted(
      (left, right) => snoozeWakeSortMs(left) - snoozeWakeSortMs(right),
    ),
    settledThreads: sortSettledThreads(settled),
    snoozeNow: preciseNow,
    emptyStateCause: resolveSidebarEmptyStateCause({
      environmentScopeActive,
      projectFiltersActive: scopedProjectKeys !== null || hiddenProjectKeys.size > 0,
      admittedWithoutEnvironment,
      admittedWithoutProjects,
    }),
  };
}

// The earliest timed wake among snoozed rows. Scans every row: until-done
// rows sort first but carry no timer, so entry 0 is not the boundary.
function nextSnoozeWakeAt(snoozedThreads: readonly EnvironmentThreadShell[]): string | null {
  let nextWakeAt: string | null = null;
  let nextWakeAtMs = Number.NaN;
  for (const thread of snoozedThreads) {
    if (thread.snoozedUntil == null) continue;
    const wakeAtMs = Date.parse(thread.snoozedUntil);
    if (Number.isNaN(wakeAtMs)) continue;
    if (Number.isNaN(nextWakeAtMs) || wakeAtMs < nextWakeAtMs) {
      nextWakeAtMs = wakeAtMs;
      nextWakeAt = thread.snoozedUntil;
    }
  }
  return nextWakeAt;
}

// What the canonical shells say about a held drop: still in flight, landed
// (release it), or (fork) its destination group was observed.
function resolveOptimisticDropHold(input: {
  readonly optimisticDrop: SidebarOptimisticDrop;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly pinnedKeys: readonly string[];
  readonly activeKeys: readonly string[];
  readonly groups: Parameters<typeof threadGroupId>[1];
  readonly now: string;
}): "hold" | "release" | "group-seen" {
  const { optimisticDrop, threads, pinnedKeys, activeKeys, groups, now } = input;
  const canonicalByKey = new Map(threads.map((thread) => [threadShellKey(thread), thread]));
  const thread = canonicalByKey.get(optimisticDrop.key);
  if (thread === undefined || thread.archivedAt !== null) {
    return "release";
  }
  const canonicalSection = effectiveSnoozed(thread, { now })
    ? "snoozed"
    : thread.settledOverride === "settled"
      ? "settled"
      : thread.pinnedAt != null
        ? "pinned"
        : "active";
  if (
    canonicalSection !== optimisticDrop.sourceSection &&
    canonicalSection !== optimisticDrop.section
  ) {
    return "release";
  }
  if (optimisticDrop.order === null) {
    // Settle also emits unpin/unsnooze events. Wait for the entire move
    // before releasing the projected fields and sort timestamps.
    return canonicalSection === optimisticDrop.section &&
      thread.pinnedAt == null &&
      (!optimisticDrop.clearsSnooze || (thread.snoozedUntil == null && thread.snoozedAt == null))
      ? "release"
      : "hold";
  }
  // Fork: a competing group move or a deleted target group releases the hold.
  const currentGroupId = threadGroupId(thread, groups);
  if (
    optimisticDrop.section === "active" &&
    shouldReleaseSidebarGroupDrop({
      sourceGroupId: optimisticDrop.sourceCustomGroupId,
      targetGroupId: optimisticDrop.customGroupId,
      currentGroupId,
      targetExists:
        optimisticDrop.customGroupId === null ||
        groups.some((group) => group.id === optimisticDrop.customGroupId),
      targetSeen: optimisticDrop.customGroupSeen,
    })
  ) {
    return "release";
  }
  if (
    optimisticDrop.section === "active" &&
    !optimisticDrop.customGroupSeen &&
    currentGroupId === optimisticDrop.customGroupId
  ) {
    return "group-seen";
  }
  if (canonicalSection !== optimisticDrop.section) return "hold";
  if (canonicalSection === "active" && currentGroupId !== optimisticDrop.customGroupId) {
    return "hold";
  }
  if (optimisticDrop.clearsSnooze && (thread.snoozedUntil != null || thread.snoozedAt != null)) {
    return "hold";
  }
  // Fork: an active drop is placed among its destination group's rows only.
  const destinationKeys =
    optimisticDrop.section === "pinned"
      ? pinnedKeys
      : activeKeys.filter((key) => {
          const canonical = canonicalByKey.get(key);
          return (
            canonical !== undefined &&
            threadGroupId(canonical, groups) === optimisticDrop.customGroupId
          );
        });
  const canonicalDestination = destinationKeys.flatMap((key) => {
    const canonical = canonicalByKey.get(key);
    return canonical === undefined ? [] : [canonical];
  });
  const keyByThread = new Map(
    canonicalDestination.map((thread) => [
      threadShellKey(thread),
      (optimisticDrop.section === "pinned" ? thread.pinOrderKey : thread.activeOrderKey) ?? null,
    ]),
  );
  const heldOrder = optimisticDrop.order;
  const heldKeys = new Set(heldOrder);
  const membershipChanged =
    destinationKeys.length !== heldOrder.length ||
    destinationKeys.some((key) => !heldKeys.has(key));
  const foreignKeyLanded = destinationKeys.some((threadKey) => {
    const currentKey = keyByThread.get(threadKey) ?? null;
    if (currentKey === (optimisticDrop.keysAtDrop.get(threadKey) ?? null)) return false;
    return currentKey !== optimisticDrop.assignedKeys.get(threadKey);
  });
  const allAssignmentsLanded = [...optimisticDrop.assignedKeys].every(
    ([threadKey, orderKey]) => keyByThread.get(threadKey) === orderKey,
  );
  return membershipChanged || foreignKeyLanded || allAssignmentsLanded ? "release" : "hold";
}

// Sidebar() is large enough that the compiler cannot prove its local maps stay
// unmutated; built inside a hook they reach it frozen and cached.
function useSidebarLookups() {
  const projects = useProjects();
  const environments = useEnvironmentIdentities();
  const serverConfigs = useServerConfigs();
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const projectGroups = useSidebarProjectGroups();
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const projectDisplayNameByKey = new Map(
    projectGroups.flatMap((group) =>
      group.memberProjects.map(
        (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
      ),
    ),
  );
  return {
    projects,
    serverConfigs,
    projectGroups,
    environmentLabelById,
    providerEntriesByEnvironment,
    projectByKey,
    projectDisplayNameByKey,
  };
}

function scheduleSnoozeWake(wakeAt: string | null, onWake: () => void): (() => void) | undefined {
  const wakeAtMs = wakeAt === null ? Number.NaN : Date.parse(wakeAt);
  if (Number.isNaN(wakeAtMs)) return undefined;
  // setTimeout delays are signed 32-bit: anything larger overflows and fires
  // immediately, turning a far-future wake (event-condition snoozes synced
  // from elsewhere) into a tight re-arm loop.
  const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
  const id = window.setTimeout(onWake, delayMs);
  return () => window.clearTimeout(id);
}

function canOperateThreads(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  return threads.every((thread) =>
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  );
}

/** Resolves a clicked id back to the shared thread action it came from, if any. */
function findThreadActionMenuId(
  items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
  value: string,
): ThreadActionMenuId | null {
  for (const item of items) {
    if (item.id === value) return item.id;
    const child = item.children?.find((candidate) => candidate.id === value);
    if (child) return child.id;
  }
  return null;
}

function checkThreadOperations(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  if (canOperateThreads(threads)) return true;
  toastManager.add({
    type: "error",
    title: "Thread action unavailable",
    description: "This connection cannot change one or more selected threads.",
  });
  return false;
}

// Subscribes to the minute tick itself, so only the label re-renders each
// minute. The minute is passed as the clock so it is the formatter's input.
function RelativeTimeLabel(props: { timestamp: string | null }) {
  const nowMinute = useNowMinute();
  return props.timestamp === null
    ? null
    : formatCompactRelativeTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`));
}

function threadTimeTimestamp(thread: SidebarThreadSummary): string {
  return thread.latestUserMessageAt ?? thread.updatedAt;
}

function JumpHintBadge(props: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
    >
      {props.label}
    </span>
  );
}

function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  if (Number.isNaN(startedMs)) return null;
  return <WorkingDurationLabel startedMs={startedMs} />;
}

// Self-ticking so only this span re-renders each second, not the whole row;
// the shared tick lands every working row's update in the same frame.
function WorkingDurationLabel(props: { startedMs: number }) {
  const nowMs = useNowSecond();
  return (
    <span className="tabular-nums">{formatWorkingDurationLabel(nowMs - props.startedMs)}</span>
  );
}

function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

function SidebarProviderStack(props: {
  thread: SidebarThreadSummary;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
}) {
  const stack = resolveThreadProviderStack(props.thread);
  const currentInstanceId = stack[stack.length - 1]!;
  const currentEntry = props.providerEntryByInstanceId.get(currentInstanceId) ?? null;
  if (currentEntry === null) return null;
  const showInstanceBadge = shouldShowInstanceBadge(
    currentEntry,
    props.providerEntryByInstanceId.values(),
  );
  const current = (
    <ProviderInstanceIcon
      driverKind={currentEntry.driverKind}
      displayName={currentEntry.displayName}
      accentColor={currentEntry.accentColor}
      acpRegistryAgentId={currentEntry.acpRegistryAgentId}
      acpRegistryIconUrl={currentEntry.acpRegistryIconUrl}
      showBadge={showInstanceBadge}
      iconClassName="size-3.5 opacity-60"
      badgeClassName="right-[-0.1875rem] bottom-[-0.1875rem] h-3 min-w-3 px-0.5 text-5xs"
    />
  );
  if (stack.length === 1) {
    return <span className="inline-flex shrink-0 items-center">{current}</span>;
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {stack.slice(0, -1).map((instanceId) => {
        const entry = props.providerEntryByInstanceId.get(instanceId);
        if (entry === undefined) return null;
        return (
          <ProviderInstanceIcon
            key={instanceId}
            driverKind={entry.driverKind}
            displayName={entry.displayName}
            acpRegistryAgentId={entry.acpRegistryAgentId}
            acpRegistryIconUrl={entry.acpRegistryIconUrl}
            iconClassName="size-3 opacity-35 grayscale"
          />
        );
      })}
      <span className="relative z-10 inline-flex items-center">{current}</span>
    </span>
  );
}

function SidebarThreadTooltip({
  thread,
  project,
  projectDisplayName,
  environmentLabel,
  environmentMachine,
  providerEntry,
  providerEntryByInstanceId,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
}: {
  thread: SidebarThreadSummary;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntry: SidebarProviderEntry | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
}) {
  const driverKind = providerEntry?.driverKind ?? null;
  const previousProviderNames = thread.providerInstanceHistory
    .filter((instanceId) => instanceId !== modelInstanceId)
    .map((instanceId) => providerEntryByInstanceId.get(instanceId)?.displayName ?? instanceId);
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  return (
    <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
      <ThreadHoverCard
        title={thread.title}
        footer={
          supportsMultiplePullRequests && thread.pullRequests.length > 0 ? (
            <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
              <ThreadPullRequestsMiniList pullRequests={thread.pullRequests} />
            </div>
          ) : null
        }
      >
        {projectDisplayName ? (
          <div className="flex min-w-0 items-center gap-2">
            {project ? <ProjectFavicon project={project} className="size-3 shrink-0" /> : null}
            <div className="min-w-0 truncate text-foreground/75">{projectDisplayName}</div>
          </div>
        ) : null}
        {environmentLabel ? (
          <div className="flex min-w-0 items-center gap-2">
            <EnvironmentMachineIcon
              kind={environmentMachine}
              className="size-3 shrink-0 stroke-muted-foreground"
            />
            <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
          </div>
        ) : null}
        {thread.branch ? (
          <div className="flex min-w-0 items-center gap-2">
            <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <MiddleTruncate value={thread.branch} className="flex" />
          </div>
        ) : null}
        {branchMismatch ? (
          <div className="flex min-w-0 items-start gap-2 text-warning">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
            <div className="min-w-0 flex-1 wrap-break-word leading-5">
              You're currently checked out on another branch.
            </div>
          </div>
        ) : null}
        {driverKind ? (
          <div className="flex min-w-0 items-center gap-2">
            <ProviderInstanceIcon
              driverKind={driverKind}
              displayName={
                providerEntry?.displayName ?? thread.runtime?.providerName ?? modelInstanceId
              }
              accentColor={providerEntry?.accentColor}
              acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
              acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
              showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
              badgeContent="none"
              badgeClassName="h-2 min-w-2 px-0"
              iconClassName="size-3 shrink-0 grayscale opacity-60"
            />
            <div className="min-w-0 truncate text-foreground/75">
              {showInstanceBadge && providerEntry
                ? `${modelLabel} · ${providerEntry.displayName}`
                : modelLabel}
            </div>
          </div>
        ) : null}
        {previousProviderNames.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <ArrowRightLeftIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">
              Handed off from {previousProviderNames.join(", ")}
            </div>
          </div>
        ) : null}
        {terminalStatus ? (
          <div className="flex min-w-0 items-center gap-2">
            <TerminalIcon
              aria-hidden
              className={cn("size-3 shrink-0", terminalStatus.colorClass)}
            />
            <div className="min-w-0 truncate text-foreground/75">
              {terminalProcessLabel(terminalProcessCount)}
            </div>
          </div>
        ) : null}
        {thread.runtime?.lastError ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-2",
              thread.runtime.lastErrorClass === "usage_limit" ? "text-warning" : "text-error",
            )}
          >
            <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
            <div className="min-w-0 truncate">
              {thread.runtime.lastErrorClass === "usage_limit"
                ? "Usage limit reached"
                : "Error occurred"}
            </div>
          </div>
        ) : null}
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );
}

function SnoozeMenuButton(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (preset: Pick<SnoozePreset, "snoozedUntil" | "untilDone">) => void;
  timestampFormat: TimestampFormat;
  untilDoneOffered: boolean;
}) {
  const { open, onOpenChange, onSnooze, timestampFormat, untilDoneOffered } = props;
  const presets = open
    ? resolveSnoozePresets(new Date(), timestampFormat, { untilDone: untilDoneOffered })
    : [];
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Snooze thread"
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                />
              }
            />
          }
        >
          <ClockIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>Snooze thread</TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="end">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={(event) => {
              event.stopPropagation();
              onSnooze(preset);
            }}
          >
            {preset.label}
            <MenuShortcut>{preset.whenLabel}</MenuShortcut>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onClick={async (event) => {
            event.stopPropagation();
            const choice = await requestCustomSnooze();
            if (choice) onSnooze(choice);
          }}
        >
          Custom…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

// Wraps the row's provider glyphs with the client's visibility setting.
function SidebarProviderIcon(props: {
  visibility: SidebarThreadProviderIconVisibility;
  children: ReactNode;
}) {
  // "never" removes the icon rather than hiding it with opacity: an invisible
  // icon still reserves its slot and still reappears on hover.
  if (props.visibility === "never") {
    return null;
  }
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center transition-opacity",
        props.visibility === "hover" &&
          "opacity-0 max-sm:opacity-100 [@media(hover:none)]:opacity-100 group-focus-within/sidebar-row:opacity-100 group-hover/sidebar-row:opacity-100",
      )}
    >
      {props.children}
    </span>
  );
}

type SortableThreadRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

// useSortable memoizes on its `disabled` object, so a fresh one per render
// re-renders every row and marker on each sidebar update.
const SIDEBAR_SORTABLE_DRAG_DISABLED = { draggable: true } as const;
const SIDEBAR_SORTABLE_DRAG_ENABLED = { draggable: false } as const;

// Takes the row's props rather than a render function: a closure from the
// sidebar body is new on every sidebar render, which rebuilt the bag and
// re-rendered every memoized row with it.
function SortableThreadRow(
  props: Omit<SidebarThreadRowProps, "sortable"> & {
    sortableId: string;
    sortableDisabled: boolean;
    contextDrag: boolean;
  },
) {
  const { sortableId, sortableDisabled, contextDrag, ...rowProps } = props;
  const canOperateThread = useEnvironmentScope(
    rowProps.thread.environmentId,
    AuthOrchestrationOperateScope,
  );
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    disabled:
      sortableDisabled || !canOperateThread
        ? SIDEBAR_SORTABLE_DRAG_DISABLED
        : SIDEBAR_SORTABLE_DRAG_ENABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // dnd-kit memoizes each field but not the bag, so the memoized row would
  // rerender on every shell update without this.
  const bag = {
    listeners,
    setNodeRef,
    transform: contextDrag ? null : transform,
    transition: contextDrag && isDragging ? "transform 150ms ease-out" : transition,
    isDragging: isDragging && !contextDrag,
  };
  // Keyed by variant so a card/slim switch remounts the row.
  return <SidebarThreadRow key={rowProps.variant} {...rowProps} sortable={bag} />;
}

const draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8";
const draftPenClassName = "size-3 shrink-0 text-warning-foreground";

function SortableSidebarMarker(props: {
  marker: SidebarListMarker;
  className?: string;
  children?: ReactNode;
  "data-testid"?: string | undefined;
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id: sidebarMarkerId(props.marker),
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={props["data-testid"]}
      className={cn("list-none", props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: props.marker.endsWith("-placeholder") ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

function SidebarSectionPlaceholder(props: {
  marker: "active-placeholder" | "settled-placeholder";
  label: string;
  showHint: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="relative mx-0.5 -mb-px h-0"
    >
      {props.showHint ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
            props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

const SIDEBAR_DRAG_DISTANCE = 6;

type SidebarSweepAction = "settle" | "unsettle" | "unsnooze";

const SIDEBAR_DRAG_LABEL_HEIGHT = 24;

function SidebarDragBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string;
  visible: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="pointer-events-none relative mx-0.5 -mb-px h-0"
    >
      {props.visible ? (
        <div className="sidebar-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              props.isDropTarget ? "text-primary" : "text-sidebar-foreground/80",
            )}
          >
            {props.label}
          </span>
          <span
            aria-hidden
            className={cn(
              "h-px flex-1",
              props.isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
            )}
          />
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

function SidebarSectionHeader(props: {
  marker: "working-header" | "snoozed-header" | "settled-header";
  label: string;
  className?: string;
  dragging?: boolean;
  isDropTarget?: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
}) {
  const shelf =
    props.marker === "working-header"
      ? "working"
      : props.marker === "snoozed-header"
        ? "snoozed"
        : "settled";
  const snoozed = shelf === "snoozed";
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className={cn("mx-0.5 h-8", props.className)}
    >
      <CollapsibleSectionHeader
        onClick={props.toggle.onToggle}
        expanded={props.toggle.expanded}
        tone={
          props.isDropTarget ? "accent" : props.dragging ? "emphasized" : snoozed ? "info" : "muted"
        }
        data-testid={`sidebar-${shelf}-shelf-toggle`}
      >
        {props.label}
      </CollapsibleSectionHeader>
    </SortableSidebarMarker>
  );
}

// Fork: a custom group's header, or the built-in Active header. It is a drop
// target even while folded; a context click opens the group editor. Active
// carries an inbox icon and a stronger neutral tone so it never reads as a
// custom group.
function SidebarCustomGroupHeader(props: {
  marker: `custom-group:${string}` | "active-header";
  label: string;
  count: number;
  expanded: boolean;
  dragging: boolean;
  isDropTarget: boolean;
  onToggle: () => void;
  onManage: (() => void) | undefined;
}) {
  const { onManage } = props;
  const isActive = props.marker === "active-header";
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={isActive ? "sidebar-active-header" : undefined}
      className="mx-0.5 h-8"
    >
      <CollapsibleSectionHeader
        onClick={props.onToggle}
        onContextMenu={
          onManage
            ? (event) => {
                event.preventDefault();
                onManage();
              }
            : undefined
        }
        expanded={props.expanded}
        tone={props.isDropTarget ? "accent" : props.dragging || isActive ? "emphasized" : "muted"}
      >
        <span className="flex items-center gap-1.5">
          {isActive ? <InboxIcon aria-hidden className="size-3 shrink-0" /> : null}
          <span className="block max-w-48 truncate">
            {props.label}
            {props.expanded ? "" : ` (${props.count})`}
          </span>
        </span>
      </CollapsibleSectionHeader>
    </SortableSidebarMarker>
  );
}

const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  composer: ComposerThreadDraftState;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  isActive: boolean;
  compactCards: boolean;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
  onContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const { composer, draftId, onContextMenu, onDiscard, onNavigate } = props;
  const promptPreview =
    replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label)
      .trim()
      .split("\n", 1)[0] ?? "";
  // images mirrors persistedAttachments once rehydration finishes; before
  // that only the persisted list is populated, hence max not sum.
  const attachmentCount =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.files.length +
    composer.terminalContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length;
  const preview =
    promptPreview.length > 0
      ? promptPreview
      : `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
  const accessibility = resolveSidebarRowAccessibility({
    title: preview,
    statusLabel: "Unsent draft",
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });
  const handleActivate = () => onNavigate(draftId);
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    // Keys targeting the nested discard button belong to the button:
    // preventDefault here would swallow Space's synthesized click and
    // navigate instead of discarding.
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onContextMenu(draftId, { x: rect.left, y: rect.bottom });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onNavigate(draftId);
    }
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(draftId, { x: event.clientX, y: event.clientY });
  };
  const handleDiscard = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onDiscard(draftId);
  };
  return (
    <li className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-draft-row"
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive ? "bg-sidebar-row-active" : draftSurfaceClassName,
        )}
        onClick={handleActivate}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <span className="sr-only">{preview}</span>
        <div
          className={cn(
            // Matches the thread card height for the same density so draft
            // rows do not read as a different list.
            "relative z-10 px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
            props.compactCards ? "h-[3.5rem]" : "h-[4.875rem]",
          )}
        >
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <SquarePenIcon aria-hidden className={draftPenClassName} />
            {props.project ? (
              <ProjectFavicon project={props.project} className="size-4 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
              {props.projectDisplayName}
            </span>
            <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Discard draft"
                      onClick={handleDiscard}
                      className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">Discard draft</TooltipPopup>
              </Tooltip>
            </span>
          </div>
          <div aria-hidden className="mt-0.5 truncate text-sm font-medium text-foreground/90">
            {preview}
          </div>
        </div>
      </div>
    </li>
  );
});

interface SidebarDraftRowData {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
}

// Draft sessions with user content, surfaced as their own foldable section
// above the pinned block so an interrupted "new thread" stays one click
// away. Self-contained (own store subscription + closing divider) so
// per-keystroke composer updates re-render only this block, never the
// whole sidebar. Vanishes at count 0.
const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  scopedProjectKeys: ReadonlySet<string> | null;
  scopedEnvironmentIds: ReadonlySet<string> | null;
  hiddenProjectKeys: ReadonlySet<string>;
  routeDraftId: string | null;
  compactCards: boolean;
  onNavigateToDraft: (draftId: DraftId) => void;
  onDraftContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  // Folds like the other shelves and is remembered per device. The open
  // draft keeps its row while folded, the same exception every shelf makes.
  const [expanded, setExpanded] = useLocalStorage(DRAFTS_SHELF_EXPANDED_KEY, true, Schema.Boolean);
  const toggleExpanded = () => setExpanded((value) => !value);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore((store) => store.draftsByThreadKey);
  const [frozenActive, setFrozenActive] = useState<{
    routeDraftId: string | null;
    row: SidebarDraftRowData | null;
  }>({ routeDraftId: null, row: null });
  if (frozenActive.routeDraftId !== props.routeDraftId) {
    let row: SidebarDraftRowData | null = null;
    if (props.routeDraftId !== null) {
      const draftId = DraftId.make(props.routeDraftId);
      const session = draftThreadsByThreadKey[draftId];
      const composer = draftsByThreadKey[draftId];
      row =
        session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
          ? { draftId, session, composer }
          : null;
    }
    setFrozenActive({ routeDraftId: props.routeDraftId, row });
  }
  const drafts = (() => {
    const rows: SidebarDraftRowData[] = [];
    for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (
        props.scopedEnvironmentIds !== null &&
        !props.scopedEnvironmentIds.has(session.environmentId)
      ) {
        continue;
      }
      const sessionProjectKey = `${session.environmentId}:${session.projectId}`;
      if (props.hiddenProjectKeys.has(sessionProjectKey)) {
        continue;
      }
      if (props.scopedProjectKeys !== null && !props.scopedProjectKeys.has(sessionProjectKey)) {
        continue;
      }
      if (draftKey === props.routeDraftId) {
        if (frozenActive.routeDraftId === draftKey && frozenActive.row !== null) {
          rows.push(frozenActive.row);
        }
        continue;
      }
      const composer = draftsByThreadKey[draftKey];
      if (!composer || !composerDraftHasUserContent(composer)) {
        continue;
      }
      rows.push({ draftId: DraftId.make(draftKey), session, composer });
    }
    rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
    return rows;
  })();
  if (drafts.length === 0) {
    return null;
  }
  const visibleDrafts = expanded
    ? drafts
    : drafts.filter((draft) => draft.draftId === props.routeDraftId);
  return (
    <>
      <li data-thread-selection-safe className="list-none">
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          data-testid="sidebar-drafts-shelf-toggle"
          className="mb-1 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
        >
          <span className="text-xs font-medium text-muted-foreground/50">
            {expanded ? "Drafts" : `Drafts (${drafts.length})`}
          </span>
          <span className="h-px flex-1 bg-sidebar-border/60" />
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 text-muted-foreground/50 transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
      </li>
      {visibleDrafts.map(({ composer, draftId, session }) => {
        const projectKey = `${session.environmentId}:${session.projectId}`;
        return (
          <SidebarDraftRow
            key={draftId}
            draftId={draftId}
            composer={composer}
            project={props.projectByKey.get(projectKey) ?? null}
            projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
            isActive={draftId === props.routeDraftId}
            compactCards={props.compactCards}
            onNavigate={props.onNavigateToDraft}
            onDiscard={discardComposerDraft}
            onContextMenu={props.onDraftContextMenu}
          />
        );
      })}
      <li
        aria-hidden
        data-testid="sidebar-draft-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});

const dropVerbBadge: Record<SidebarDropVerb, ReactNode> = {
  pin: (
    <>
      <PinIcon aria-hidden className="size-3" />
      Pin
    </>
  ),
  unpin: (
    <>
      <PinOffIcon aria-hidden className="size-3" />
      Unpin
    </>
  ),
  settle: (
    <>
      <CircleCheckIcon aria-hidden className="size-3" />
      Settle
    </>
  ),
  unsettle: (
    <>
      <Undo2Icon aria-hidden className="size-3" />
      Un-settle
    </>
  ),
  wake: (
    <>
      <AlarmClockOffIcon aria-hidden className="size-3" />
      Wake
    </>
  ),
};

type SidebarThreadRowProps = {
  thread: SidebarThreadSummary;
  variant: "card" | "slim";
  variantAction: SidebarSweepAction;
  settlementSupported: boolean;
  snoozeSupported: boolean;
  // Fork: server accepts "Until it's done" (thread.snooze untilDone).
  snoozeUntilDoneSupported: boolean;
  // Renders the pin glyph. Pinned cards keep the full settle/snooze quick
  // actions: settling clears the pin server-side, and snoozing hides the
  // card until wake with the pin intact underneath. The glyph is also the
  // in-row pin state cue, so it always shows while pinned. Once the pinning
  // capability is confirmed the hover actions add a pin/unpin toggle and the
  // glyph becomes a clickable unpin quick-action; it stays a passive marker
  // while the descriptor is not loaded.
  pinningSupported: boolean;
  isPinned: boolean;
  sortable?: SortableThreadRowBag | undefined;
  dropVerb: SidebarDropVerb | null;
  /** Fork: "Move to <group>" while the lifted row hovers another custom group. */
  dropGroupLabel?: string | null;
  dragOverPinned: boolean;
  sweepAction: SidebarSweepAction | null;
  snoozeWakeLabelText: string | null;
  wokeAt: string | null;
  // The wake came from the agent's work ending, not a timer: colored like Done.
  wokeOnFinishedWork: boolean;
  isActive: boolean;
  // Which split pane shows this thread, while the split view is on screen.
  splitPaneMarker: SplitPaneMarker | null;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  scratchMachineLabel: string | null;
  project: EnvironmentProject | null;
  // Null when the project has no accent, or when accent tints are switched off.
  projectAccentColor: SidebarProjectAccentColor | null;
  accentTintIntensityPercent: AccentTintIntensityPercent;
  compactCards: boolean;
  providerIconVisibility: SidebarThreadProviderIconVisibility;
  projectDisplayName: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  timestampFormat: TimestampFormat;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onActionSweepStart: (
    threadRef: ScopedThreadRef,
    action: SidebarSweepAction,
    event: PointerEvent,
  ) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  /** Forks the conversation; the hover action shows only where it can. */
  onFork: (threadRef: ScopedThreadRef) => void;
  /** Fork: hover archive toggle; archives, schedules for when done, or cancels. */
  onArchive: (
    threadRef: ScopedThreadRef,
    opts: { expectedAction: ReturnType<typeof resolveArchiveToggleAction> },
  ) => void;
  onSnooze: (
    threadRef: ScopedThreadRef,
    preset: Pick<SnoozePreset, "snoozedUntil" | "untilDone">,
  ) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  onPin: (threadRef: ScopedThreadRef) => void;
  onUnpin: (threadRef: ScopedThreadRef) => void;
  onAcknowledgeWoke: (threadRef: ScopedThreadRef, visitedAt: string) => void;
  onFileDropThreads?: ((threadRef: ScopedThreadRef, files: File[]) => void) | undefined;
};

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    isRenaming,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onAcknowledgeWoke,
    onFileDropThreads,
    onFork,
    onArchive,
    onRenameTitleChange,
    onSettle,
    onActionSweepStart,
    onSnooze,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
    onPin,
    onUnpin,
    openPullRequestsInRightPanel,
    renamingTitle,
    thread,
    variant,
    variantAction,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  useEffect(() => {
    if (!canOperateThread && isRenaming) onCancelRename();
  }, [canOperateThread, isRenaming, onCancelRename]);
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(props.isActive);
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const openPrLink = useOpenPrLink();
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const terminalProcessCount = runningTerminalIds.length;
  // Set while this thread's recording is playing or paused mid-way, so
  // pausing from the list keeps a way back in. A finished recording clears
  // it. The subscription re-renders the row only when the state flips, never
  // on the player's progress tick.
  const listeningState = useThreadListeningState(thread.environmentId, thread.id);
  // Both split panes are on screen, so both rows wear the open-thread
  // surface; isActive alone (the route thread) still drives navigation.
  const isOnScreen = props.isActive || props.splitPaneMarker !== null;
  const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !isOnScreen;
  const handleDiscardDraftClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    discardComposerDraft(threadRef);
  };

  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd, includeRemote: false },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const pr = linkedPullRequestStatus?.pr ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;

  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus(thread);
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
  const isWoke =
    wokeAtDate !== null &&
    (lastVisitedDate === null || lastVisitedDate < wokeAtDate) &&
    thread.settledOverride !== "settled";
  const shouldRecede = shouldRecedeSidebarThread({
    status,
    isUnread,
    isWoke,
    isActive: props.isActive,
    isSelected,
  });
  const topStatus =
    status === "working"
      ? {
          label: thread.goal?.status === "active" ? "Goal" : "Working",
          icon: "working" as const,
          className: "text-info",
        }
      : status === "monitoring"
        ? {
            // Watch loops alone (dev servers, monitors) outliving the turn:
            // sky like working, without the working icon or timer.
            label: "Monitoring",
            icon: null,
            className: "text-info",
          }
        : status === "waiting"
          ? {
              // Waiting is calm background presence (post-settle background
              // roster), not active progress, so the label keeps full strength.
              label: "Waiting",
              icon: "waiting" as const,
              className: "text-muted-foreground",
            }
          : status === "approval"
            ? {
                label: "Approval",
                icon: "approval" as const,
                className: "text-warning-foreground",
              }
            : status === "input"
              ? {
                  label: "Input",
                  icon: "input" as const,
                  className: "text-indigo-600 dark:text-indigo-300",
                }
              : status === "limited"
                ? {
                    label: "Limited",
                    icon: "failed" as const,
                    className: "text-warning",
                  }
                : status === "failed"
                  ? {
                      label: "Failed",
                      icon: "failed" as const,
                      className: "text-error",
                    }
                  : isWoke
                    ? {
                        label: "Woke",
                        icon: "woke" as const,
                        className: props.wokeOnFinishedWork ? "text-success" : "text-warning",
                      }
                    : isUnread
                      ? {
                          label: "Done",
                          icon: "done" as const,
                          className: "text-success",
                        }
                      : null;
  const isWokeStatus = topStatus?.icon === "woke";

  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider);

  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;

  const isRemote = thread.environmentId !== props.currentEnvironmentId;
  const showsScratchMachine = !thread.branch && props.scratchMachineLabel !== null;

  const detailsTooltip = (
    <SidebarThreadTooltip
      thread={thread}
      project={props.project}
      projectDisplayName={props.projectDisplayName}
      environmentLabel={props.environmentLabel}
      environmentMachine={props.environmentMachine}
      providerEntry={providerEntry}
      providerEntryByInstanceId={props.providerEntryByInstanceId}
      showInstanceBadge={showInstanceBadge}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={branchMismatch}
      terminalStatus={terminalStatus}
      terminalProcessCount={terminalProcessCount}
    />
  );

  const handleClick = (event: ReactMouseEvent) => {
    onThreadClick(event, threadRef);
  };
  const handleAcknowledgeWokeClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (props.wokeAt === null) return;
    onAcknowledgeWoke(threadRef, props.wokeAt);
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onThreadActivate(threadRef);
  };
  const handleDoubleClick = (event: ReactMouseEvent) => {
    if (
      !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) ||
      isRenaming ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    if ((event.target as HTMLElement).closest("button, a, input")) return;
    event.preventDefault();
    onStartRename(threadRef, thread.title);
  };
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = onFileDropThreads
    ? makeWorkspaceFileDropHandlers({
        setDragActive: setIsFileDragOver,
        addFiles: (files) => {
          onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      })
    : null;
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (isRenaming) renameCommittedRef.current = false;
  }, [isRenaming]);
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      renameCommittedRef.current = true;
      onCommitRename(threadRef, renamingTitle, thread.title);
    } else if (event.key === "Escape") {
      event.preventDefault();
      renameCommittedRef.current = true;
      onCancelRename();
    }
  };
  const handleRenameBlur = () => {
    if (!renameCommittedRef.current) {
      onCommitRename(threadRef, renamingTitle, thread.title);
    }
  };
  const handleSettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onSettle(threadRef);
  };
  const handleActionPointerDown = (event: ReactPointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.stopPropagation();
    onActionSweepStart(threadRef, variantAction, event.nativeEvent);
  };
  const handleUnsettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsettle(threadRef);
  };
  const handleForkClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onFork(threadRef);
  };
  const archiveAction = resolveArchiveToggleAction(thread);
  const archivePending = archiveAction === "cancel";
  const archiveLabel =
    archiveAction === "cancel"
      ? "Cancel pending archive"
      : archiveAction === "schedule"
        ? "Archive when done"
        : "Archive";
  const handleArchiveClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onArchive(threadRef, { expectedAction: archiveAction });
  };
  const showForkButton =
    canOperateThread &&
    canForkConversation(thread, {
      canForkImportedSession: canForkImportedSessionDriver(
        props.providerEntryByInstanceId.get(thread.providerInstanceId)?.driverKind,
      ),
    });
  const handleUnsnoozeClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsnooze(threadRef);
  };
  const handlePinToggleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (props.isPinned) {
      onUnpin(threadRef);
    } else {
      onPin(threadRef);
    }
  };
  const handleToggleListeningClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    toggleLoadedListeningTrack();
  };
  const handleSnoozePreset = (preset: Pick<SnoozePreset, "snoozedUntil" | "untilDone">) => {
    onSnooze(threadRef, preset);
  };
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // Fork: canSnooze takes no clock (steering a running thread keeps Snooze), so
  // upstream's queued-turn gate clock has nothing to reopen here.
  const showSnoozeButton = canOperateThread && props.snoozeSupported && canSnooze(thread);
  // Closing here, not just masking, keeps the menu from reopening when the button returns.
  if (snoozeMenuOpenRaw && !showSnoozeButton) setSnoozeMenuOpen(false);
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  const handlePrClick = (event: ReactMouseEvent<HTMLElement>, targetUrl?: string) => {
    const url = targetUrl ?? pr?.url ?? currentLinkedPr?.url;
    if (!url) return;
    const showInRightPanel = targetUrl !== undefined || openPullRequestsInRightPanel;
    const openedInRightPanel = openPrLink(event, url, showInRightPanel ? threadRef : undefined);
    if (openedInRightPanel && showInRightPanel && !props.isActive) {
      onThreadActivate(threadRef);
    }
  };

  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    variantAction === "unsettle" && "[&:not(:hover):not(:focus-within)_*]:text-secondary-label/70",
    isOnScreen
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : isSelected || props.sweepAction !== null
        ? "bg-sidebar-row-selected text-sidebar-foreground"
        : hasUnsentDraft
          ? cn(draftSurfaceClassName, "text-sidebar-foreground")
          : shouldRecede
            ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    shouldRecede &&
      status === "working" &&
      "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
    isFileDragOver && "ring-1 ring-inset ring-primary/70",
    isFileDragOver && !isOnScreen && !isSelected && "bg-sidebar-row-hover",
    props.sortable?.isDragging &&
      "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
  );
  // A flat gradient rather than backgroundColor: the tint has to sit *over*
  // the row's hover/active/selected background classes, not replace them.
  // Intensity is a client setting; `projectAccentColor` already arrives null
  // when tints are switched off, so the picker keeps working either way.
  const accentStyle = projectAccentTintStyle(
    props.projectAccentColor,
    props.accentTintIntensityPercent,
  );
  const rowAccentStyle =
    props.sortable?.isDragging && accentStyle?.backgroundImage
      ? {
          ...accentStyle,
          backgroundImage: `${accentStyle.backgroundImage}, linear-gradient(var(--sidebar-row-active), var(--sidebar-row-active)), linear-gradient(var(--sidebar), var(--sidebar))`,
        }
      : accentStyle;
  const sortable = props.sortable;
  const sortableRootProps = sortable
    ? {
        ref: sortable.setNodeRef,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          // A zero-height boundary also makes dnd-kit scale the source to
          // zero. Only projected peers use scaleY as a visibility sentinel.
          visibility:
            !sortable.isDragging && sortable.transform?.scaleY === 0
              ? ("hidden" as const)
              : undefined,
        },
        ...sortable.listeners,
      }
    : {};
  const destinationVerb = sortable?.isDragging
    ? props.dropVerb
    : props.sweepAction === "unsnooze"
      ? "wake"
      : props.sweepAction;
  // A group drop names its destination group; otherwise the verb badge.
  const dropGroupLabel = sortable?.isDragging ? (props.dropGroupLabel ?? null) : null;
  const dragDestination =
    destinationVerb !== null || dropGroupLabel ? (
      <span
        role="status"
        className="pointer-events-none ml-auto inline-flex h-5 max-w-[60%] shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
      >
        {dropGroupLabel ? (
          <span className="truncate">{dropGroupLabel}</span>
        ) : destinationVerb !== null ? (
          dropVerbBadge[destinationVerb]
        ) : null}
      </span>
    ) : null;

  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: topStatus?.label ?? null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });

  const title =
    isRenaming && canOperateThread ? (
      <input
        autoFocus
        value={renamingTitle}
        aria-label="Thread title"
        onChange={(event) => onRenameTitleChange(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={handleRenameKeyDown}
        onBlur={handleRenameBlur}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
      />
    ) : (
      <span
        aria-hidden
        className={cn(
          "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none",
          shouldRecede ? "font-normal" : "font-medium",
          variant === "card"
            ? cn(
                "truncate",
                shouldRecede
                  ? "text-secondary-label"
                  : isUnread || isWoke || status === "input"
                    ? "text-foreground"
                    : status === "failed"
                      ? "text-foreground/95"
                      : "text-foreground/90",
              )
            : cn(
                "truncate group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
                shouldRecede
                  ? "text-secondary-label/70"
                  : isOnScreen || isWoke || status === "input"
                    ? "text-foreground"
                    : isUnread
                      ? "text-muted-foreground"
                      : "text-secondary-label/70",
              ),
          isRegeneratingTitle && "opacity-55",
        )}
      >
        {thread.title}
      </span>
    );
  const accessibleTitle = isRenaming ? null : <span className="sr-only">{thread.title}</span>;

  const prBadgeShape = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(thread.pullRequests)
    : null;
  const handlePrListClick = () => {
    useRightPanelStore.getState().open(threadRef, "pull-requests");
    if (!props.isActive) onThreadActivate(threadRef);
  };
  const prBadge =
    prBadgeShape?.kind === "stack" || pr || currentLinkedPr ? (
      <ThreadPullRequestBadgeControl
        render={<InlineButton />}
        badge={prBadgeShape}
        pullRequests={thread.pullRequests}
        number={pr?.number ?? currentLinkedPr?.number}
        url={pr?.url ?? currentLinkedPr?.url}
        status={prStatus}
        onOpenList={handlePrListClick}
        onOpenPullRequest={handlePrClick}
      />
    ) : null;
  const terminalStatusIcon = (
    <ThreadTerminalStatusButton
      threadRef={threadRef}
      terminalIds={runningTerminalIds}
      onThreadActivate={onThreadActivate}
    />
  );
  // Only the two threads on screen ever get a non-null marker, so the list
  // stays quiet.
  const splitPaneIcon = props.splitPaneMarker ? (
    <SplitPaneMarkerIcon marker={props.splitPaneMarker} />
  ) : null;
  // The speaker doubles as the transport control: when the loaded track's
  // message row is not on screen, this is how the audio gets paused — and
  // resumed, so pausing from the list is never a one-way door. It stays
  // visible under row hover for exactly that reason.
  const listeningIndicator =
    listeningState !== null ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={listeningState === "playing" ? "Pause audio" : "Play audio"}
              onClick={handleToggleListeningClick}
              className="inline-flex cursor-pointer items-center rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          {listeningState === "playing" ? (
            <Volume2Icon aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <VolumeIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
          )}
        </TooltipTrigger>
        <TooltipPopup>{listeningState === "playing" ? "Pause audio" : "Play audio"}</TooltipPopup>
      </Tooltip>
    ) : null;
  // Fork: a scheduled (deferred) archive stays visible at a glance in both
  // row variants until it runs or is cancelled. Where the hover actions
  // include the archive toggle, the marker yields to it.
  const renderArchivePendingIndicator = (className?: string | false) =>
    hasPendingArchive(thread) ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="img"
              aria-label="Archives when done"
              className={cn("inline-flex items-center text-warning-foreground", className)}
            />
          }
        >
          <ArchiveIcon aria-hidden className="size-3 shrink-0" />
        </TooltipTrigger>
        <TooltipPopup>Archives when the current turn and background work finish</TooltipPopup>
      </Tooltip>
    ) : null;
  const draftIndicator = hasUnsentDraft ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Unsent draft"
            data-testid={`sidebar-draft-indicator-${thread.id}`}
            className="inline-flex shrink-0 items-center"
          />
        }
      >
        <SquarePenIcon aria-hidden className={draftPenClassName} />
      </TooltipTrigger>
      <TooltipPopup side="top">Unsent draft</TooltipPopup>
    </Tooltip>
  ) : null;
  const showPin =
    props.isPinned && (!sortable?.isDragging || (props.dragOverPinned && props.dropVerb === null));
  const pinIndicator = showPin ? (
    props.pinningSupported && canOperateThread && !sortable?.isDragging ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Unpin thread"
              onClick={handlePinToggleClick}
              className="group/unpin inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <PinIcon
            aria-hidden
            className="size-3 shrink-0 group-hover/unpin:hidden group-focus-visible/unpin:hidden"
          />
          <PinOffIcon
            aria-hidden
            className="hidden size-3 shrink-0 group-hover/unpin:block group-focus-visible/unpin:block"
          />
        </TooltipTrigger>
        <TooltipPopup>Unpin thread</TooltipPopup>
      </Tooltip>
    ) : (
      <PinIcon
        aria-label="Pinned"
        role="img"
        className="size-3 shrink-0 text-muted-foreground/65"
      />
    )
  ) : null;

  // Rides every row shape, slim rows included; the visibility setting decides
  // whether it shows at rest, on hover, or never.
  const providerIcon = (
    <SidebarProviderIcon visibility={props.providerIconVisibility}>
      <SidebarProviderStack
        thread={thread}
        providerEntryByInstanceId={props.providerEntryByInstanceId}
      />
    </SidebarProviderIcon>
  );

  if (variant === "slim") {
    return (
      <li
        data-thread-item={threadKey}
        {...sortableRootProps}
        {...(fileDropHandlers ?? {})}
        className={cn(
          "list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]",
          sortable?.isDragging && "relative z-20",
        )}
      >
        <Tooltip disabled={sortable?.isDragging}>
          <TooltipTrigger
            render={
              <div
                ref={rowRef}
                role="button"
                tabIndex={0}
                aria-label={accessibility.label}
                aria-current={accessibility.current}
                data-testid="sidebar-row-slim"
                aria-busy={isRegeneratingTitle || undefined}
                className={cn(rowSurfaceClassName, "flex h-9 items-center gap-2.5 px-2.5")}
                style={rowAccentStyle}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onKeyDown={handleKeyDown}
                onContextMenu={handleContextMenu}
              />
            }
          >
            {accessibleTitle}
            <span
              className={cn(
                "flex shrink-0 items-center transition-opacity",
                (!isOnScreen || variantAction === "unsettle") &&
                  "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
              )}
            >
              {props.project ? <ProjectFavicon project={props.project} className="size-4" /> : null}
            </span>
            {draftIndicator}
            {title}
            {listeningIndicator}
            {renderArchivePendingIndicator()}
            {pinIndicator}
            {providerIcon}
            {/* A settled or snoozed thread can still occupy a split pane, so
                the marker rides slim rows too — like the terminal and PR
                icons already do. */}
            {splitPaneIcon}
            {terminalStatusIcon}
            {isRegeneratingTitle ? (
              <span role="status" className="sr-only">
                Regenerating title
              </span>
            ) : null}
            {prBadge}
            {sortable?.isDragging ? (
              dragDestination
            ) : (
              <span
                className={cn(
                  "relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end",
                  props.sweepAction !== null && "hidden",
                )}
              >
                <span
                  className={cn(
                    "inline-flex justify-end tabular-nums text-secondary-label transition-opacity",
                    !isWoke && "group-any-hover/sidebar-row:opacity-0",
                  )}
                >
                  {variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                    <span className="text-xs text-info-foreground tabular-nums">
                      {props.snoozeWakeLabelText}
                    </span>
                  ) : isWoke ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Dismiss Woke notification"
                            disabled={!canOperateThread}
                            onClick={handleAcknowledgeWokeClick}
                            className={cn(
                              "inline-flex items-center gap-1 rounded-sm text-xs font-medium outline-none enabled:cursor-pointer enabled:hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              props.wokeOnFinishedWork
                                ? "text-success-foreground"
                                : "text-warning-foreground",
                            )}
                          >
                            <AlarmClockIcon aria-hidden className="size-3" />
                            <span role="status">Woke</span>
                          </button>
                        }
                      />
                      <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                    </Tooltip>
                  ) : (
                    <span className="text-xs">
                      <RelativeTimeLabel
                        timestamp={
                          variantAction === "unsettle"
                            ? resolveSettledThreadTimestamp(thread)
                            : threadTimeTimestamp(thread)
                        }
                      />
                    </span>
                  )}
                </span>
                {!canOperateThread ? null : variantAction === "unsnooze" ? (
                  !props.snoozeSupported ? null : (
                    <button
                      type="button"
                      aria-label="Wake thread now"
                      onClick={handleUnsnoozeClick}
                      onPointerDown={handleActionPointerDown}
                      className={cn(
                        "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                        isWoke && "group-any-hover/sidebar-row:static",
                      )}
                    >
                      <AlarmClockOffIcon className="mb-px size-3" />
                    </button>
                  )
                ) : !props.settlementSupported ? null : variantAction === "unsettle" ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label="Un-settle thread"
                          onClick={handleUnsettleClick}
                          onPointerDown={handleActionPointerDown}
                          className={cn(
                            "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                            isWoke && "group-any-hover/sidebar-row:static",
                          )}
                        />
                      }
                    >
                      <Undo2Icon className="mb-px size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">Un-settle thread</TooltipPopup>
                  </Tooltip>
                ) : (
                  <button
                    type="button"
                    aria-label="Settle thread"
                    onClick={handleSettleClick}
                    onPointerDown={handleActionPointerDown}
                    className={cn(
                      "pointer-events-none absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                      isWoke && "group-any-hover/sidebar-row:static",
                    )}
                  >
                    <CheckIcon className="size-3" />
                  </button>
                )}
              </span>
            )}
            {props.sweepAction !== null ? dragDestination : null}
            {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
          </TooltipTrigger>
          {detailsTooltip}
        </Tooltip>
      </li>
    );
  }

  const diff = latestRunDiff(thread);
  const diffStat = diff ? (
    <span className="shrink-0 font-mono text-xs">
      <span className="text-diff-addition-foreground">+{formatDiffCount(diff.insertions)}</span>{" "}
      <span className="text-diff-deletion-foreground">−{formatDiffCount(diff.deletions)}</span>
    </span>
  ) : null;
  // The full card's branch line already names a scratch thread's machine.
  const machineAndProvider = (hideMachine: boolean) => (
    <span
      aria-hidden
      className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"
    >
      {isRemote && !hideMachine ? (
        <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
          <EnvironmentMachineIcon
            aria-hidden
            kind={props.environmentMachine}
            className="size-3.5"
          />
        </span>
      ) : null}
      {providerIcon}
    </span>
  );

  return (
    <li
      data-thread-item={threadKey}
      {...sortableRootProps}
      {...(fileDropHandlers ?? {})}
      className={cn(
        // Matches the card content box; the py-0.5 padding is added on top.
        "list-none py-0.5 [content-visibility:auto]",
        props.compactCards
          ? "[contain-intrinsic-size:auto_56px]"
          : "[contain-intrinsic-size:auto_78px]",
        sortable?.isDragging && "relative z-20",
      )}
    >
      <Tooltip disabled={snoozeMenuOpen || sortable?.isDragging}>
        <TooltipTrigger
          render={
            <div
              ref={rowRef}
              role="button"
              tabIndex={0}
              aria-label={accessibility.label}
              aria-current={accessibility.current}
              data-testid="sidebar-row-card"
              data-compact={props.compactCards}
              aria-busy={isRegeneratingTitle || undefined}
              className={rowSurfaceClassName}
              style={rowAccentStyle}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          {accessibleTitle}
          <div
            className={cn(
              // Height is an exact fit for the rows inside: 20px header +
              // 4px gap + 20px title (+ 2px gap + 16px branch line when the
              // second line is shown), so the vertical padding must shrink
              // with it or the compact card sits 4px off-centre.
              "relative z-10 px-(--sidebar-row-content-inset)",
              props.compactCards
                ? "h-[3.5rem] py-1.5"
                : "h-[4.875rem] py-(--sidebar-content-inset)",
            )}
          >
            <div className="flex h-5 min-w-0 items-center gap-1.5">
              {draftIndicator}
              {props.project ? (
                <ProjectFavicon project={props.project} className="size-4 shrink-0" />
              ) : null}
              {props.projectDisplayName ? (
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-secondary-label text-xs",
                    shouldRecede ? "font-normal" : "font-medium",
                  )}
                >
                  {props.projectDisplayName}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              {listeningIndicator}
              {renderArchivePendingIndicator(
                canOperateThread &&
                  !sortable?.isDragging &&
                  cn(
                    "group-has-[:focus-visible]/sidebar-row:hidden group-any-hover/sidebar-row:hidden",
                    snoozeMenuOpen && "hidden",
                  ),
              )}
              {showPin ? (
                <PinIcon
                  aria-label="Pinned"
                  role="img"
                  className={cn(
                    "size-3 shrink-0 text-muted-foreground/65",
                    // The quick actions include their own interactive pin toggle.
                    props.pinningSupported &&
                      !sortable?.isDragging &&
                      "group-has-[:focus-visible]/sidebar-row:hidden group-hover/sidebar-row:hidden",
                    props.pinningSupported && snoozeMenuOpen && !sortable?.isDragging && "hidden",
                  )}
                />
              ) : null}
              {sortable?.isDragging ? (
                dragDestination
              ) : (
                <span
                  className={cn(
                    "group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs",
                    props.sweepAction !== null && "hidden",
                  )}
                >
                  <span
                    className={cn(
                      isWokeStatus
                        ? "pointer-events-auto"
                        : "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:absolute group-any-hover/sidebar-row:right-0 group-any-hover/sidebar-row:opacity-0",
                      "flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity",
                      snoozeMenuOpen && "pointer-events-none absolute right-0 opacity-0",
                    )}
                  >
                    {topStatus ? (
                      isWokeStatus ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label="Dismiss Woke notification"
                                disabled={!canOperateThread}
                                onClick={handleAcknowledgeWokeClick}
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-sm font-medium outline-none enabled:cursor-pointer enabled:hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                  topStatus.className,
                                )}
                              >
                                <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
                                <span role="status">{topStatus.label}</span>
                              </button>
                            }
                          />
                          <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                        </Tooltip>
                      ) : (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 font-medium",
                            topStatus.className,
                          )}
                        >
                          {topStatus.icon === "working" ? (
                            <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "waiting" ? (
                            <CircleDotDashedIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "input" ? (
                            <MessageCircleQuestionIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "approval" ? (
                            <ShieldQuestionIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "failed" ? (
                            <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "done" ? (
                            <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
                          ) : null}
                          {/* The label alone is the live region: a role="status"
                            wrapper around the ticking duration would make
                            screen readers announce every second. */}
                          <span role="status">{topStatus.label}</span>
                          {status === "working" ? (
                            <span aria-hidden>
                              <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />
                            </span>
                          ) : status === "waiting" ? (
                            <span aria-hidden>
                              <WorkingDuration startedAt={thread.latestRun?.completedAt ?? null} />
                            </span>
                          ) : null}
                        </span>
                      )
                    ) : (
                      <RelativeTimeLabel timestamp={threadTimeTimestamp(thread)} />
                    )}
                  </span>
                  <span
                    className={cn(
                      // focus-visible, not focus-within: a mouse click leaves
                      // the Settle button focused, and a plain focus-within
                      // would keep the controls pinned over the status label
                      // once the pointer moves away (e.g. after a failed
                      // settle) instead of cross-fading back.
                      "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100",
                      snoozeMenuOpen && "pointer-events-auto static opacity-100",
                    )}
                  >
                    {hasUnsentDraft ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label="Discard draft"
                              onClick={handleDiscardDraftClick}
                              className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                            />
                          }
                        >
                          <XIcon className="size-3.5" />
                        </TooltipTrigger>
                        <TooltipPopup side="top">Discard draft</TooltipPopup>
                      </Tooltip>
                    ) : null}
                    {props.pinningSupported && canOperateThread ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label={props.isPinned ? "Unpin thread" : "Pin thread"}
                              onClick={handlePinToggleClick}
                              className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-muted-foreground hover:text-foreground"
                            >
                              <PinIcon
                                className={cn("size-3.5", props.isPinned && "fill-current")}
                              />
                            </button>
                          }
                        />
                        <TooltipPopup>
                          {props.isPinned ? "Unpin thread" : "Pin thread"}
                        </TooltipPopup>
                      </Tooltip>
                    ) : null}
                    {showSnoozeButton ? (
                      <SnoozeMenuButton
                        open={snoozeMenuOpen}
                        onOpenChange={setSnoozeMenuOpen}
                        onSnooze={handleSnoozePreset}
                        timestampFormat={props.timestampFormat}
                        untilDoneOffered={
                          props.snoozeUntilDoneSupported && canSnoozeUntilDone(thread)
                        }
                      />
                    ) : null}
                    {props.settlementSupported && canOperateThread ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label="Settle thread"
                              onClick={handleSettleClick}
                              onPointerDown={handleActionPointerDown}
                              className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-muted-foreground hover:text-foreground"
                            />
                          }
                        >
                          <CheckIcon className="size-3.5" />
                        </TooltipTrigger>
                        <TooltipPopup>Settle thread</TooltipPopup>
                      </Tooltip>
                    ) : null}
                    {showForkButton ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label="Fork conversation"
                              onClick={handleForkClick}
                              className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-muted-foreground hover:text-foreground"
                            >
                              <GitForkIcon className="size-3.5" />
                            </button>
                          }
                        />
                        <TooltipPopup>Fork conversation</TooltipPopup>
                      </Tooltip>
                    ) : null}
                    {canOperateThread ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label={archiveLabel}
                              aria-pressed={archivePending}
                              onClick={handleArchiveClick}
                              // Keeps a press from picking up the row for a reorder drag,
                              // whose sensor would swallow the release click.
                              onPointerDown={(event) => event.stopPropagation()}
                              className={cn(
                                "-mr-1 inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-muted-foreground hover:text-foreground",
                                archivePending && "text-warning-foreground",
                              )}
                            >
                              <ArchiveIcon className="size-3.5" />
                            </button>
                          }
                        />
                        <TooltipPopup>{archiveLabel}</TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </span>
                </span>
              )}
              {props.sweepAction !== null ? dragDestination : null}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              {title}
              {/* Compact cards drop the branch line, so its trailing details
                  ride the title line instead. The worktree marker is anchored
                  to the branch on full cards and comes along here. Hidden while
                  renaming so the input keeps the row. */}
              {props.compactCards && !isRenaming ? (
                <>
                  {splitPaneIcon}
                  <ThreadWorktreeIndicator thread={thread} />
                  {terminalStatusIcon}
                  {prBadge}
                  {diffStat}
                  {machineAndProvider(false)}
                </>
              ) : null}
              {isRegeneratingTitle ? (
                <span role="status" className="sr-only">
                  Regenerating title
                </span>
              ) : null}
            </div>
            {!props.compactCards ? (
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
                {/* Always the branch. The plan step used to take this slot while
                    working, but it truncated to a half-sentence and dropped the
                    branch, so the row lost its most stable identifier. */}
                {thread.branch ? (
                  <>
                    <ThreadWorktreeIndicator thread={thread} />
                    <span className="flex min-w-0 flex-1 text-muted-foreground/40">
                      <MiddleTruncate value={thread.branch} showTitle={false} />
                    </span>
                  </>
                ) : showsScratchMachine ? (
                  <>
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={props.environmentMachine}
                      className="size-3 shrink-0 text-muted-foreground/40"
                    />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground/40">
                      {props.scratchMachineLabel}
                    </span>
                  </>
                ) : (
                  <span className="flex-1" />
                )}
                {splitPaneIcon}
                {terminalStatusIcon}
                {prBadge}
                {diffStat}
                {machineAndProvider(showsScratchMachine)}
              </div>
            ) : null}
          </div>
          {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        </TooltipTrigger>
        {detailsTooltip}
      </Tooltip>
    </li>
  );
});

function latestRunDiff(
  thread: SidebarThreadSummary,
): { insertions: number; deletions: number } | null {
  void thread;
  return null;
}

// Fork: a row of the recent-archive shelf; opening it shows the archived thread.
const SidebarV2ArchivedRow = memo(function SidebarV2ArchivedRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly project: ProjectFaviconProject | null;
  readonly projectTitle: string | null;
  readonly projectAccentColor: SidebarProjectAccentColor | null;
  readonly accentTintIntensityPercent: AccentTintIntensityPercent;
  readonly isActive: boolean;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  readonly onUnarchive: (threadRef: ScopedThreadRef) => void;
  readonly onContextMenu: (
    thread: EnvironmentThreadShell,
    position: { x: number; y: number },
  ) => void;
}) {
  const threadRef = scopeThreadRef(props.thread.environmentId, props.thread.id);
  const canOperateThread = useEnvironmentScope(
    props.thread.environmentId,
    AuthOrchestrationOperateScope,
  );
  return (
    <li
      className="group/v2-archived-row relative list-none"
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(props.thread, { x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        aria-current={props.isActive ? "page" : undefined}
        className={cn(
          "flex h-10 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sidebar-muted-foreground/65 outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive && "bg-sidebar-row-hover text-sidebar-foreground",
        )}
        style={projectAccentTintStyle(props.projectAccentColor, props.accentTintIntensityPercent)}
        onClick={() => props.onOpen(threadRef)}
      >
        {props.project ? (
          <ProjectFavicon project={props.project} className="size-3.5 shrink-0 opacity-60" />
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{props.thread.title}</span>
          {props.projectTitle ? (
            <span className="block truncate text-3xs text-muted-foreground/50">
              {props.projectTitle}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "text-3xs tabular-nums text-muted-foreground/45",
            canOperateThread &&
              "group-hover/v2-archived-row:hidden group-focus-within/v2-archived-row:hidden",
          )}
        >
          {formatCompactRelativeTimeLabel(
            props.thread.archivedAt ?? props.thread.updatedAt ?? props.thread.createdAt,
          )}
        </span>
      </button>
      {canOperateThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Unarchive ${props.thread.title}`}
                className="pointer-events-none absolute right-1.5 top-1.5 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/v2-archived-row:pointer-events-auto group-hover/v2-archived-row:opacity-100 group-focus-within/v2-archived-row:pointer-events-auto group-focus-within/v2-archived-row:opacity-100"
                onClick={() => props.onUnarchive(threadRef)}
              >
                <Undo2Icon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup>Unarchive</TooltipPopup>
        </Tooltip>
      ) : null}
    </li>
  );
});

const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  isSettled: boolean;
  thread: SidebarThreadSummary;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  projectAccentColor: SidebarProjectAccentColor | null;
  accentTintIntensityPercent: AccentTintIntensityPercent;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  searchMatch: EnvironmentThreadSearchMatch | null;
  searchQuery: string;
  onHighlight: () => void;
  onSelect: () => void;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}) {
  const { thread } = props;
  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isRouteActive,
  });
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(
    props.isHighlighted || props.isRouteActive,
  );
  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd, includeRemote: false },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const onFileDropThreads = props.onFileDropThreads;
  const fileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: setIsFileDragOver,
    addFiles: (files) => {
      onFileDropThreads(threadRef, files);
    },
    addFolders: () => {},
  });
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  return (
    <li role="presentation" className="list-none" {...fileDropHandlers}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={rowRef}
              id={props.resultId}
              data-search-result-key={scopedThreadKey(threadRef)}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={props.isHighlighted}
              aria-current={accessibility.current}
              aria-describedby={`${props.resultId}-pr`}
              aria-label={accessibility.label}
              onMouseMove={props.onHighlight}
              onClick={props.onSelect}
              className={cn(
                "group/sidebar-row group/v2-row flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
                props.isHighlighted || props.isRouteActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                isFileDragOver && "ring-1 ring-inset ring-primary/70",
                isFileDragOver && !props.isRouteActive && "bg-sidebar-row-hover",
              )}
              style={projectAccentTintStyle(
                props.projectAccentColor,
                props.accentTintIntensityPercent,
              )}
            />
          }
        >
          {props.project ? (
            <ProjectFavicon
              project={props.project}
              className={cn(
                "size-4 shrink-0 transition-opacity",
                props.isSettled &&
                  !props.isRouteActive &&
                  !props.isHighlighted &&
                  "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
              )}
            />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2.5">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  props.isSettled
                    ? "font-normal text-secondary-label/70 group-hover/sidebar-row:text-foreground"
                    : "font-medium text-foreground",
                  (props.isHighlighted || props.isRouteActive) && "text-foreground",
                  thread.titleRegeneration != null && "opacity-55",
                )}
              >
                {thread.title}
              </span>
              <span id={`${props.resultId}-pr`} className="contents">
                <ThreadSearchPullRequestNumber
                  thread={thread}
                  query={props.searchQuery}
                  enabled={leaseLiveStatus}
                  settled={props.isSettled}
                />
              </span>
              <span className="w-8 shrink-0 text-right text-xs text-muted-foreground/55 tabular-nums">
                <RelativeTimeLabel timestamp={threadTimeTimestamp(thread)} />
              </span>
            </span>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt
                match={{
                  source: props.searchMatch.source,
                  snippet: props.searchMatch.snippet,
                  query: props.searchQuery,
                }}
              />
            ) : null}
          </span>
        </TooltipTrigger>
        <SidebarThreadTooltip
          thread={thread}
          project={props.project}
          projectDisplayName={props.projectDisplayName}
          environmentLabel={props.environmentLabel}
          environmentMachine={props.environmentMachine}
          providerEntry={providerEntry}
          providerEntryByInstanceId={props.providerEntryByInstanceId}
          showInstanceBadge={showInstanceBadge}
          modelInstanceId={modelInstanceId}
          modelLabel={modelLabel}
          branchMismatch={branchMismatch}
          terminalStatus={terminalStatus}
          terminalProcessCount={runningTerminalIds.length}
        />
      </Tooltip>
    </li>
  );
});

// Everything Sidebar derives from thread shells. Computed inside one hook so
// each value reaches the component frozen and cached on its real inputs: in
// the component body, later hook calls made the compiler treat these maps as
// possibly mutated and recompute them, and every dnd-kit input and row
// callback with them. Fork: the environment/project filters, custom groups and
// the foldable Pinned/Active shelves live here too.
function useSidebarThreads(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly environmentScope: ReadonlySet<string> | null;
  readonly environmentScopeActive: boolean;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly hiddenProjectKeys: ReadonlySet<string>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly optimisticDrop: SidebarOptimisticDrop | null;
  readonly workingShelfEnabled: boolean;
  readonly routeThreadKey: string | null;
  readonly settledResetKey: string;
  readonly isSearchingThreads: boolean;
  readonly groups: ReturnType<typeof useThreadGroupCatalog>["groups"];
}) {
  const {
    threads,
    environmentScope,
    environmentScopeActive,
    scopedProjectKeys,
    hiddenProjectKeys,
    serverConfigs,
    optimisticDrop,
    workingShelfEnabled,
    routeThreadKey,
    settledResetKey,
    isSearchingThreads,
    groups,
  } = input;
  const hasCustomGroups = groups.length > 0;
  const [collapsedGroupIds, setCollapsedGroupIds] = useLocalStorage(
    "t3:collapsed-thread-groups",
    [] as readonly string[],
    COLLAPSED_GROUP_IDS_SCHEMA,
  );
  const nowMinute = useNowMinute();
  // Snooze wake times are second-precise, so classifying with the quantized
  // minute would hold a woken thread on the shelf for up to a minute.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  const [nextWakeAt, setNextWakeAt] = useState<string | null>(null);
  // Arm a timeout for the earliest upcoming wake so the shelf empties the
  // moment a snooze expires instead of on the next minute tick.
  useEffect(
    () => scheduleSnoozeWake(nextWakeAt, () => bumpSnoozeWakeTick((tick) => tick + 1)),
    [nextWakeAt],
  );
  // The settled tail restarts whenever a project or environment filter changes.
  const [settledTail, setSettledTail] = useState({
    resetKey: settledResetKey,
    count: SETTLED_TAIL_INITIAL_COUNT,
  });
  if (settledTail.resetKey !== settledResetKey) {
    setSettledTail({ resetKey: settledResetKey, count: SETTLED_TAIL_INITIAL_COUNT });
  }
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  // Pinned is the block the user curated to the top, so it starts expanded;
  // folding it is still remembered per device like every other shelf.
  const [pinnedShelfExpanded, setPinnedShelfExpanded] = useLocalStorage(
    PINNED_SHELF_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const [workingShelfExpanded, setWorkingShelfExpanded] = useLocalStorage(
    WORKING_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  // Fork: the built-in Active group folds like a custom group, open by
  // default and remembered per device under its own key.
  const [activeShelfExpanded, setActiveShelfExpanded] = useLocalStorage(
    ACTIVE_SHELF_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );

  const collapsedGroups = new Set(collapsedGroupIds);
  const partition = partitionSidebarThreads({
    threads,
    environmentScope,
    environmentScopeActive,
    scopedProjectKeys,
    hiddenProjectKeys,
    serverConfigs,
    optimisticDrop,
    workingShelfEnabled,
    clockKey: `${nowMinute}:${snoozeWakeTick}`,
  });
  const { pinnedThreads, activeThreads, workingThreads, snoozedThreads, settledThreads } =
    partition;
  const partitionNextWakeAt = nextSnoozeWakeAt(snoozedThreads);
  if (partitionNextWakeAt !== nextWakeAt) setNextWakeAt(partitionNextWakeAt);

  const settledVisibleCount =
    settledTail.resetKey === settledResetKey ? settledTail.count : SETTLED_TAIL_INITIAL_COUNT;
  const visibleSettledThreads = (() => {
    if (settledThreads.length <= settledVisibleCount) return settledThreads;
    const visible = settledThreads.slice(0, settledVisibleCount);
    if (routeThreadKey !== null) {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find((thread) => threadShellKey(thread) === routeThreadKey);
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible;
  })();
  const hiddenSettledCount = settledThreads.length - visibleSettledThreads.length;
  const renderedSettledThreads = settledShelfExpanded
    ? visibleSettledThreads
    : routeThreadOnly(visibleSettledThreads, routeThreadKey);
  // Same exception every other shelf makes: the open thread keeps its row,
  // so a folded pinned block never hides the thread being read.
  const visiblePinnedThreads = pinnedShelfExpanded
    ? pinnedThreads
    : routeThreadOnly(pinnedThreads, routeThreadKey);
  const visibleSnoozedThreads = snoozedShelfExpanded
    ? snoozedThreads
    : routeThreadOnly(snoozedThreads, routeThreadKey);
  const visibleWorkingThreads = workingShelfExpanded
    ? workingThreads
    : routeThreadOnly(workingThreads, routeThreadKey);
  // Fork: Active split into custom group sections (Active itself is null),
  // in catalog placement order; without groups, Active is the only section.
  // A folded section keeps the open thread's row, and search shows every match.
  const activeGroupSections = (() => {
    const sections = new Map<string | null, EnvironmentThreadShell[]>([
      [null, []],
      ...groups.map((group) => [group.id, [] as EnvironmentThreadShell[]] as const),
    ]);
    for (const thread of activeThreads) sections.get(threadGroupId(thread, groups))!.push(thread);
    return threadGroupSections(groups).map((group) => ({
      id: group?.id ?? null,
      threads: sections
        .get(group?.id ?? null)!
        .filter(
          (thread) =>
            (group === null ? activeShelfExpanded : !collapsedGroups.has(group.id)) ||
            isSearchingThreads ||
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
        ),
    }));
  })();

  const orderedThreads = [
    ...visiblePinnedThreads,
    ...activeGroupSections.flatMap((section) => section.threads),
    ...visibleWorkingThreads,
    ...visibleSnoozedThreads,
    ...renderedSettledThreads,
  ];
  const sidebarListItemsFresh = ((): readonly SidebarListItem[] => {
    const rowsOf = (
      list: readonly EnvironmentThreadShell[],
      section: SidebarSection,
    ): SidebarListItem[] =>
      list.map((thread) => {
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        return hasCustomGroups
          ? {
              kind: "thread",
              key,
              section,
              customGroupId: threadGroupId(thread, groups),
            }
          : { kind: "thread", key, section };
      });
    if (
      pinnedThreads.length +
        activeThreads.length +
        workingThreads.length +
        snoozedThreads.length +
        settledThreads.length +
        groups.length ===
      0
    ) {
      return [];
    }
    const items: SidebarListItem[] = [{ kind: "marker", marker: "pinned-header" }];
    const pinnedRows = rowsOf(visiblePinnedThreads, "pinned");
    items.push(...pinnedRows);
    items.push({ kind: "marker", marker: "pinned-divider" });
    // Fork: Active and each custom group get a header (a drop target even
    // when folded).
    for (const section of activeGroupSections) {
      if (section.id !== null) items.push({ kind: "marker", marker: `custom-group:${section.id}` });
      else {
        items.push({ kind: "marker", marker: "active-header" });
        items.push({ kind: "marker", marker: "active-placeholder" });
      }
      items.push(...rowsOf(section.threads, "active"));
    }
    if (workingThreads.length > 0) {
      items.push({ kind: "marker", marker: "working-header" });
      items.push(...rowsOf(visibleWorkingThreads, "working"));
    }
    if (snoozedThreads.length > 0) {
      items.push({ kind: "marker", marker: "snoozed-header" });
      items.push(...rowsOf(visibleSnoozedThreads, "snoozed"));
    }
    items.push({ kind: "marker", marker: "settled-header" });
    const settledRows = rowsOf(renderedSettledThreads, "settled");
    items.push({ kind: "marker", marker: "settled-placeholder" });
    items.push(...settledRows);
    return items;
  })();
  // Thread shells update on every streamed event without moving rows. Keep the
  // list's identity until its order changes, so the sorting strategy, the
  // sortable context and every sortable row stay memoized meanwhile. Fork: a
  // row's custom group is part of its slot.
  const sidebarListItemsKey = sidebarListItemsFresh
    .map((item) =>
      item.kind === "thread"
        ? item.section + ":" + item.key + ":" + (item.customGroupId ?? "")
        : item.marker,
    )
    .join("\n");
  const sectionByThreadKey = new Map<string, SidebarSection>();
  for (const [list, section] of [
    [pinnedThreads, "pinned"],
    [activeThreads, "active"],
    [workingThreads, "working"],
    [snoozedThreads, "snoozed"],
    [settledThreads, "settled"],
  ] as const) {
    for (const thread of list) sectionByThreadKey.set(threadShellKey(thread), section);
  }
  return {
    ...partition,
    searchableThreads: [
      ...pinnedThreads,
      ...activeThreads,
      ...workingThreads,
      ...snoozedThreads,
      ...settledThreads,
    ],
    collapsedGroups,
    toggleCustomGroup: (id: string) =>
      setCollapsedGroupIds((current) =>
        current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
      ),
    expandCustomGroup: (id: string) =>
      setCollapsedGroupIds((current) => current.filter((entry) => entry !== id)),
    settledVisibleCount,
    hiddenSettledCount,
    showMoreSettled: () =>
      setSettledTail((current) => ({
        resetKey: current.resetKey,
        count: current.count + SETTLED_TAIL_PAGE_COUNT,
      })),
    settledShelfExpanded,
    toggleSettledShelf: () => setSettledShelfExpanded((value) => !value),
    snoozedShelfExpanded,
    toggleSnoozedShelf: () => setSnoozedShelfExpanded((value) => !value),
    pinnedShelfExpanded,
    togglePinnedShelf: () => setPinnedShelfExpanded((value) => !value),
    workingShelfExpanded,
    toggleWorkingShelf: () => setWorkingShelfExpanded((value) => !value),
    activeShelfExpanded,
    toggleActiveShelf: () => setActiveShelfExpanded((value) => !value),
    expandActiveShelf: () => setActiveShelfExpanded(true),
    renderedSettledThreads,
    visibleWorkingThreads,
    sidebarListItemsFresh,
    sidebarListItemsKey,
    orderedThreadKeys: orderedThreads.map(threadShellKey),
    threadByKey: new Map(orderedThreads.map((thread) => [threadShellKey(thread), thread] as const)),
    settledThreadKeys: new Set(settledThreads.map(threadShellKey)),
    snoozedThreadKeys: new Set(snoozedThreads.map(threadShellKey)),
    sectionByThreadKey,
    pinnedKeys: visiblePinnedThreads.map(threadShellKey),
    activeKeys: activeThreads.map(threadShellKey),
    foldedGroupIds: new Set<string | null>(
      activeShelfExpanded ? collapsedGroups : [...collapsedGroups, null],
    ),
    pinnedKeysById: new Map(
      threads.map((thread) => [threadShellKey(thread), thread.pinOrderKey ?? null] as const),
    ),
    activeKeysById: new Map(
      threads.map((thread) => [threadShellKey(thread), thread.activeOrderKey ?? null] as const),
    ),
  };
}

// Fork: the recent-archive shelf, folded by default and remembered per device
// like the snoozed shelf; the open thread keeps its row either way. A hook so
// the route key it reads stays frozen for the rest of Sidebar.
function useSidebarRecentArchive(input: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly hiddenProjectKeys: ReadonlySet<string>;
  readonly routeThreadKey: string | null;
}) {
  const { environmentIds, projects, scopedProjectKeys, hiddenProjectKeys, routeThreadKey } = input;
  const visibleCount = useClientSettings((s) =>
    clampArchivedSectionVisibleCount(s.archivedSectionVisibleCount),
  );
  const [expanded, setExpanded] = useLocalStorage(
    ARCHIVED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  // The archive shelf follows the environment and project filters the way
  // live rows do: per environment, the physical project ids left after
  // scoping and hiding. No project filter keeps the unrestricted query.
  const projectIdsByEnvironment = (() => {
    if (scopedProjectKeys === null && hiddenProjectKeys.size === 0) return undefined;
    const byEnvironment = new Map<EnvironmentId, ProjectId[]>();
    for (const environmentId of environmentIds) {
      byEnvironment.set(environmentId, []);
    }
    for (const project of projects) {
      const projectKey = `${project.environmentId}:${project.id}`;
      if (hiddenProjectKeys.has(projectKey)) continue;
      if (scopedProjectKeys !== null && !scopedProjectKeys.has(projectKey)) continue;
      byEnvironment.get(project.environmentId)?.push(project.id);
    }
    return byEnvironment;
  })();
  const { snapshots } = useRecentArchivedThreadSnapshots(
    environmentIds,
    visibleCount,
    projectIdsByEnvironment,
  );
  const recent = selectRecentArchivedThreads(snapshots, visibleCount, routeThreadKey);
  return {
    totalCount: recent.totalCount,
    expanded,
    toggleExpanded: () => setExpanded((value) => !value),
    visibleThreads: expanded
      ? recent.threads
      : recent.threads.filter((thread) => threadShellKey(thread) === routeThreadKey),
  };
}

export default function Sidebar() {
  const {
    projects,
    serverConfigs,
    projectGroups,
    environmentLabelById,
    providerEntriesByEnvironment,
    projectByKey,
    projectDisplayNameByKey,
  } = useSidebarLookups();
  const storedProjectScopeKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
  const storedHiddenProjectKeys = useUiStateStore((store) => store.sidebarHiddenProjectKeys);
  const updateSidebarProjectFilters = useUiStateStore((store) => store.updateSidebarProjectFilters);
  const threads = useThreadShells();
  // Fork: custom thread groups. Headers appear only while the catalog has groups.
  const customGroups = useThreadGroupCatalog();
  const hasCustomGroups = customGroups.groups.length > 0;
  const threadGroupsButton = useClientSettings((s) => s.sidebarThreadGroupsButton);
  const allEnvironmentShellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadUnpin = useClientSettings((s) => s.confirmThreadUnpin);
  // Accents are server settings, merged across every connected environment —
  // that is what makes them reach the mobile app and other machines.
  const projectAccentColors = useProjectAccentColors();
  // Whether those accents tint rows, and how strongly, is a per-client choice.
  const accentTint = useAccentTintSettings();
  useProjectAccentColorMigration(projects);
  const compactCards = useClientSettings((s) => s.sidebarV2CompactCards);
  const newThreadButtonInProjectRow = useClientSettings(
    (s) => s.sidebarV2NewThreadButtonInProjectRow,
  );
  const providerIconVisibility = useClientSettings((s) => s.sidebarThreadProviderIconVisibility);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const workingShelfEnabled = useClientSettings((s) => s.sidebarWorkingShelfEnabled);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    confirmAndUnpinThread,
    setThreadAutoSettle,
    reorderPinnedThread,
    reorderActiveThread,
    setThreadCustomGroup,
    markThreadUnread,
    attemptArchiveThread,
    deleteThread,
    forkThread,
    unarchiveThread,
    confirmAndDeleteThread,
  } = useThreadActions();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({
        type: "success",
        title: "Branch copied",
        description: branch,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy branch",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    target: "thread ID",
    onCopy: ({ threadId }) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const [projectScopeMenuOpen, setProjectScopeMenuOpen] = useState(false);
  const newThreadContext = useHandleNewThread();
  const openAddProjectCommandPalette = () => openCommandPalette({ open: "add-project" });
  // The environment filter needs the presentation records and catalog readiness.
  const { environments: environmentPresentations, isReady: environmentsReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const acknowledgeWoke = useAcknowledgeThreadWoke();
  const routeTarget = useThreadRouteTarget();
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
  // A template literal so the compiler knows the key is a primitive: as an
  // opaque value it would alias routeThreadRef, and every helper call taking the
  // key would count as a mutation spanning the hooks below, leaving the sorting
  // strategy and the row callbacks uncached.
  const routeThreadKey = routeThreadRef ? `${scopedThreadKey(routeThreadRef)}` : null;
  const splitSecondaryKey = useSplitSecondaryThreadKey();
  const routeThreadKeyRef = useRef(routeThreadKey);

  const environmentMachineById = useEnvironmentMachines();
  const projectGroupsRef = useRef(projectGroups);
  const resolvedProjectScopeKeysRef = useRef<SidebarProjectScope>(null);
  const listMotionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const projectAccentColorByKey = useProjectAccentColorByKey(projectGroups);

  // Project visibility is persisted because /settings routes temporarily unmount
  // the sidebar, and because a reload must not silently widen the view. Scope
  // and hidden keys are mutually exclusive; each interaction writes both lists
  // together so the latest click wins without stale overlap.
  const projectScopeKeys: SidebarProjectScope =
    storedProjectScopeKeys === null ? null : new Set(storedProjectScopeKeys);
  const hiddenProjectKeys = new Set(storedHiddenProjectKeys);
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const scratchMachineLabelFor = (
    thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">,
  ) => {
    if (!showProjectEnvironments) return null;
    const project = projectByKey.get(`${thread.environmentId}:${thread.projectId}`);
    if (
      !project ||
      !isScratchProject(project, serverConfigs.get(thread.environmentId)?.scratchWorkspaceRoot)
    ) {
      return null;
    }
    return environmentLabelById.get(thread.environmentId) ?? null;
  };
  const scopedProjectGroups =
    projectScopeKeys === null
      ? []
      : projectGroups.filter((project) => projectScopeKeys.has(project.projectKey));
  const singleScopedProjectGroup =
    projectScopeKeys?.size === 1 && scopedProjectGroups.length === 1
      ? scopedProjectGroups[0]!
      : null;
  const resolvedProjectScopeKeys = resolveSidebarProjectScope(projectGroups, projectScopeKeys);
  const scopedProjectKeys = resolveSidebarProjectScopePhysicalKeys(
    projectGroups,
    resolvedProjectScopeKeys,
  );
  const resolvedHiddenProjectKeys =
    resolveSidebarProjectScope(projectGroups, hiddenProjectKeys) ?? new Set<string>();
  const hiddenPhysicalProjectKeys =
    resolveSidebarProjectScopePhysicalKeys(projectGroups, resolvedHiddenProjectKeys) ??
    new Set<string>();
  const environmentFilter = useSidebarEnvironmentFilter({
    environments: environmentPresentations,
    environmentsReady,
    primaryEnvironmentId,
    threads,
    hiddenProjectKeys: hiddenPhysicalProjectKeys,
    scopedProjectKeys,
    // Every filter that can independently empty the list belongs here, or the
    // environment message claims a result it did not cause and its button
    // clears the wrong thing.
    shellsBootstrapped: allEnvironmentShellsBootstrapped,
  });
  const recentArchive = useSidebarRecentArchive({
    environmentIds: environmentFilter.environmentIds,
    projects,
    scopedProjectKeys,
    hiddenProjectKeys: hiddenPhysicalProjectKeys,
    routeThreadKey,
  });
  const selectProjectScope = (scopeKey: string) => {
    updateSidebarProjectFilters((current) => {
      const next = toggleSidebarProjectSelection(
        {
          scope: resolveSidebarProjectScope(
            projectGroups,
            current.scopeKeys === null ? null : new Set(current.scopeKeys),
          ),
          hidden: new Set(current.hiddenProjectKeys),
        },
        scopeKey,
      );
      return {
        scopeKeys: next.scope === null ? null : [...next.scope],
        hiddenProjectKeys: [...next.hidden],
      };
    });
  };
  const toggleProjectHidden = (scopeKey: string) => {
    updateSidebarProjectFilters((current) => {
      const storedScope = current.scopeKeys === null ? null : new Set(current.scopeKeys);
      const isHiding = !current.hiddenProjectKeys.includes(scopeKey);
      const next = toggleSidebarProjectHidden(
        {
          scope: isHiding ? resolveSidebarProjectScope(projectGroups, storedScope) : storedScope,
          hidden: new Set(current.hiddenProjectKeys),
        },
        scopeKey,
      );
      return {
        scopeKeys: next.scope === null ? null : [...next.scope],
        hiddenProjectKeys: [...next.hidden],
      };
    });
  };
  const clearProjectFilters = () =>
    updateSidebarProjectFilters(() => ({ scopeKeys: null, hiddenProjectKeys: [] }));
  // The thread menu's "Filter by project" over the persisted multi-select:
  // isolate this project, or return to all projects when it is already alone.
  const isolateProjectScope = (scopeKey: string) => {
    updateSidebarProjectFilters((current) => {
      const next = toggleSidebarProjectIsolation(
        {
          scope: resolveSidebarProjectScope(
            projectGroups,
            current.scopeKeys === null ? null : new Set(current.scopeKeys),
          ),
          hidden: new Set(current.hiddenProjectKeys),
        },
        scopeKey,
      );
      return {
        scopeKeys: next.scope === null ? null : [...next.scope],
        hiddenProjectKeys: [...next.hidden],
      };
    });
  };
  // Keyed on the stored intent, not the resolved scope: clearing the selection
  // and collapsing the settled tail answer "the user changed the filter", and
  // an environment reconnecting must not wipe staged bulk work. Bulk actions
  // already ignore selected keys whose rows are not rendered.
  const projectFilterSignature = `${sidebarProjectScopeSignature(projectScopeKeys)}|hidden:${JSON.stringify(
    [...hiddenProjectKeys].toSorted(),
  )}`;
  // The menu stays open across clicks now that it multi-selects, and
  // projectGroups is activity-sorted, so a background thread update would
  // reorder rows under the pointer mid-selection. Freeze the order while the
  // popup is open; projects added or removed meanwhile still appear.
  const [openProjectScopeOrder, setOpenProjectScopeOrder] = useState(projectGroups);
  const handleProjectScopeMenuOpenChange = (open: boolean) => {
    if (open) setOpenProjectScopeOrder(projectGroups);
    setProjectScopeMenuOpen(open);
  };
  const menuProjectGroups = (() => {
    if (!projectScopeMenuOpen) return projectGroups;
    const frozenRank = new Map(
      openProjectScopeOrder.map((project, index) => [project.projectKey, index] as const),
    );
    return projectGroups
      .map((project, index) => ({
        project,
        rank: frozenRank.get(project.projectKey) ?? frozenRank.size + index,
      }))
      .toSorted((left, right) => left.rank - right.rank)
      .map((entry) => entry.project);
  })();
  // The trigger has one line of sidebar width, so a multi-project scope shows
  // only a count. The names still have to reach a screen reader and a hover,
  // otherwise the current filter is unreadable without opening the menu.
  const unavailableProjectCount =
    projectScopeKeys === null ? 0 : projectScopeKeys.size - scopedProjectGroups.length;
  const hiddenProjectGroups = projectGroups.filter((project) =>
    hiddenProjectKeys.has(project.projectKey),
  );
  const unavailableHiddenProjectCount = hiddenProjectKeys.size - hiddenProjectGroups.length;
  const projectScopeLabel =
    projectScopeKeys === null
      ? hiddenProjectKeys.size === 0
        ? "All projects"
        : `${hiddenProjectKeys.size} ${hiddenProjectKeys.size === 1 ? "project" : "projects"} hidden`
      : unavailableProjectCount === projectScopeKeys.size
        ? `${projectScopeKeys.size} ${projectScopeKeys.size === 1 ? "project" : "projects"} unavailable`
        : (singleScopedProjectGroup?.displayName ?? `${projectScopeKeys.size} projects`);
  const projectScopeDetailParts = [
    ...scopedProjectGroups.map((project) => project.displayName),
    ...(unavailableProjectCount > 0
      ? [
          `${unavailableProjectCount} ${
            unavailableProjectCount === 1 ? "project" : "projects"
          } unavailable`,
        ]
      : []),
  ];
  const hiddenProjectDetailParts = [
    ...hiddenProjectGroups.map((project) => project.displayName),
    ...(unavailableHiddenProjectCount > 0 ? [`${unavailableHiddenProjectCount} unavailable`] : []),
  ];
  const projectScopeDetail =
    projectScopeKeys === null && hiddenProjectKeys.size > 0
      ? `${projectScopeLabel}: ${hiddenProjectDetailParts.join(", ")}`
      : singleScopedProjectGroup === null &&
          projectScopeKeys !== null &&
          scopedProjectGroups.length > 0
        ? `${projectScopeLabel}: ${projectScopeDetailParts.join(", ")}`
        : projectScopeLabel;
  const routeDraftIdForRows = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const visibleDraftSessionCount = useComposerDraftStore((store) => {
    let count = 0;
    for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (!composerDraftHasUserContent(store.draftsByThreadKey[draftKey])) {
        continue;
      }
      if (
        environmentFilter.resolvedScope !== null &&
        !environmentFilter.resolvedScope.has(session.environmentId)
      ) {
        continue;
      }
      const sessionProjectKey = `${session.environmentId}:${session.projectId}`;
      if (hiddenPhysicalProjectKeys.has(sessionProjectKey)) {
        continue;
      }
      if (scopedProjectKeys !== null && !scopedProjectKeys.has(sessionProjectKey)) {
        continue;
      }
      count += 1;
    }
    return count;
  });
  // Project and environment filter changes drop the selection: rows selected
  // under the previous view may now be hidden, and bulk actions must never
  // count or touch invisible rows.
  const selectionFilterSignature = `${environmentFilter.signature}\0${projectFilterSignature}`;
  const clearedSelectionFilterRef = useRef<string | null>(null);
  useEffect(() => {
    if (clearedSelectionFilterRef.current === selectionFilterSignature) return;
    clearedSelectionFilterRef.current = selectionFilterSignature;
    clearSelection();
  }, [clearSelection, selectionFilterSignature]);

  const openProjectSettings = useStableCallback(
    (projectGroup: SidebarProjectSnapshot, projectRef?: ScopedProjectRef) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/projects/$projectKey",
        params: {
          projectKey: getSidebarProjectSettingsKey(
            projectGroup,
            projectGroupingSettings,
            projects,
            projectRef,
          ),
        },
      });
    },
  );
  const handleProjectSettings = useStableCallback(
    (
      event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
      projectGroup: SidebarProjectSnapshot,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      setProjectScopeMenuOpen(false);
      openProjectSettings(projectGroup);
    },
  );

  // Keep a dropped row at its destination while its server applies the
  // lifecycle command and any order-key writes. The next pickup waits for
  // this hold so a second drop cannot replace an unconfirmed placement.
  const [optimisticDrop, setOptimisticDrop] = useState<SidebarOptimisticDrop | null>(null);
  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [searchHighlight, setSearchHighlight] = useState({ orderKey: "", index: 0 });
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const settlingThreadKeysRef = useRef(new Set<string>());
  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const threadListRef = useRef<HTMLUListElement | null>(null);
  // Fork: drag previews size rows in px from the root font size, read when the
  // list mounts.
  const [sidebarRemSize, setSidebarRemSize] = useState(16);
  const dragLabelOffsetRef = useRef(0);
  const [dragState, setDragState] = useState<{
    readonly activeKey: string;
    readonly activeSection: SidebarSection;
    readonly occurredAt: string;
    readonly activationY: number | null;
    readonly targetSection: SidebarSection | null;
    /** Fork: custom group under the pointer (null: Active). */
    readonly targetCustomGroupId: string | null;
    readonly contextDrag: boolean;
  } | null>(null);
  const dragSensorRef = useRef<SidebarPointerSensor | null>(null);
  const contextDragKeyRef = useRef<string | null>(null);
  const snoozingThreadKeysRef = useRef(new Set<string>());
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const searchEnvironmentIds = useConnectedEnvironmentIds();
  const threadSearch = useThreadSearch(searchEnvironmentIds, threadSearchQuery);
  const isSearchingThreads = threadSearchQuery.trim().length > 0;
  const {
    pinnedThreads,
    draggableThreadKeys,
    activeReorderableThreadKeys,
    activeThreads,
    workingThreads,
    snoozedThreads,
    settledThreads,
    snoozeNow,
    emptyStateCause,
    searchableThreads,
    collapsedGroups,
    toggleCustomGroup,
    expandCustomGroup,
    settledVisibleCount,
    hiddenSettledCount,
    showMoreSettled,
    settledShelfExpanded,
    toggleSettledShelf,
    snoozedShelfExpanded,
    toggleSnoozedShelf,
    pinnedShelfExpanded,
    togglePinnedShelf,
    workingShelfExpanded,
    toggleWorkingShelf,
    activeShelfExpanded,
    toggleActiveShelf,
    expandActiveShelf,
    renderedSettledThreads,
    sidebarListItemsFresh,
    sidebarListItemsKey,
    orderedThreadKeys,
    threadByKey,
    settledThreadKeys,
    snoozedThreadKeys,
    sectionByThreadKey,
    pinnedKeys,
    activeKeys,
    foldedGroupIds,
    pinnedKeysById,
    activeKeysById,
  } = useSidebarThreads({
    threads,
    environmentScope: environmentFilter.resolvedScope,
    environmentScopeActive: environmentFilter.scope !== null,
    scopedProjectKeys,
    hiddenProjectKeys: hiddenPhysicalProjectKeys,
    serverConfigs,
    optimisticDrop,
    workingShelfEnabled,
    routeThreadKey,
    // The settled tail restarts whenever a project or environment filter changes.
    settledResetKey: `${projectFilterSignature}:${environmentFilter.signature}`,
    isSearchingThreads,
    groups: customGroups.groups,
  });
  const [sidebarListItemsState, setSidebarListItems] = useState(sidebarListItemsFresh);
  const [sidebarListItemsKeyState, setSidebarListItemsKeyState] = useState(sidebarListItemsKey);
  let sidebarListItems = sidebarListItemsState;
  if (sidebarListItemsKeyState !== sidebarListItemsKey) {
    setSidebarListItemsKeyState(sidebarListItemsKey);
    setSidebarListItems(sidebarListItemsFresh);
    // The rest of this render still runs before React applies the update, and
    // threadByKey already lacks rows that just left, such as a thread settled
    // into the collapsed Settled shelf.
    sidebarListItems = sidebarListItemsFresh;
  }
  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  // Handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey);
  const handleNewThreadRef = useRef(newThreadContext.handleNewThread);
  const settledThreadKeysRef = useRef(settledThreadKeys);
  const snoozedThreadKeysRef = useRef(snoozedThreadKeys);
  const sectionByThreadKeyRef = useRef(sectionByThreadKey);
  const threadSearchMatchByKey = new Map(
    threadSearch.matches.map((match) => [threadSearchMatchKey(match), match] as const),
  );
  const threadSearchResults = searchSidebarThreads(
    searchableThreads,
    threadSearchQuery,
    new Set(threadSearchMatchByKey.keys()),
  );
  const threadSearchResultOrderKey = threadSearchResults
    .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
    .join("\0");

  // The highlight belongs to one result list; a new list starts at the top.
  const activeSearchResultIndex =
    searchHighlight.orderKey === threadSearchResultOrderKey ? searchHighlight.index : 0;
  const setActiveSearchResultIndex = (index: number | ((index: number) => number)) =>
    setSearchHighlight((current) => {
      const currentIndex = current.orderKey === threadSearchResultOrderKey ? current.index : 0;
      return {
        orderKey: threadSearchResultOrderKey,
        index: typeof index === "function" ? index(currentIndex) : index,
      };
    });
  const activeSearchResult = isSearchingThreads
    ? threadSearchResults[activeSearchResultIndex]
    : undefined;
  const activeSearchResultKey =
    activeSearchResult === undefined ? null : threadShellKey(activeSearchResult);
  useEffect(() => {
    if (activeSearchResultKey === null) return;
    document
      .querySelector(`[data-search-result-key="${globalThis.CSS.escape(activeSearchResultKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultKey]);

  const {
    expanded: archivedShelfExpanded,
    toggleExpanded: toggleArchivedShelf,
    visibleThreads: visibleArchivedThreads,
  } = recentArchive;

  const jumpLabelByKey = (() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  })();
  const { showThreadJumpHints: showJumpHints, updateThreadJumpHintsVisibility } =
    useThreadJumpHintVisibility();

  const navigateToThread = (threadRef: ScopedThreadRef) => {
    if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
      clearSelection();
    }
    setSelectionAnchor(scopedThreadKey(threadRef));
    if (isMobile) {
      setOpenMobile(false);
    }
    return router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };
  // Direct picks (row clicks, Enter/Space, search results) route through the
  // split-aware helper so the thread lands in the active pane; forward
  // navigation after settle/archive keeps using navigateToThread — it must
  // always retarget the primary route. The primary branch delegates to
  // navigateToThread wholesale, so only the split-local branches repeat its
  // selection/mobile prep. The sidebar sits outside both pane roots, so the
  // click's own pointerdown never changes which pane is active.
  // The route ref is re-parsed from the latest key: handing the render's
  // routeThreadRef to the pane helper would let the compiler assume the helper
  // mutates it, and stop caching everything derived from the route.
  const openThreadFromSidebar = (threadRef: ScopedThreadRef) => {
    const routeKey = routeThreadKeyRef.current;
    const { plan } = openThreadInActivePane({
      targetRef: threadRef,
      routeThreadRef: routeKey === null ? null : parseScopedThreadKey(routeKey),
      navigateToPrimary: () => navigateToThread(threadRef),
    });
    if (plan.kind === "navigate-primary") return;
    if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
      clearSelection();
    }
    setSelectionAnchor(scopedThreadKey(threadRef));
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const attemptUnarchive = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unarchiveThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to unarchive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const handleArchivedThreadContextMenu = (
    thread: EnvironmentThreadShell,
    position: { x: number; y: number },
  ) => {
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true, icon: "trash" },
        ],
        position,
      );
      if (clicked === "unarchive") {
        attemptUnarchive(threadRef);
        return;
      }
      if (clicked !== "delete") return;
      const result = await confirmAndDeleteThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const openAllArchivedThreads = () => {
    if (isMobile) setOpenMobile(false);
    void router.navigate({ to: "/settings/archived" });
  };

  const handleThreadFileDrop = async (threadRef: ScopedThreadRef, files: File[]) => {
    const dropId = queuePendingFileDrop({ threadRef, files });
    const landedBefore =
      router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      }).pathname === router.state.location.pathname;
    if (landedBefore) return;

    try {
      await navigateToThread(threadRef);
      const landed =
        router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }).pathname === router.state.location.pathname;
      if (!landed) clearPendingFileDrop(dropId);
    } catch {
      clearPendingFileDrop(dropId);
    }
  };

  const navigateToDraft = (draftId: DraftId) => {
    clearSelection();
    if (isMobile) {
      setOpenMobile(false);
    }
    void router.navigate({ to: "/draft/$draftId", params: { draftId } });
  };

  const clearThreadSearch = () => {
    setThreadSearchQuery("");
    setActiveSearchResultIndex(0);
  };
  const selectThreadSearchResult = (thread: EnvironmentThreadShell) => {
    clearThreadSearch();
    openThreadFromSidebar(scopeThreadRef(thread.environmentId, thread.id));
  };
  const handleThreadSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && isSearchingThreads) {
      event.preventDefault();
      event.stopPropagation();
      clearThreadSearch();
      return;
    }
    if (threadSearchResults.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSearchResultIndex((index) => (index + 1) % threadSearchResults.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSearchResultIndex(
        (index) => (index - 1 + threadSearchResults.length) % threadSearchResults.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = threadSearchResults[activeSearchResultIndex];
      if (result) selectThreadSearchResult(result);
    }
  };

  const startThreadRename = (threadRef: ScopedThreadRef, title: string) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
  };
  const cancelThreadRename = () => setRenamingThreadKey(null);
  const commitThreadRename = (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
    void (async () => {
      if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
      const trimmed = title.trim();
      setRenamingThreadKey(null);
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (trimmed === originalTitle) return;
      const result = await updateThreadMetadata({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, title: trimmed },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleThreadClick = (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
    if (isSidebarNestedLinkClick(event.target)) return;
    const isMac = isMacPlatform(navigator.platform);
    const isModClick = isMac ? event.metaKey : event.ctrlKey;
    const threadKey = scopedThreadKey(threadRef);
    if (isModClick) {
      event.preventDefault();
      toggleThreadSelection(threadKey);
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      rangeSelectTo(threadKey, orderedThreadKeysRef.current);
      return;
    }
    if (isTrailingDoubleClick(event.detail)) {
      return;
    }
    openThreadFromSidebar(threadRef);
  };

  // Callers snapshot the plan BEFORE the command mutates the partition;
  // background parks never navigate (null plan).
  const planForwardNavigation = (
    threadKey: string,
    coParkingKeys?: ReadonlySet<string>,
  ): (() => void) | null => {
    if (routeThreadKeyRef.current !== threadKey) return null;
    const shell = threadByKeyRef.current.get(threadKey);
    const orderedKeys = orderedThreadKeysRef.current;
    const settledKeys = settledThreadKeysRef.current;
    const snoozedKeys = snoozedThreadKeysRef.current;
    const currentIndex = orderedKeys.indexOf(threadKey);
    const nextCardKey =
      currentIndex === -1
        ? null
        : ([...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
            (key) => !settledKeys.has(key) && !snoozedKeys.has(key) && !coParkingKeys?.has(key),
          ) ?? null);
    const nextThread = nextCardKey ? threadByKeyRef.current.get(nextCardKey) : null;
    return nextThread
      ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
      : shell
        ? () =>
            void handleNewThreadRef.current(scopeProjectRef(shell.environmentId, shell.projectId))
        : () => void router.navigate({ to: "/" });
  };

  const attemptSettle = (
    threadRef: ScopedThreadRef,
    opts: { coSettlingKeys?: ReadonlySet<string> } = {},
  ) => {
    const threadKey = scopedThreadKey(threadRef);
    if (settlingThreadKeysRef.current.has(threadKey)) return;
    settlingThreadKeysRef.current.add(threadKey);
    // Promise.finally, not try/finally: the React Compiler cannot compile the latter.
    void (async () => {
      const navigateAfterSettle = planForwardNavigation(threadKey, opts.coSettlingKeys);
      const result = await settleThread(threadRef);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      if (
        shouldNavigateAfterThreadPark({
          threadKey,
          currentThreadKey: routeThreadKeyRef.current,
          action: "settle",
          now: new Date().toISOString(),
          thread: readThreadShell(threadRef),
        })
      ) {
        navigateAfterSettle?.();
      }
    })().finally(() => settlingThreadKeysRef.current.delete(threadKey));
  };
  useEffect(() => registerSettleAndAdvance(attemptSettle), [attemptSettle]);
  const settleThreads = (threadKeys: readonly string[]) => {
    const coSettlingKeys = new Set(threadKeys);
    for (const threadKey of threadKeys) {
      const thread = threadByKeyRef.current.get(threadKey);
      if (!thread || thread.settledOverride === "settled") continue;
      attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys });
    }
  };
  const attemptUnsettle = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unsettleThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to un-settle thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const attemptFork = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await forkThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to fork conversation",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const attemptUnsnooze = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unsnoozeThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to wake thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const restrictBelowPins: Modifier = (args) =>
    restrictBelowSidebarLabel(args, dragLabelOffsetRef.current);
  // A new array re-renders DndContext and with it every sortable row.
  const dndModifiers = [
    restrictToVerticalAxis,
    restrictBelowPins,
    restrictToFirstScrollableAncestor,
  ];
  const attachListMotionRef = (node: HTMLUListElement | null) => {
    threadListRef.current = node;
    if (node !== null) {
      setSidebarRemSize(
        Number.parseFloat(getComputedStyle(node.ownerDocument.documentElement).fontSize) || 16,
      );
    }
    listMotionRef.current?.dispose();
    listMotionRef.current = node === null ? null : createSidebarListMotion(node);
    listMotionRef.current?.update(false);
  };

  // Working rows can supply chat context, but never preview sidebar movement.
  const isContextDrag = dragState?.contextDrag === true || dragState?.activeSection === "working";
  const dragTargetSection = isContextDrag ? null : (dragState?.targetSection ?? null);
  const finishThreadDrag = (started: boolean) => {
    dragSensorRef.current = null;
    contextDragKeyRef.current = null;
    endThreadContextDrag();
    if (started) {
      listMotionRef.current?.release();
      setDragState(null);
    }
  };
  const attachDragSensor = (sensor: SidebarPointerSensor) => {
    dragSensorRef.current = sensor;
  };
  const cancelThreadDrag = () => {
    dragSensorRef.current?.cancel();
  };
  const contextDragThreads = (): ReadonlyArray<ScopedThreadRef> => {
    const key = contextDragKeyRef.current;
    if (key === null) return [];
    const selected = useThreadSelectionStore.getState().selectedThreadKeys;
    const keys = selected.has(key) ? [...selected] : [key];
    return keys.flatMap((candidate) => {
      const ref = parseScopedThreadKey(candidate);
      return ref ? [ref] : [];
    });
  };
  const pointerOutsideThreadList = (point: { x: number; y: number }) => {
    const bounds = threadListRef.current?.getBoundingClientRect();
    return bounds !== undefined && (point.x < bounds.left || point.x > bounds.right);
  };
  // The pointer sensor keeps this across a drag and memoizes on its options, so
  // it keeps one identity and reads the latest drag state when called.
  const moveThreadContextDrag = useStableCallback((point: { x: number; y: number }) => {
    const contextDrag = pointerOutsideThreadList(point);
    setDragState((current) =>
      current === null || current.contextDrag === contextDrag
        ? current
        : { ...current, contextDrag },
    );
    if (!contextDrag) {
      endThreadContextDrag();
      return false;
    }
    const threads = contextDragThreads();
    const title =
      threadByKeyRef.current.get(contextDragKeyRef.current ?? "")?.title.trim() || "Thread";
    moveThreadContextDragGhost(point, { title, count: threads.length });
    return true;
  });
  const dropThreadContextDrag = (point: { x: number; y: number }) => {
    if (!pointerOutsideThreadList(point)) return false;
    dropThreadContext(point, contextDragThreads());
    return true;
  };
  // useSensor memoizes on the options object; a fresh one each render rebuilds
  // the sensors, and with them DndContext and every sortable row.
  const pointerSensorOptions = {
    distance: SIDEBAR_DRAG_DISTANCE,
    onAttach: attachDragSensor,
    onFinish: finishThreadDrag,
    onMove: moveThreadContextDrag,
    onDrop: dropThreadContextDrag,
  };
  const dndSensors = useSensors(useSensor(SidebarPointerSensor, pointerSensorOptions));
  useLayoutEffect(() => {
    routeThreadKeyRef.current = routeThreadKey;
    projectGroupsRef.current = projectGroups;
    resolvedProjectScopeKeysRef.current = resolvedProjectScopeKeys;
    orderedThreadKeysRef.current = orderedThreadKeys;
    threadByKeyRef.current = threadByKey;
    handleNewThreadRef.current = newThreadContext.handleNewThread;
    settledThreadKeysRef.current = settledThreadKeys;
    snoozedThreadKeysRef.current = snoozedThreadKeys;
    sectionByThreadKeyRef.current = sectionByThreadKey;
  });
  const [actionSweep, setActionSweep] = useState<{
    action: SidebarSweepAction;
    keys: ReadonlySet<string>;
  } | null>(null);
  const startActionSweep = useStableCallback(
    (threadRef: ScopedThreadRef, action: SidebarSweepAction, event: PointerEvent) => {
      const originKey = scopedThreadKey(threadRef);
      const originSection = sectionByThreadKeyRef.current.get(originKey);
      const canApply = (key: string) => {
        const thread = threadByKeyRef.current.get(key);
        const capabilities =
          thread && serverConfigs.get(thread.environmentId)?.environment.capabilities;
        return (
          thread !== undefined &&
          sectionByThreadKeyRef.current.get(key) === originSection &&
          (action === "unsnooze"
            ? capabilities?.threadSnooze === true
            : capabilities?.threadSettlement === true)
        );
      };
      let targetKey: string | null = null;
      let sweptKeys: string[] = [];
      const sweepTo = (key: string | null) => {
        if (key === null || key === targetKey) return;
        targetKey = key;
        sweptKeys = resolveSidebarSweepKeys(orderedThreadKeysRef.current, originKey, key, canApply);
        setActionSweep({ action, keys: new Set(sweptKeys) });
      };
      dragSensorRef.current = new SidebarPointerSensor({
        active: originKey,
        event,
        options: {
          distance: SIDEBAR_DRAG_DISTANCE,
          onAttach: () => {},
          onFinish: () => {
            dragSensorRef.current = null;
            setActionSweep(null);
          },
        },
        onPending: () => {},
        onStart: () => sweepTo(originKey),
        onMove: ({ y }) =>
          sweepTo(threadListRef.current && sidebarThreadKeyAtY(threadListRef.current, y)),
        onEnd: () => {
          const keys = sweptKeys.filter(canApply);
          if (action === "settle") {
            settleThreads(keys);
            return;
          }
          for (const key of keys) {
            const ref = parseScopedThreadKey(key);
            if (ref === null) continue;
            if (action === "unsettle") attemptUnsettle(ref);
            else attemptUnsnooze(ref);
          }
        },
        onCancel: () => {},
        onAbort: () => {},
      });
    },
  );
  const optimisticDropHold =
    optimisticDrop === null
      ? null
      : resolveOptimisticDropHold({
          optimisticDrop,
          threads,
          pinnedKeys,
          activeKeys,
          groups: customGroups.groups,
          now: snoozeNow,
        });
  if (optimisticDrop !== null && optimisticDropHold === "release") {
    setOptimisticDrop(null);
  } else if (optimisticDrop !== null && optimisticDropHold === "group-seen") {
    setOptimisticDrop({ ...optimisticDrop, customGroupSeen: true });
  }
  const attemptPin = (threadRef: ScopedThreadRef) => {
    void (async () => {
      // Fresh pins take the top of the arranged run: pinThread computes a
      // key before the smallest key across ALL pinned shells — including
      // snoozed pins hidden from this list, whose keys are still part of
      // the run — so the new pin can't land beneath a hidden head.
      const result = await pinThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to pin thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const attemptUnpin = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await confirmAndUnpinThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to unpin thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  // Fork: the Pinned shelf header and the group headers already mark these
  // boundaries, so their drag labels stay hidden and open no space. Any space
  // opened here draws every row below it away from its at-rest drop rect.
  const pinnedDragLabelHeight = pinnedThreads.length > 0 ? 0 : SIDEBAR_DRAG_LABEL_HEIGHT;
  const dividerDragLabelHeight = hasCustomGroups ? 0 : SIDEBAR_DRAG_LABEL_HEIGHT;
  const handleThreadDragStart = (event: DragStartEvent) => {
    const activeKey = String(event.active.id);
    contextDragKeyRef.current = activeKey;
    const activeSection = sectionByThreadKey.get(activeKey);
    if (activeSection === undefined) return;
    listMotionRef.current?.suspend();
    const list = threadListRef.current;
    const header = list?.querySelector<HTMLElement>('[data-testid="sidebar-pinned-header"]');
    if (list && header) {
      const listRect = list.getBoundingClientRect();
      const scale = list.offsetWidth > 0 ? listRect.width / list.offsetWidth : 1;
      dragLabelOffsetRef.current =
        header.getBoundingClientRect().top - listRect.top + pinnedDragLabelHeight * scale;
    } else {
      dragLabelOffsetRef.current = 0;
    }
    setDragState({
      activeKey,
      activeSection,
      targetSection: activeSection,
      targetCustomGroupId: threadGroupId(threadByKey.get(activeKey) ?? {}, customGroups.groups),
      contextDrag: false,
      occurredAt: new Date().toISOString(),
      activationY:
        event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null,
    });
  };
  useEffect(() => {
    if (
      dragState !== null &&
      !sidebarListItems.some((item) => item.kind === "thread" && item.key === dragState.activeKey)
    ) {
      cancelThreadDrag();
    }
  }, [cancelThreadDrag, dragState, sidebarListItems]);
  // Rows only move when the rendered order, a row's section, or the draft block
  // changes. Running the motion pass on that alone keeps ordinary shell events
  // from forcing a layout read and animating rows that drifted for other reasons.
  const listMotionLayoutKey = [
    sidebarListItemsKey,
    visibleDraftSessionCount,
    routeDraftIdForRows ?? "",
  ].join("\0");
  const listMotionAnimate =
    dragState === null && sidebarListItems.length + visibleDraftSessionCount > 0;
  // The effect reads only `animate`; the pass object is cached on both fields,
  // so a new layout key alone also triggers it.
  const listMotionPass = { layoutKey: listMotionLayoutKey, animate: listMotionAnimate };
  useLayoutEffect(() => {
    listMotionRef.current?.update(listMotionPass.animate);
  }, [listMotionPass, listMotionRef]);
  const handleThreadDragOver = (event: DragOverEvent) => {
    const target = event.over
      ? resolveSidebarDropTarget(sidebarListItems, String(event.active.id), String(event.over.id))
      : null;
    setDragState((current) =>
      current === null || current.activeKey !== String(event.active.id)
        ? current
        : {
            ...current,
            targetSection: target?.section ?? null,
            targetCustomGroupId: target?.customGroupId ?? null,
          },
    );
  };
  const sortableIds = sidebarListItems.map(sidebarListItemId);
  // Outside a drag the orders are constants, so the strategy, and with it
  // every sortable row, keeps its identity while thread shells stream in.
  const { settledOrder: draggedSettledOrder, activeOrder: draggedActiveOrder } =
    dragState === null
      ? NO_DRAGGED_ORDERS
      : resolveDraggedOrders({
          drag: dragState,
          threadByKey,
          settledThreads,
          activeThreads,
          workingShelfEnabled,
        });
  const sidebarSortingStrategy = createSidebarSortingStrategy({
    items: sidebarListItems,
    enabled: !isContextDrag,
    boundaryLabelHeight: SIDEBAR_DRAG_LABEL_HEIGHT,
    boundaryLabelHeights: {
      "pinned-header": pinnedDragLabelHeight,
      "pinned-divider": dividerDragLabelHeight,
    },
    settledOrder: draggedSettledOrder,
    ...(draggedActiveOrder === undefined ? {} : { activeOrder: draggedActiveOrder }),
    foldedGroupIds,
    settledExpanded: settledShelfExpanded,
    settledVisibleCount,
    routeThreadKey,
    snoozedThreadCount: snoozedThreads.length,
    cardHeight: (compactCards ? 3.75 : 5.125) * sidebarRemSize,
    slimHeight: 2.25 * sidebarRemSize,
  });
  const draggedThreadKey = dragState?.activeKey;
  const draggedFromSection = dragState?.activeSection;
  const dragActivationY = dragState?.activationY;
  const dndCollisionDetection = (() => {
    if (draggedThreadKey === undefined || draggedFromSection === undefined)
      return createSidebarCollisionDetection(() => true);
    const source = threadByKey.get(draggedThreadKey);
    if (source === undefined) return createSidebarCollisionDetection(() => false);
    return createSidebarCollisionDetection(
      (id) => {
        const target = resolveSidebarDropTarget(sidebarListItems, draggedThreadKey, id);
        if (target === null) return false;
        // Fork: a group move needs the source server to store membership.
        if (
          target.customGroupId != null &&
          serverConfigs.get(source.environmentId)?.environment.capabilities.threadCustomGroups !==
            true
        )
          return false;
        return (
          planSidebarThreadDrop({
            activeKey: draggedThreadKey,
            activeSection: draggedFromSection,
            activeCustomGroupId: threadGroupId(source, customGroups.groups),
            activePinned: source.pinnedAt != null,
            activeSettled: source.settledOverride === "settled",
            supportsSettlement:
              serverConfigs.get(source.environmentId)?.environment.capabilities.threadSettlement ===
              true,
            target,
            pinnedOrder: pinnedKeys,
            pinnedKeysById,
            reorderableKeys: draggableThreadKeys,
            activeOrder: activeKeys,
            activeKeysById,
            activeReorderableKeys: activeReorderableThreadKeys,
            activeTimeOrdered: workingShelfEnabled,
          }).kind !== "none"
        );
      },
      {
        items: sidebarListItems,
        activationY: dragActivationY ?? null,
      },
    );
  })();
  const handleThreadDragEnd = (event: DragEndEvent) => {
    const activeKey = String(event.active.id);
    const activeSection = sectionByThreadKey.get(activeKey);
    const target =
      event.over === null
        ? null
        : resolveSidebarDropTarget(sidebarListItems, activeKey, String(event.over.id));
    const activeThread = threadByKey.get(activeKey);
    if (activeSection === undefined || target === null || activeThread === undefined) return;
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    const activeCustomGroupId = threadGroupId(activeThread, customGroups.groups);
    const plan = planSidebarThreadDrop({
      activeKey,
      activeSection,
      activeCustomGroupId,
      activePinned: activeThread.pinnedAt != null,
      activeSettled: activeThread.settledOverride === "settled",
      supportsSettlement:
        serverConfigs.get(activeThread.environmentId)?.environment.capabilities.threadSettlement ===
        true,
      target,
      pinnedOrder: pinnedKeys,
      pinnedKeysById,
      reorderableKeys: draggableThreadKeys,
      activeOrder: activeKeys,
      activeKeysById,
      activeReorderableKeys: activeReorderableThreadKeys,
      activeTimeOrdered: workingShelfEnabled,
    });
    if (plan.kind === "none") return;
    if (plan.kind === "settle" && settlingThreadKeysRef.current.has(activeKey)) return;
    const assignments =
      plan.kind === "pin"
        ? [
            ...(plan.orderKey === undefined ? [] : [{ id: activeKey, orderKey: plan.orderKey }]),
            ...plan.extraAssignments,
          ]
        : plan.kind === "reorder-pinned" || plan.kind === "move-active"
          ? plan.assignments
          : [];
    if (
      !checkThreadOperations(
        [activeKey, ...assignments.map(({ id }) => id)].flatMap((key) => {
          const thread = threadByKey.get(key);
          return thread ? [thread] : [];
        }),
      )
    )
      return;
    // Fork: unfold the destination so the dropped row stays in view.
    if (target.customGroupId != null) {
      expandCustomGroup(target.customGroupId);
    } else if (target.section === "active") expandActiveShelf();
    const targetCustomGroupId = target.customGroupId ?? null;
    const drop = {
      key: activeKey,
      sourceCustomGroupId: activeCustomGroupId,
      customGroupId: targetCustomGroupId,
      customGroupSeen: activeCustomGroupId === targetCustomGroupId,
      token: {},
      sourceSection: activeSection,
      section: target.section,
      occurredAt: new Date().toISOString(),
      clearsSnooze:
        plan.kind === "pin" ||
        plan.kind === "settle" ||
        (plan.kind === "move-active" && plan.unsnooze),
      order: plan.kind === "settle" ? null : plan.order,
      keysAtDrop: target.section === "active" ? activeKeysById : pinnedKeysById,
      assignedKeys: new Map(assignments.map(({ id, orderKey }) => [id, orderKey])),
    };
    setOptimisticDrop(drop);
    void (async () => {
      const run = async (
        operation: Promise<AtomCommandResult<unknown, unknown>>,
        title: string,
      ) => {
        const result = await operation;
        if (result._tag === "Success") return true;
        setOptimisticDrop((current) => (current?.token === drop.token ? null : current));
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return false;
      };
      switch (plan.kind) {
        case "settle": {
          settlingThreadKeysRef.current.add(activeKey);
          const navigateAfterSettle = planForwardNavigation(activeKey);
          const settled = await run(settleThread(threadRef), "Failed to settle thread").finally(
            () => settlingThreadKeysRef.current.delete(activeKey),
          );
          if (
            settled &&
            shouldNavigateAfterThreadPark({
              threadKey: activeKey,
              currentThreadKey: routeThreadKeyRef.current,
              action: "settle",
              now: new Date().toISOString(),
              thread: readThreadShell(threadRef),
            })
          )
            navigateAfterSettle?.();
          return;
        }
        case "move-active":
          // Fork: dropping into another group changes membership first.
          if (
            hasCustomGroups &&
            activeCustomGroupId !== targetCustomGroupId &&
            !(await run(
              setThreadCustomGroup(threadRef, targetCustomGroupId),
              "Failed to move thread to group",
            ))
          )
            return;
          if (plan.unpin && !(await run(unpinThread(threadRef), "Failed to unpin thread"))) return;
          if (
            plan.unsettle &&
            !(await run(unsettleThread(threadRef), "Failed to un-settle thread"))
          )
            return;
          if (plan.unsnooze && !(await run(unsnoozeThread(threadRef), "Failed to wake thread")))
            return;
          break;
        case "pin":
          if (
            !(await run(
              pinThread(threadRef, plan.orderKey === undefined ? {} : { orderKey: plan.orderKey }),
              "Failed to pin thread",
            ))
          )
            return;
          break;
        case "reorder-pinned":
          break;
      }
      const keyWrites = plan.kind === "pin" ? plan.extraAssignments : plan.assignments;
      for (const assignment of keyWrites) {
        const thread = threadByKey.get(assignment.id);
        if (thread === undefined) continue;
        if (
          !(await run(
            (plan.kind === "move-active" ? reorderActiveThread : reorderPinnedThread)(
              scopeThreadRef(thread.environmentId, thread.id),
              assignment.orderKey,
            ),
            plan.kind === "move-active"
              ? "Failed to reorder active threads"
              : "Failed to reorder pinned threads",
          ))
        )
          return;
      }
    })();
  };
  const performSnooze = async (
    threadRef: ScopedThreadRef,
    preset: Pick<SnoozePreset, "snoozedUntil" | "untilDone">,
    opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
  ) => {
    const threadKey = scopedThreadKey(threadRef);
    if (snoozingThreadKeysRef.current.has(threadKey)) {
      return { status: "skipped" } as const;
    }
    snoozingThreadKeysRef.current.add(threadKey);
    // Promise.finally, not try/finally: the React Compiler cannot compile the latter.
    return (async () => {
      // snoozeThread moves the reader back to their previous thread; with
      // none left, the sidebar moves them forward, same as settle. Planned
      // before the await, while the thread still holds its place.
      const result = await snoozeThread(threadRef, preset.snoozedUntil, {
        untilDone: preset.untilDone === true,
        alsoParking: opts.coSnoozingKeys,
        moveOnFallback: planForwardNavigation(threadKey, opts.coSnoozingKeys),
      });
      if (result._tag === "Failure") {
        return isAtomCommandInterrupted(result)
          ? ({ status: "interrupted" } as const)
          : ({ status: "failure", error: squashAtomCommandFailure(result) } as const);
      }
      return { status: "success" } as const;
    })().finally(() => snoozingThreadKeysRef.current.delete(threadKey));
  };
  const attemptSnooze = (
    threadRef: ScopedThreadRef,
    preset: Pick<SnoozePreset, "snoozedUntil" | "untilDone">,
    opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
  ) => {
    void (async () => {
      const outcome = await performSnooze(threadRef, preset, opts);
      if (outcome.status === "failure") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to snooze thread",
            description:
              outcome.error instanceof Error ? outcome.error.message : "An error occurred.",
          }),
        );
        return;
      }
    })();
  };

  const handleMultiSelectContextMenu = useStableCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const selectedThreadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      const threadKeys = selectedThreadKeys.filter((threadKey) =>
        threadByKeyRef.current.has(threadKey),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      const selectedThreads = threadKeys.flatMap((threadKey) => {
        const thread = threadByKeyRef.current.get(threadKey);
        return thread ? [thread] : [];
      });
      const settlingThreads = selectedThreads.filter(
        (thread) => thread.settledOverride !== "settled",
      );
      const canSnoozeSelection = selectedThreads.every(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true &&
          canSnooze(thread),
      );
      const titleRegenerationThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true,
      );
      const regeneratableTitleThreads = titleRegenerationThreads.filter(
        (thread) => thread.titleRegeneration == null,
      );
      const titleRegenerationMenuItem = buildBulkTitleRegenerationContextMenuItem({
        supportedCount: titleRegenerationThreads.length,
        actionableCount: regeneratableTitleThreads.length,
      });
      const pinnedSelectedThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning ===
            true && thread.pinnedAt != null,
      );
      const unpinMenuItem = buildBulkUnpinContextMenuItem({
        pinnedCount: pinnedSelectedThreads.length,
      });
      // Fork: Move to group (k) counts only rows whose server stores group
      // membership; a mixed selection moves what it can.
      const groupMovableSelectedThreads = hasCustomGroups
        ? groupMovableThreads(
            selectedThreads,
            (environmentId) =>
              serverConfigs.get(environmentId)?.environment.capabilities.threadCustomGroups ===
              true,
          )
        : [];
      const canMoveSelectionToGroup = canOperateThreads(groupMovableSelectedThreads);
      // "Until it's done" needs every selected environment to support it; a
      // mixed selection would half-apply.
      const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat, {
        untilDone: selectedThreads.every(
          (thread) =>
            serverConfigs.get(thread.environmentId)?.environment.capabilities
              .threadSnoozeUntilDone === true && canSnoozeUntilDone(thread),
        ),
      });
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            ...(unpinMenuItem
              ? [{ ...unpinMenuItem, disabled: !canOperateThreads(pinnedSelectedThreads) }]
              : []),
            {
              id: "settle",
              label: `Settle (${count})`,
              disabled: settlingThreads.length === 0 || !canOperateThreads(settlingThreads),
            },
            ...(canSnoozeSelection
              ? [
                  {
                    id: "snooze",
                    label: `Snooze (${count})`,
                    disabled: !canOperateThreads(selectedThreads),
                    children: [
                      ...snoozePresets.map((preset) => ({
                        id: `snooze:${preset.id}`,
                        label: `${preset.label} (${preset.whenLabel})`,
                        disabled: !canOperateThreads(selectedThreads),
                      })),
                      {
                        id: "snooze:custom",
                        label: "Custom…",
                        separatorBefore: true,
                        disabled: !canOperateThreads(selectedThreads),
                      },
                    ],
                  },
                ]
              : []),
            ...(titleRegenerationMenuItem
              ? [
                  {
                    ...titleRegenerationMenuItem,
                    disabled:
                      titleRegenerationMenuItem.disabled ||
                      !canOperateThreads(regeneratableTitleThreads),
                  },
                ]
              : []),
            ...(groupMovableSelectedThreads.length > 0
              ? [
                  {
                    id: "move-to-group",
                    label: `Move to group (${groupMovableSelectedThreads.length})`,
                    disabled: !canMoveSelectionToGroup,
                    children: [
                      { id: "group:none", label: "Active", disabled: !canMoveSelectionToGroup },
                      ...customGroups.groups.map((group) => ({
                        id: `group:${group.id}`,
                        label: group.name,
                        disabled: !canMoveSelectionToGroup,
                      })),
                    ],
                  },
                ]
              : []),
            { id: "mark-unread", label: `Mark unread (${count})` },
            {
              id: "delete",
              label: `Delete (${count})`,
              destructive: true,
              disabled: !canOperateThreads(selectedThreads),
            },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      if (clicked.value.startsWith("group:")) {
        if (!checkThreadOperations(groupMovableSelectedThreads)) return;
        // Moved rows leave the selection; failed ones stay so a retry
        // targets exactly what did not move.
        const outcome = await moveThreadsToGroup({
          threads: groupMovableSelectedThreads,
          customGroupId: clicked.value === "group:none" ? null : clicked.value.slice(6),
          move: (threadRef, customGroupId) => setThreadCustomGroup(threadRef, customGroupId),
        });
        removeFromSelection(outcome.movedThreadKeys);
        if (outcome.failedCount > 0) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Failed to move ${outcome.failedCount} thread${outcome.failedCount === 1 ? "" : "s"} to group`,
              description:
                outcome.firstError instanceof Error
                  ? outcome.firstError.message
                  : "An error occurred.",
            }),
          );
        }
        return;
      }
      const actionTargets =
        clicked.value === "unpin"
          ? pinnedSelectedThreads
          : clicked.value === "regenerate-title"
            ? regeneratableTitleThreads
            : clicked.value === "settle"
              ? settlingThreads.flatMap((thread) => {
                  const current = threadByKeyRef.current.get(
                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                  );
                  return current && current.settledOverride !== "settled" ? [current] : [];
                })
              : selectedThreads;
      if (clicked.value === "settle" && actionTargets.length === 0) return;
      if (clicked.value !== "mark-unread" && !checkThreadOperations(actionTargets)) return;
      if (clicked.value?.startsWith("snooze:")) {
        const preset =
          clicked.value === "snooze:custom"
            ? await requestCustomSnooze()
            : snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked.value);
        if (preset) {
          const coSnoozingKeys = new Set(threadKeys);
          clearSelection();
          const outcomes = await Promise.all(
            selectedThreads.map(async (thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              const outcome = await performSnooze(threadRef, preset, { coSnoozingKeys });
              return { outcome, threadRef };
            }),
          );
          const snoozedThreadRefs = outcomes.flatMap(({ outcome, threadRef }) =>
            outcome.status === "success" ? [threadRef] : [],
          );
          const failures = outcomes.flatMap(({ outcome }) =>
            outcome.status === "failure" ? [outcome.error] : [],
          );

          if (failures.length > 0) {
            const firstError = failures[0];
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title:
                  snoozedThreadRefs.length > 0
                    ? `Failed to snooze ${failures.length} thread${failures.length === 1 ? "" : "s"}`
                    : "Failed to snooze threads",
                description:
                  firstError instanceof Error ? firstError.message : "An error occurred.",
              }),
            );
          }
        }
        return;
      }
      if (clicked.value === "unpin") {
        const confirmed = await requestBulkThreadUnpinConfirmation({
          enabled: confirmThreadUnpin,
          count: pinnedSelectedThreads.length,
          confirm: (message) => api.dialogs.confirm(message),
        });
        if (confirmed._tag === "Failure" || !confirmed.value) return;
        for (const thread of pinnedSelectedThreads) {
          void unpinThread(scopeThreadRef(thread.environmentId, thread.id)).then((result) => {
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to unpin thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
          });
        }
        clearSelection();
        return;
      }
      if (clicked.value === "regenerate-title") {
        for (const thread of regeneratableTitleThreads) {
          const result = await updateThreadMetadata({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, regenerateTitle: true },
          });
          if (result._tag === "Success") continue;
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to regenerate thread titles",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        clearSelection();
        return;
      }
      if (clicked.value === "settle") {
        settleThreads(
          actionTargets.map((thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
        );
        clearSelection();
        return;
      }
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (thread) markThreadUnread(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      if (
        !checkThreadOperations(
          threadKeys.flatMap((threadKey) => {
            const thread = threadByKeyRef.current.get(threadKey);
            return thread ? [thread] : [];
          }),
        )
      )
        return;
      const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
        entries: threadKeys.map((threadKey) => ({ threadKey })),
        delete: async ({ threadKey }, deletedThreadKeys) => {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) return null;
          return deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
            deletedThreadKeys,
          });
        },
      });
      if (firstFailure !== null) {
        const firstError = squashAtomCommandFailure(firstFailure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete threads",
            description: firstError instanceof Error ? firstError.message : "An error occurred.",
          }),
        );
      }
      removeFromSelection(
        getThreadKeysToDeselectAfterDelete(selectedThreadKeys, deletedThreadKeys, (threadKey) => {
          const threadRef = parseScopedThreadKey(threadKey);
          return threadRef !== null && readThreadShell(threadRef) !== null;
        }),
      );
    },
  );

  const handleDraftContextMenu = useStableCallback(
    (draftId: DraftId, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        const session = useComposerDraftStore.getState().getDraftSession(draftId);
        if (!api || !session || session.promotedTo) return;
        const projectGroup = projectGroupsRef.current.find((group) =>
          group.memberProjectRefs.some(
            (ref) =>
              ref.environmentId === session.environmentId && ref.projectId === session.projectId,
          ),
        );
        const workspacePath =
          session.worktreePath ??
          projectByKey.get(`${session.environmentId}:${session.projectId}`)?.workspaceRoot;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildDraftActionMenuItems({
              hasPath: Boolean(workspacePath),
              hasBranch: Boolean(session.branch),
              hasProject: projectGroup != null,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "project-settings":
            if (projectGroup)
              openProjectSettings(projectGroup, {
                environmentId: session.environmentId,
                projectId: session.projectId,
              });
            return;
          case "copy-path":
            if (workspacePath) copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          case "copy-branch":
            if (session.branch) copyBranchToClipboard(session.branch, { branch: session.branch });
            return;
          case "discard": {
            // The menu can stay open while the draft sends; discarding a
            // promoting draft would strand the send.
            const current = useComposerDraftStore.getState().getDraftSession(draftId);
            if (current && !current.promotedTo) discardComposerDraft(draftId);
            return;
          }
        }
      })();
    },
  );

  const handleThreadContextMenu = useStableCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        const threadWorkspacePath =
          thread.worktreePath ??
          projectByKey.get(`${thread.environmentId}:${thread.projectId}`)?.workspaceRoot ??
          null;
        const supportsSettlement =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
          true;
        const supportsSnooze =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
        const supportsPinning =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning === true;
        const supportsAutoSettleOptOut =
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadAutoSettleOptOut === true;
        const supportsTitleRegeneration =
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true;
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const isSettled = settledThreadKeysRef.current.has(threadKey);
        const isSnoozed = snoozedThreadKeysRef.current.has(threadKey);
        const isPinned = thread.pinnedAt != null;
        const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat, {
          untilDone:
            serverConfigs.get(thread.environmentId)?.environment.capabilities
              .threadSnoozeUntilDone === true && canSnoozeUntilDone(thread),
        });
        const threadProjectGroup =
          projectGroupsRef.current.find((project) =>
            project.memberProjectRefs.some(
              (projectRef) =>
                projectRef.environmentId === thread.environmentId &&
                projectRef.projectId === thread.projectId,
            ),
          ) ?? null;
        const canOperate = readEnvironmentScope(
          threadRef.environmentId,
          AuthOrchestrationOperateScope,
        );
        const threadActionItems = buildThreadActionMenuItems({
          canOperate,
          branch: thread.branch ?? null,
          projectFilter: threadProjectGroup
            ? {
                label: threadProjectGroup.displayName,
                isActive: isSidebarProjectScopeIsolated(
                  resolvedProjectScopeKeysRef.current,
                  threadProjectGroup.projectKey,
                ),
              }
            : null,
          isPinned,
          isSettled,
          autoSettleEnabled: thread.autoSettleDisabledAt == null,
          isSnoozed,
          canSnoozeNow: canSnooze(thread),
          isRegeneratingTitle,
          isRunning: !threadRuntimeCanArchive(thread.runtime),
          archiveAction: resolveArchiveToggleAction(thread),
          supports: {
            settlement: supportsSettlement,
            autoSettleOptOut: supportsAutoSettleOptOut,
            snooze: supportsSnooze,
            pinning: supportsPinning,
            titleRegeneration: supportsTitleRegeneration,
          },
          snoozePresets,
          forkExtras: {
            fork: canForkConversation(thread, {
              canForkImportedSession: canForkImportedSessionDriver(
                providerEntriesByEnvironment
                  .get(thread.environmentId)
                  ?.get(thread.providerInstanceId)?.driverKind,
              ),
            }),
          },
        });
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              ...threadActionItems,
              ...(hasCustomGroups &&
              serverConfigs.get(thread.environmentId)?.environment.capabilities
                .threadCustomGroups === true
                ? [
                    {
                      id: "move-to-group",
                      label: "Move to group",
                      disabled: !canOperate,
                      children: [
                        { id: "group:none", label: "No group", disabled: !canOperate },
                        ...customGroups.groups.map((group) => ({
                          id: `group:${group.id}`,
                          label: group.name,
                          disabled: !canOperate,
                        })),
                      ],
                    },
                  ]
                : []),
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (clicked.value.startsWith("group:")) {
          if (!checkThreadOperations([thread])) return;
          const result = await setThreadCustomGroup(
            threadRef,
            clicked.value === "group:none" ? null : clicked.value.slice(6),
          );
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to move thread to group",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        const threadAction = findThreadActionMenuId(threadActionItems, clicked.value);
        if (
          threadAction !== null &&
          threadActionRequiresOperate(threadAction) &&
          !checkThreadOperations([thread])
        )
          return;
        if (clicked.value?.startsWith("snooze:")) {
          const preset =
            clicked.value === "snooze:custom"
              ? await requestCustomSnooze()
              : snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked.value);
          if (preset) attemptSnooze(threadRef, preset);
          return;
        }
        switch (clicked.value) {
          case "filter-by-project":
            // This item is the only scope control here, so picking the
            // already-isolated project again is the way back to all projects.
            if (threadProjectGroup) isolateProjectScope(threadProjectGroup.projectKey);
            return;
          case "project-settings":
            if (threadProjectGroup)
              openProjectSettings(threadProjectGroup, {
                environmentId: threadRef.environmentId,
                projectId: thread.projectId,
              });
            return;
          case "new-thread-on-branch": {
            const result = await settlePromise(() =>
              handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
                customGroupId: null,
              }),
            );
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not create thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "settle":
            attemptSettle(threadRef);
            return;
          case "unsettle":
            attemptUnsettle(threadRef);
            return;
          case "unsnooze":
            attemptUnsnooze(threadRef);
            return;
          case "pin":
            attemptPin(threadRef);
            return;
          case "unpin":
            attemptUnpin(threadRef);
            return;
          case "fork":
            attemptFork(threadRef);
            return;
          case "auto-settle:enabled":
          case "auto-settle:disabled": {
            const result = await setThreadAutoSettle(
              threadRef,
              clicked.value === "auto-settle:enabled",
            );
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to update auto-settle",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "regenerate-title": {
            if (isRegeneratingTitle) return;
            const result = await updateThreadMetadata({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, regenerateTitle: true },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to regenerate thread title",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "mark-unread":
            markThreadUnread(threadRef);
            return;
          case "copy-path":
            if (!threadWorkspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
            return;
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive":
          case "archive-when-done":
          case "cancel-archive":
            await attemptArchiveThread(threadRef, {
              expectedAction:
                clicked.value === "archive"
                  ? "archive"
                  : clicked.value === "archive-when-done"
                    ? "schedule"
                    : "cancel",
            });
            return;
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const result = await deleteThread(threadRef);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to delete thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          default:
            return;
        }
      })();
    },
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
          isWeb: !isElectron,
          isDesktop: isElectron,
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread = threadByKey.get(targetThreadKey);
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeTerminalOpen,
    routeThreadKey,
    threadByKey,
  ]);

  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    },
  );
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, updateThreadJumpHintsVisibility]);

  const handleNewThreadClick = (event?: ReactMouseEvent) => {
    const context = {
      activeDraftThread: newThreadContext.activeDraftThread,
      activeThread: newThreadContext.activeThread ?? undefined,
      defaultProjectRef: newThreadContext.defaultProjectRef,
      handleNewThread: newThreadContext.handleNewThread,
    };
    const targetProjectRef = resolveThreadActionProjectRef(context);
    const targetProjectKey = targetProjectRef ? scopedProjectKey(targetProjectRef) : null;
    const targetIsVisible =
      targetProjectRef !== null &&
      (environmentFilter.resolvedScope === null ||
        environmentFilter.resolvedScope.has(targetProjectRef.environmentId)) &&
      (scopedProjectKeys === null ||
        (targetProjectKey !== null && scopedProjectKeys.has(targetProjectKey))) &&
      (targetProjectKey === null || !hiddenPhysicalProjectKeys.has(targetProjectKey));

    // One project: nothing to pick, create immediately. Shift+click creates
    // directly in the current project even with several projects, skipping
    // the palette picker. Never create outside active fork filters: if the
    // route resolves to a hidden project or environment, use the picker.
    if (
      targetIsVisible &&
      shouldCreateNewThreadInCurrentProject(event?.shiftKey ?? false, projectGroups.length)
    ) {
      if (isMobile) setOpenMobile(false);
      void startNewThreadFromContext(context);
      return;
    }
    if (isMobile) setOpenMobile(false);
    openCommandPalette({ open: "new-thread-in" });
  };

  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    (projectGroups.length <= 1 ? shortcutLabelForCommand(keybindings, "chat.newLocal") : undefined);
  const newThreadInProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");
  const newThreadButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            className="relative shrink-0"
            onClick={handleNewThreadClick}
            disabled={projects.length === 0}
            aria-label="New thread"
          />
        }
      >
        <SquarePenIcon />
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
          aria-hidden="true"
        />
      </TooltipTrigger>
      <TooltipPopup side="right">
        {projectGroups.length > 1 ? (
          <span className="flex flex-col gap-0.5">
            <span>
              {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
            </span>
            <span className="text-muted-foreground">
              New thread in current project: Shift+click
              {newThreadInProjectShortcutLabel ? ` (${newThreadInProjectShortcutLabel})` : ""}
            </span>
          </span>
        ) : newThreadShortcutLabel ? (
          `New thread (${newThreadShortcutLabel})`
        ) : (
          "New thread"
        )}
      </TooltipPopup>
    </Tooltip>
  );
  return (
    <>
      <ThreadContextDragGhost />
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <div className="flex items-center gap-1">
              <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
                <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                <input
                  ref={threadSearchInputRef}
                  type="search"
                  value={threadSearchQuery}
                  onChange={(event) => {
                    setThreadSearchQuery(event.currentTarget.value);
                    setActiveSearchResultIndex(0);
                  }}
                  onKeyDown={handleThreadSearchKeyDown}
                  placeholder="Search threads or PRs"
                  aria-label="Search threads"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={isSearchingThreads && threadSearchResults.length > 0}
                  aria-controls={
                    isSearchingThreads && threadSearchResults.length > 0
                      ? "sidebar-thread-search-results"
                      : undefined
                  }
                  aria-activedescendant={
                    isSearchingThreads && threadSearchResults[activeSearchResultIndex]
                      ? `sidebar-thread-search-result-${activeSearchResultIndex}`
                      : undefined
                  }
                  className="min-w-0 flex-1 bg-transparent text-sm font-medium text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground"
                />
                {isSearchingThreads ? (
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost"
                    className="shrink-0"
                    aria-label="Clear thread search"
                    onClick={() => {
                      clearThreadSearch();
                      threadSearchInputRef.current?.focus();
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                ) : null}
              </div>
              <SidebarEnvironmentFilterMenu
                environments={environmentFilter.environments}
                scope={environmentFilter.menuScope}
                catalogReady={environmentsReady}
                shellsBootstrapped={allEnvironmentShellsBootstrapped}
                onToggleEnvironment={environmentFilter.toggleEnvironment}
                onSelectAll={environmentFilter.selectAll}
                onSelectPrimaryOnly={environmentFilter.selectPrimaryOnly}
                onSelectRemoteOnly={environmentFilter.selectRemoteOnly}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton
                      size="icon"
                      className="relative shrink-0"
                      onClick={openAddProjectCommandPalette}
                      type="button"
                      aria-label="Add project"
                    />
                  }
                >
                  <FolderPlusIcon />
                  <span
                    className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                    aria-hidden="true"
                  />
                </TooltipTrigger>
                <TooltipPopup side="right">Add project</TooltipPopup>
              </Tooltip>
              {threadGroupsButton ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <SidebarMenuButton
                        size="icon"
                        className="shrink-0"
                        type="button"
                        aria-label="Manage thread groups"
                        disabled={!customGroups.canEdit}
                        onClick={() => openThreadGroupsDialog()}
                      />
                    }
                  >
                    <GroupIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="right">Thread groups</TooltipPopup>
                </Tooltip>
              ) : null}
              {/* With no projects the project row is absent, so the search row keeps the button. */}
              {!newThreadButtonInProjectRow || projectGroups.length === 0 ? newThreadButton : null}
            </div>
            {projectGroups.length > 0 ? (
              <div className="flex items-center gap-1">
                <div className="relative min-w-0 flex-1">
                  <Menu open={projectScopeMenuOpen} onOpenChange={handleProjectScopeMenuOpenChange}>
                    <MenuTrigger
                      render={
                        <SidebarMenuButton
                          aria-label={`Filter threads by project — ${projectScopeDetail}`}
                          title={projectScopeDetail}
                          className="min-w-0 flex-1"
                        />
                      }
                    >
                      {singleScopedProjectGroup ? (
                        <ProjectFavicon
                          project={singleScopedProjectGroup}
                          className="size-4 shrink-0"
                        />
                      ) : (
                        <ListFilterIcon className="size-4 shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{projectScopeLabel}</span>
                      {singleScopedProjectGroup && showProjectEnvironments ? (
                        <ProjectEnvironmentBadge
                          group={singleScopedProjectGroup}
                          primaryEnvironmentId={primaryEnvironmentId}
                          machineByEnvironmentId={environmentMachineById}
                        />
                      ) : null}
                      {projectScopeKeys !== null || hiddenProjectKeys.size > 0 ? (
                        <span aria-hidden className="size-6 shrink-0" />
                      ) : null}
                      <ChevronDownIcon className="-mr-px size-4 shrink-0" />
                    </MenuTrigger>
                    <MenuPopup align="start" className="w-(--anchor-width)">
                      <MenuCheckboxItem
                        checked={resolvedProjectScopeKeys === null && hiddenProjectKeys.size === 0}
                        closeOnClick
                        onCheckedChange={clearProjectFilters}
                        className="h-8 min-h-8 [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center"
                      >
                        <FolderIcon className="size-4 shrink-0" />
                        <span className="ms-2 min-w-0 truncate text-sm">All projects</span>
                      </MenuCheckboxItem>
                      {menuProjectGroups.map((project) => {
                        const scopeKey = project.projectKey;
                        const accentColor = projectAccentColors.resolve(project.memberProjects);
                        const isHidden = resolvedHiddenProjectKeys.has(scopeKey);
                        return (
                          <MenuCheckboxItem
                            key={scopeKey}
                            checked={resolvedProjectScopeKeys?.has(scopeKey) ?? false}
                            onCheckedChange={() => selectProjectScope(scopeKey)}
                            onContextMenu={(event) => {
                              void handleProjectSettings(event, project);
                            }}
                            onKeyDown={(event) => {
                              if (
                                event.target !== event.currentTarget ||
                                event.defaultPrevented ||
                                event.nativeEvent.isComposing ||
                                event.ctrlKey ||
                                event.altKey ||
                                event.metaKey ||
                                (event.key !== "ContextMenu" &&
                                  !(event.shiftKey && event.key === "F10"))
                              ) {
                                return;
                              }
                              void handleProjectSettings(event, project);
                            }}
                            className={cn(
                              "h-8 min-h-8 [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center",
                            )}
                          >
                            <ProjectFavicon project={project} className="size-4 shrink-0" />
                            {/* flex-1 rather than a second ml-auto: two auto
                                margins split the free space between them and
                                would leave the accent dot floating mid-row. */}
                            <span
                              className={cn(
                                "ms-2 min-w-0 flex-1 truncate text-sm",
                                isHidden && "line-through",
                              )}
                            >
                              {project.displayName}
                              {isHidden ? <span className="sr-only"> (hidden)</span> : null}
                            </span>
                            {/* Badge and dot get the same 24px slot as the
                                buttons after them so the trailing icons are
                                evenly spaced. place-content-center (not flex)
                                keeps the badge's own ml-auto from pushing it
                                off-center; empty:hidden drops the slot when
                                the badge renders nothing. */}
                            {showProjectEnvironments ? (
                              <span className="grid size-6 shrink-0 place-content-center empty:hidden">
                                <ProjectEnvironmentBadge
                                  group={project}
                                  primaryEnvironmentId={primaryEnvironmentId}
                                  machineByEnvironmentId={environmentMachineById}
                                />
                              </span>
                            ) : null}
                            {/* Dot after the badge: the badge is only present
                                on some rows, so the dots would otherwise sit
                                in two columns. */}
                            {accentColor ? (
                              <>
                                <span
                                  aria-hidden
                                  className="grid size-6 shrink-0 place-content-center"
                                >
                                  <span
                                    className="size-2.5 rounded-full ring-1 ring-black/10 dark:ring-white/10"
                                    style={{ backgroundColor: accentColor }}
                                  />
                                </span>
                                <span className="sr-only">Accent {accentColor}</span>
                              </>
                            ) : null}
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    aria-label={`${isHidden ? "Show" : "Hide"} ${project.displayName}`}
                                    className="ml-auto inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/55 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onMouseUp={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      toggleProjectHidden(scopeKey);
                                    }}
                                  >
                                    {isHidden ? (
                                      <EyeIcon className="size-3.5" />
                                    ) : (
                                      <EyeOffIcon className="size-3.5" />
                                    )}
                                  </button>
                                }
                              />
                              <TooltipPopup>{`${isHidden ? "Show" : "Hide"} project`}</TooltipPopup>
                            </Tooltip>
                            <Button
                              size="icon-xs"
                              variant="ghost-muted"
                              aria-label={`Project settings for ${project.displayName}`}
                              title={`Project settings for ${project.displayName}`}
                              // No `ml-auto` here: the hide/show button ahead of
                              // it already claims the free space, so adding one
                              // would only split the pair apart.
                              className="size-6 shrink-0"
                              onPointerDown={(event) => event.stopPropagation()}
                              // Menu items synthesize a click on mouseup once the
                              // trigger's press-drag-release window opens, so a
                              // drag onto this button would toggle the scope
                              // instead of opening project settings.
                              onMouseUp={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                void handleProjectSettings(event, project);
                              }}
                            >
                              <SettingsIcon className="size-3.5" />
                            </Button>
                          </MenuCheckboxItem>
                        );
                      })}
                    </MenuPopup>
                  </Menu>
                  {projectScopeKeys !== null || hiddenProjectKeys.size > 0 ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            data-testid="sidebar-v2-project-filter-clear"
                            aria-label="Clear project filter"
                            className="absolute right-8 top-1/2 z-10 inline-flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground/70 outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            onClick={clearProjectFilters}
                          >
                            <XIcon className="size-3.5" />
                          </button>
                        }
                      />
                      <TooltipPopup>Clear project filter</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </div>
                {newThreadButtonInProjectRow ? newThreadButton : null}
              </div>
            ) : null}
          </SidebarGroup>
        }
      >
        <SidebarGroup className="flex-1" role="presentation">
          {isSearchingThreads ? (
            threadSearchResults.length > 0 ? (
              <TooltipProvider
                key="sidebar-thread-search-tooltips-150"
                delay={150}
                closeDelay={0}
                timeout={400}
              >
                <ul
                  id="sidebar-thread-search-results"
                  role="listbox"
                  aria-label="Thread search results"
                  className="flex flex-col gap-px"
                >
                  {threadSearchResults.map((thread, index) => {
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    return (
                      <SidebarSearchResultRow
                        isSettled={settledThreadKeys.has(threadKey)}
                        key={threadKey}
                        thread={thread}
                        project={
                          projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                        }
                        projectDisplayName={
                          projectDisplayNameByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                        environmentMachine={
                          environmentMachineById.get(thread.environmentId) ?? "server"
                        }
                        providerEntryByInstanceId={
                          providerEntriesByEnvironment.get(thread.environmentId) ??
                          EMPTY_PROVIDER_ENTRIES
                        }
                        projectAccentColor={
                          projectAccentColorByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        accentTintIntensityPercent={accentTint.intensityPercent}
                        isHighlighted={activeSearchResultIndex === index}
                        isRouteActive={routeThreadKey === threadKey}
                        resultId={`sidebar-thread-search-result-${index}`}
                        searchMatch={
                          threadSearchMatchByKey.get(
                            threadSearchMatchKey({
                              environmentId: thread.environmentId,
                              threadId: thread.id,
                            }),
                          ) ?? null
                        }
                        searchQuery={threadSearchQuery}
                        onHighlight={() => setActiveSearchResultIndex(index)}
                        onSelect={() => selectThreadSearchResult(thread)}
                        onFileDropThreads={handleThreadFileDrop}
                      />
                    );
                  })}
                </ul>
              </TooltipProvider>
            ) : (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                {threadSearch.isPending ? "Searching thread messages…" : "No threads found"}
              </p>
            )
          ) : null}
          {!isSearchingThreads ? (
            <TooltipProvider
              key="sidebar-thread-tooltips-150"
              delay={150}
              closeDelay={0}
              timeout={400}
            >
              <DndContext
                sensors={dndSensors}
                autoScroll={!isContextDrag}
                collisionDetection={dndCollisionDetection}
                modifiers={dndModifiers}
                onDragStart={handleThreadDragStart}
                onDragOver={handleThreadDragOver}
                onDragEnd={handleThreadDragEnd}
              >
                <SidebarDragLifecycle onUnmount={cancelThreadDrag} />
                <SortableContext items={sortableIds} strategy={sidebarSortingStrategy}>
                  <ul
                    ref={attachListMotionRef}
                    // VoiceOver treats an exposed list as an interaction boundary,
                    // which hides its rows from ordinary linear navigation. A
                    // presentational list also makes its implicit listitems
                    // presentational while preserving every descendant control.
                    role="presentation"
                    className={cn(
                      "relative flex flex-col gap-px",
                      sidebarListItems.length > 0 && "flex-1",
                      actionSweep !== null && "**:pointer-events-none",
                    )}
                  >
                    {(() => {
                      const renderThreadRow = (
                        thread: EnvironmentThreadShell,
                        section: SidebarSection,
                      ) => {
                        const threadKey = scopedThreadKey(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        const isCard =
                          section === "active" || section === "pinned" || section === "working";
                        const rowVariant = isCard ? "card" : "slim";
                        return (
                          <SortableThreadRow
                            key={threadKey}
                            sortableId={threadKey}
                            contextDrag={isContextDrag}
                            sortableDisabled={
                              renamingThreadKey === threadKey ||
                              !draggableThreadKeys.has(threadKey) ||
                              optimisticDrop !== null
                            }
                            thread={thread}
                            variant={rowVariant}
                            variantAction={
                              section === "snoozed"
                                ? "unsnooze"
                                : section === "settled"
                                  ? "unsettle"
                                  : "settle"
                            }
                            settlementSupported={
                              serverConfigs.get(thread.environmentId)?.environment.capabilities
                                .threadSettlement === true
                            }
                            snoozeSupported={
                              serverConfigs.get(thread.environmentId)?.environment.capabilities
                                .threadSnooze === true
                            }
                            snoozeUntilDoneSupported={
                              serverConfigs.get(thread.environmentId)?.environment.capabilities
                                .threadSnoozeUntilDone === true
                            }
                            pinningSupported={
                              serverConfigs.get(thread.environmentId)?.environment.capabilities
                                .threadPinning === true
                            }
                            isPinned={thread.pinnedAt != null}
                            dropGroupLabel={
                              hasCustomGroups &&
                              dragState?.activeKey === threadKey &&
                              dragTargetSection === "active" &&
                              dragState.targetCustomGroupId !==
                                threadGroupId(thread, customGroups.groups)
                                ? `Move to ${customGroups.groups.find((group) => group.id === dragState.targetCustomGroupId)?.name ?? "Active"}`
                                : null
                            }
                            dropVerb={
                              dragState?.activeKey === threadKey
                                ? resolveSidebarDropVerb(dragState.activeSection, dragTargetSection)
                                : null
                            }
                            dragOverPinned={
                              dragState?.activeKey === threadKey && dragTargetSection === "pinned"
                            }
                            sweepAction={
                              actionSweep?.keys.has(threadKey) ? actionSweep.action : null
                            }
                            snoozeWakeLabelText={
                              section === "snoozed"
                                ? thread.snoozedUntil != null
                                  ? snoozeWakeLabel(thread.snoozedUntil, {
                                      now: new Date().toISOString(),
                                    })
                                  : UNTIL_DONE_SNOOZE_LABEL
                                : null
                            }
                            wokeAt={threadWokeAt(thread, { now: snoozeNow })}
                            wokeOnFinishedWork={threadWokeOnFinishedWork(thread)}
                            isActive={routeThreadKey === threadKey}
                            splitPaneMarker={
                              splitSecondaryKey === null
                                ? null
                                : threadKey === splitSecondaryKey
                                  ? "right"
                                  : threadKey === routeThreadKey
                                    ? "left"
                                    : null
                            }
                            openPullRequestsInRightPanel={routeThreadRef !== null}
                            jumpLabel={
                              showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null
                            }
                            currentEnvironmentId={primaryEnvironmentId}
                            environmentLabel={
                              environmentLabelById.get(thread.environmentId) ?? null
                            }
                            environmentMachine={
                              environmentMachineById.get(thread.environmentId) ?? "server"
                            }
                            scratchMachineLabel={scratchMachineLabelFor(thread)}
                            project={
                              projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
                              null
                            }
                            projectDisplayName={
                              projectDisplayNameByKey.get(
                                `${thread.environmentId}:${thread.projectId}`,
                              ) ?? null
                            }
                            projectAccentColor={
                              projectAccentColorByKey.get(
                                `${thread.environmentId}:${thread.projectId}`,
                              ) ?? null
                            }
                            accentTintIntensityPercent={accentTint.intensityPercent}
                            compactCards={compactCards}
                            providerIconVisibility={providerIconVisibility}
                            providerEntryByInstanceId={
                              providerEntriesByEnvironment.get(thread.environmentId) ??
                              EMPTY_PROVIDER_ENTRIES
                            }
                            timestampFormat={timestampFormat}
                            onThreadClick={handleThreadClick}
                            onThreadActivate={openThreadFromSidebar}
                            onStartRename={startThreadRename}
                            onRenameTitleChange={setRenamingTitle}
                            onCommitRename={commitThreadRename}
                            onCancelRename={cancelThreadRename}
                            isRenaming={renamingThreadKey === threadKey}
                            renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
                            onContextMenu={handleThreadContextMenu}
                            onSettle={attemptSettle}
                            onActionSweepStart={startActionSweep}
                            onUnsettle={attemptUnsettle}
                            onFork={attemptFork}
                            onArchive={attemptArchiveThread}
                            onSnooze={attemptSnooze}
                            onUnsnooze={attemptUnsnooze}
                            onPin={attemptPin}
                            onUnpin={attemptUnpin}
                            onAcknowledgeWoke={acknowledgeWoke}
                            onFileDropThreads={handleThreadFileDrop}
                          />
                        );
                      };
                      const from = isContextDrag ? null : (dragState?.activeSection ?? null);
                      const items: ReactNode[] = [
                        <SidebarDraftBlock
                          key="draft-sessions"
                          projectByKey={projectByKey}
                          projectDisplayNameByKey={projectDisplayNameByKey}
                          scopedProjectKeys={scopedProjectKeys}
                          scopedEnvironmentIds={environmentFilter.resolvedScope}
                          hiddenProjectKeys={hiddenPhysicalProjectKeys}
                          routeDraftId={routeDraftIdForRows}
                          compactCards={compactCards}
                          onNavigateToDraft={navigateToDraft}
                          onDraftContextMenu={handleDraftContextMenu}
                        />,
                        pinnedThreads.length > 0 ? (
                          <li
                            key="pinned-shelf-header"
                            data-thread-selection-safe
                            className="list-none"
                          >
                            <button
                              type="button"
                              onClick={togglePinnedShelf}
                              aria-expanded={pinnedShelfExpanded}
                              data-testid="sidebar-pinned-shelf-toggle"
                              // No mt-3, unlike the sibling shelf headers: this
                              // one leads the list (only the draft block can sit
                              // above it, and it brings its own spacing).
                              className="mb-1 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
                            >
                              <span
                                className={cn(
                                  "text-xs font-medium",
                                  from !== null && dragTargetSection === "pinned"
                                    ? "text-primary"
                                    : "text-muted-foreground/50",
                                )}
                              >
                                {pinnedShelfExpanded
                                  ? "Pinned"
                                  : `Pinned (${pinnedThreads.length})`}
                              </span>
                              <span className="h-px flex-1 bg-sidebar-border/60" />
                              <ChevronDownIcon
                                aria-hidden
                                className={cn(
                                  "size-3 text-muted-foreground/50 transition-transform",
                                  pinnedShelfExpanded && "rotate-180",
                                )}
                              />
                            </button>
                          </li>
                        ) : null,
                      ];
                      for (const item of sidebarListItems) {
                        if (item.kind === "thread") {
                          items.push(renderThreadRow(threadByKey.get(item.key)!, item.section));
                          continue;
                        }
                        if (isSidebarGroupMarker(item.marker)) {
                          const group = customGroups.groups.find(
                            (candidate) => `custom-group:${candidate.id}` === item.marker,
                          );
                          const groupId = group?.id ?? null;
                          items.push(
                            <SidebarCustomGroupHeader
                              key={item.marker}
                              marker={item.marker}
                              label={group?.name ?? "Active"}
                              count={
                                activeThreads.filter(
                                  (thread) =>
                                    threadGroupId(thread, customGroups.groups) === groupId,
                                ).length
                              }
                              expanded={
                                group ? !collapsedGroups.has(group.id) : activeShelfExpanded
                              }
                              dragging={from !== null}
                              isDropTarget={
                                dragState !== null &&
                                dragTargetSection === "active" &&
                                dragState.targetCustomGroupId === groupId
                              }
                              onToggle={() => {
                                if (group) toggleCustomGroup(group.id);
                                else toggleActiveShelf();
                              }}
                              onManage={group ? () => openThreadGroupsDialog() : undefined}
                            />,
                          );
                          continue;
                        }
                        switch (item.marker) {
                          case "pinned-header":
                            items.push(
                              <SidebarDragBoundary
                                key="pinned-header"
                                marker="pinned-header"
                                label="Pinned"
                                visible={from !== null && pinnedDragLabelHeight > 0}
                                isDropTarget={dragTargetSection === "pinned"}
                              />,
                            );
                            break;
                          case "pinned-divider":
                            items.push(
                              // Fork: the Active header carries the label; the
                              // divider's rule is the Pinned/Active boundary.
                              <SidebarDragBoundary
                                key="pinned-divider"
                                marker="pinned-divider"
                                label=""
                                visible={from !== null && dividerDragLabelHeight > 0}
                                isDropTarget={dragTargetSection === "active"}
                              />,
                            );
                            break;
                          case "active-placeholder": {
                            // Fork: custom groups hold active threads too; count
                            // the Active group's own threads only.
                            const activeGroupThreadCount = activeThreads.filter(
                              (thread) => threadGroupId(thread, customGroups.groups) === null,
                            ).length;
                            items.push(
                              <SidebarSectionPlaceholder
                                key="active-placeholder"
                                marker="active-placeholder"
                                label="Active"
                                // Fork: a folded Active opens no placeholder (see
                                // the sorting strategy), so it shows no hint.
                                showHint={
                                  from !== null &&
                                  activeShelfExpanded &&
                                  (activeGroupThreadCount === 0 ||
                                    (activeGroupThreadCount === 1 &&
                                      dragState?.activeSection === "active" &&
                                      threadGroupId(
                                        threadByKey.get(dragState.activeKey) ?? {},
                                        customGroups.groups,
                                      ) === null &&
                                      dragTargetSection !== null &&
                                      (dragTargetSection !== "active" ||
                                        dragState.targetCustomGroupId !== null)))
                                }
                                isDropTarget={dragTargetSection === "active"}
                              />,
                            );
                            break;
                          }
                          case "working-header":
                            items.push(
                              <SidebarSectionHeader
                                key="working-shelf-header"
                                marker="working-header"
                                className="mt-auto"
                                label={
                                  workingShelfExpanded
                                    ? "Working"
                                    : `Working (${workingThreads.length})`
                                }
                                toggle={{
                                  expanded: workingShelfExpanded,
                                  onToggle: toggleWorkingShelf,
                                }}
                              />,
                            );
                            break;
                          case "snoozed-header":
                            items.push(
                              <SidebarSectionHeader
                                key="snoozed-shelf-header"
                                marker="snoozed-header"
                                className={cn(workingThreads.length === 0 && "mt-auto")}
                                label={
                                  snoozedShelfExpanded
                                    ? "Snoozed"
                                    : `Snoozed (${snoozedThreads.length})`
                                }
                                toggle={{
                                  expanded: snoozedShelfExpanded,
                                  onToggle: toggleSnoozedShelf,
                                }}
                              />,
                            );
                            break;
                          case "settled-header":
                            items.push(
                              <SidebarSectionHeader
                                key="settled-shelf-header"
                                marker="settled-header"
                                className={cn(
                                  workingThreads.length + snoozedThreads.length === 0 && "mt-auto",
                                )}
                                label={
                                  settledShelfExpanded
                                    ? "Settled"
                                    : `Settled (${settledThreads.length})`
                                }
                                dragging={from !== null}
                                isDropTarget={dragTargetSection === "settled"}
                                toggle={{
                                  expanded: settledShelfExpanded,
                                  onToggle: toggleSettledShelf,
                                }}
                              />,
                            );
                            break;
                          case "settled-placeholder":
                            items.push(
                              <SidebarSectionPlaceholder
                                key="settled-placeholder"
                                marker="settled-placeholder"
                                label="Settled"
                                showHint={
                                  from !== null &&
                                  (renderedSettledThreads.length === 0 ||
                                    (from === "settled" &&
                                      renderedSettledThreads.length === 1 &&
                                      dragTargetSection !== null &&
                                      dragTargetSection !== "settled"))
                                }
                                isDropTarget={dragTargetSection === "settled"}
                              />,
                            );
                            break;
                        }
                      }
                      return items;
                    })()}
                    {settledShelfExpanded && hiddenSettledCount > 0 ? (
                      <li className="list-none">
                        <button
                          type="button"
                          onClick={showMoreSettled}
                          className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                        >
                          <PlusIcon aria-hidden className="size-4 shrink-0" />
                          Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
                        </button>
                      </li>
                    ) : null}
                    {recentArchive.totalCount > 0 ? (
                      <>
                        <li
                          key="archived-shelf-header"
                          data-thread-selection-safe
                          className="list-none"
                        >
                          <button
                            type="button"
                            onClick={toggleArchivedShelf}
                            aria-expanded={archivedShelfExpanded}
                            data-testid="sidebar-v2-archived-shelf-toggle"
                            className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
                          >
                            <span className="text-xs font-medium text-muted-foreground/50">
                              {archivedShelfExpanded
                                ? "Archived"
                                : `Archived (${recentArchive.totalCount})`}
                            </span>
                            <span className="h-px flex-1 bg-sidebar-border/60" />
                            <ChevronDownIcon
                              aria-hidden
                              className={cn(
                                "size-3 text-muted-foreground/50 transition-transform",
                                archivedShelfExpanded && "rotate-180",
                              )}
                            />
                          </button>
                        </li>
                        {visibleArchivedThreads.map((thread) => (
                          <SidebarV2ArchivedRow
                            key={`archived:${thread.environmentId}:${thread.id}`}
                            thread={thread}
                            project={
                              projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
                              null
                            }
                            projectTitle={
                              projectDisplayNameByKey.get(
                                `${thread.environmentId}:${thread.projectId}`,
                              ) ?? null
                            }
                            projectAccentColor={
                              projectAccentColorByKey.get(
                                `${thread.environmentId}:${thread.projectId}`,
                              ) ?? null
                            }
                            accentTintIntensityPercent={accentTint.intensityPercent}
                            isActive={
                              routeThreadKey ===
                              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
                            }
                            onOpen={openThreadFromSidebar}
                            onUnarchive={attemptUnarchive}
                            onContextMenu={handleArchivedThreadContextMenu}
                          />
                        ))}
                        {archivedShelfExpanded ? (
                          <li className="list-none">
                            <button
                              type="button"
                              onClick={openAllArchivedThreads}
                              className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-xs text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                            >
                              <ArchiveIcon aria-hidden className="size-3.5 shrink-0" />
                              View all archived threads
                            </button>
                          </li>
                        ) : null}
                      </>
                    ) : null}
                  </ul>
                </SortableContext>
              </DndContext>
            </TooltipProvider>
          ) : null}
          {!isSearchingThreads &&
          visibleDraftSessionCount === 0 &&
          pinnedThreads.length +
            activeThreads.length +
            workingThreads.length +
            snoozedThreads.length +
            settledThreads.length ===
            0 &&
          recentArchive.totalCount === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {/* Ordered by which clear action would actually refill the list,
                  not by which filters are switched on. `emptyStateCause` is the
                  counterfactual: a filter only appears here when clearing it
                  alone admits a row. An unavailable environment scope is the one
                  exception that outranks "No projects yet" — adding a project
                  under it would land outside the scope and stay hidden. */}
              {environmentFilter.emptyStateLabel !== null &&
              (emptyStateCause === "environment" || emptyStateCause === "none") ? (
                <>
                  <span>{environmentFilter.emptyStateLabel}</span>
                  <button
                    type="button"
                    onClick={environmentFilter.selectAll}
                    className="inline-flex items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    Show all environments
                  </button>
                </>
              ) : projects.length === 0 ? (
                <>
                  <span>No projects yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon className="-mx-0.5 size-3" />
                    Add project
                  </button>
                </>
              ) : emptyStateCause === "multiple" ? (
                // Several filters are each hiding rows, so no single button
                // would refill the list and offering one would mislead.
                "No threads match the active filters"
              ) : singleScopedProjectGroup ? (
                `No threads in ${singleScopedProjectGroup.displayName} yet`
              ) : resolvedProjectScopeKeys !== null ? (
                "No threads in the selected projects yet"
              ) : (
                "No threads yet"
              )}
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
