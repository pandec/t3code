import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
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
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
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
import { SortableContext } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  canSnooze,
  effectiveSnoozed,
  canSnoozeUntilDone,
  resolveArchiveToggleAction,
  snoozeWakeSortMs,
  threadWokeAt,
  threadWokeOnFinishedWork,
  UNTIL_DONE_SNOOZE_LABEL,
} from "@t3tools/client-runtime/state/thread-settled";
import { createInboxReturnTracker } from "@t3tools/client-runtime/state/thread-inbox";
import { sortSettledThreads } from "@t3tools/client-runtime/state/thread-sort";
import {
  nextShownOrder,
  threadSearchMatchKey,
  threadSearchSubject,
  type ShownOrder,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankMessageMatches } from "@t3tools/shared/paletteSearch";
import { findForMessageMatch, requestThreadFindQuery } from "./chat/threadFindActionBus";
import {
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
  type ProjectId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type SidebarProjectAccentColor,
  type ThreadId,
} from "@t3tools/contracts";

import { clampArchivedSectionVisibleCount } from "@t3tools/contracts/settings";
import { selectRecentArchivedThreads } from "@t3tools/client-runtime/state/threads";
import {
  ArchiveIcon,
  ChevronDownIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderPlusIcon,
  GroupIcon,
  InboxIcon,
  ListFilterIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  Undo2Icon,
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
  type ReactNode,
} from "react";
import { useRouter } from "@tanstack/react-router";

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
  useQuietThreadShells,
} from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { primaryServerKeybindingsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useThreadSearch } from "../state/queries";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { canShareWithGuestAtom } from "./chat/guestShareAvailability";
import { openGuestShareDialog } from "./chat/guestShareDialogState";
import { buildThreadRouteParams, resolveActiveThreadRouteRef } from "../threadRoutes";
import { formatCompactRelativeTimeLabel } from "../timestampFormat";
import { useRecentArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import type { SidebarThreadSummary } from "../types";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuId,
} from "./threadActionMenu.logic";
import { openThreadInActivePane } from "./thread-split/threadOpenTarget";
import { useSplitSecondaryThreadKey } from "./thread-split/SplitPaneMarker";
import { SidebarEnvironmentFilterMenu } from "./sidebar/SidebarEnvironmentFilter";
import { resolveSidebarEmptyStateCause } from "./sidebar/sidebarEmptyState";
import { useSidebarEnvironmentFilter } from "./sidebar/useSidebarEnvironmentFilter";
import {
  applySidebarThreadDrop,
  filterSidebarV2VisibleThreads,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
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
  searchSidebarThreads,
  shouldCreateNewThreadInCurrentProject,
  shouldNavigateAfterThreadPark,
  shouldReleaseSidebarGroupDrop,
  isSidebarGroupMarker,
  sidebarProjectScopeSignature,
  sidebarListItemId,
  sidebarThreadKeyAtY,
  sortInboxThreadsByReturn,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  toggleSidebarProjectHidden,
  toggleSidebarProjectIsolation,
  toggleSidebarProjectSelection,
  useThreadJumpHintVisibility,
  type SidebarListItem,
  type SidebarProjectScope,
  type SidebarSection,
  resolveSidebarRowThreadId,
} from "./Sidebar.logic";
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  restrictBelowSidebarLabel,
} from "./Sidebar.drag";
import { SidebarDragLifecycle, SidebarPointerSensor } from "./Sidebar.pointer";
import { createSidebarListMotion } from "./Sidebar.motion";
import { resolveSnoozePresets, snoozeWakeLabel, type SnoozePreset } from "./Sidebar.snooze";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";
import { deriveProviderEntriesByEnvironment } from "../providerInstances";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  completeSidebarRouteReveal,
  pendingSidebarRouteReveal,
  type SidebarRouteReveal,
} from "./sidebar/routeReveal";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { SidebarContent, SidebarGroup, SidebarMenuButton, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { composerDraftHasUserContent, DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import {
  SidebarSearchResultRow,
  SortableThreadRow,
  type SidebarProviderEntry,
  type SidebarSweepAction,
} from "./sidebar/SidebarThreadRow";
import { SidebarDraftBlock } from "./sidebar/SidebarDraftBlock";
import {
  SidebarDragBoundary,
  SidebarSectionHeader,
  SidebarSectionPlaceholder,
  SortableSidebarMarker,
} from "./sidebar/SidebarListMarkers";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";

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
      other.enabled !== entry.enabled ||
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

// Resolve providers per environment because default instance ids collide across environments.
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
  // Subagent children live in the parent's Agents surface, not the roster. Each fork
  // filter is evaluated separately so the empty state names the filter whose
  // clearing alone would admit a row, not whichever filters are switched on.
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
  // Capability gates dragging only; mixed server versions must preserve the same pinned order across clients.
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
    // Settle emits unpin/unsnooze too; hold projected fields and sort times until the whole move completes.
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

// Build maps in a hook so the compiler can prove they are frozen and cache them.
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
  // Delays beyond signed 32-bit range fire immediately and loop for far-future snoozes.
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

const SIDEBAR_DRAG_DISTANCE = 6;

const SIDEBAR_DRAG_LABEL_HEIGHT = 24;

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

// Separate hooks cache maps independently of later Sidebar hooks and preserve dnd-kit inputs
// and row callbacks. Fork: the environment/project filters, custom groups and the foldable
// Pinned/Active shelves live here too.
function useSidebarThreads(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly environmentScope: ReadonlySet<string> | null;
  readonly environmentScopeActive: boolean;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly hiddenProjectKeys: ReadonlySet<string>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly optimisticDrop: SidebarOptimisticDrop | null;
  readonly workingShelfEnabled: boolean;
  readonly routeThreadRef: ScopedThreadRef | null;
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
    routeThreadRef,
    settledResetKey,
    isSearchingThreads,
    groups,
  } = input;
  const hasCustomGroups = groups.length > 0;
  const routeRowThreadKey =
    routeThreadRef === null
      ? null
      : scopedThreadKey(
          scopeThreadRef(
            routeThreadRef.environmentId,
            resolveSidebarRowThreadId(
              routeThreadRef.threadId,
              routeThreadRef.environmentId,
              threads,
            ),
          ),
        );
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
    if (routeRowThreadKey !== null) {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find((thread) => threadShellKey(thread) === routeRowThreadKey);
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible;
  })();
  const hiddenSettledCount = settledThreads.length - visibleSettledThreads.length;
  const renderedSettledThreads = settledShelfExpanded
    ? visibleSettledThreads
    : routeThreadOnly(visibleSettledThreads, routeRowThreadKey);
  // Same exception every other shelf makes: the open thread keeps its row,
  // so a folded pinned block never hides the thread being read.
  const visiblePinnedThreads = pinnedShelfExpanded
    ? pinnedThreads
    : routeThreadOnly(pinnedThreads, routeRowThreadKey);
  const visibleSnoozedThreads = snoozedShelfExpanded
    ? snoozedThreads
    : routeThreadOnly(snoozedThreads, routeRowThreadKey);
  const visibleWorkingThreads = workingShelfExpanded
    ? workingThreads
    : routeThreadOnly(workingThreads, routeRowThreadKey);
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
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeRowThreadKey,
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
    routeRowThreadKey,
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

export default function Sidebar({ routeReveal }: { routeReveal: SidebarRouteReveal }) {
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
  // Rows read their live shell; arranging from quiet shells keeps a running
  // thread's streaming ticks from re-rendering the whole sidebar.
  const threads = useQuietThreadShells();
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
  const [searchHighlightKey, setSearchHighlightKey] = useState<string | null>(null);
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
    routeRowThreadKey,
  } = useSidebarThreads({
    threads,
    environmentScope: environmentFilter.resolvedScope,
    environmentScopeActive: environmentFilter.scope !== null,
    scopedProjectKeys,
    hiddenProjectKeys: hiddenPhysicalProjectKeys,
    serverConfigs,
    optimisticDrop,
    workingShelfEnabled,
    routeThreadRef,
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

  // History, the command palette, and links can open a thread the filters
  // hide or the list has scrolled away. A remount starts the list at the top,
  // so each mount also scrolls to the open thread once, without widening the
  // filters.
  const mountRevealOwed = useRef(true);
  const revealRouteRow = useStableCallback(() => {
    const pendingKey = pendingSidebarRouteReveal(routeReveal, routeRowThreadKey);
    // Search results replace the thread list; reveal once the list returns.
    if (isSearchingThreads) return;
    const revealKey = pendingKey ?? (mountRevealOwed.current ? routeRowThreadKey : null);
    if (revealKey === null) return;
    const thread = threads.find((candidate) => threadShellKey(candidate) === revealKey);
    if (thread === undefined) return;
    if (pendingKey !== null && filterSidebarV2VisibleThreads([thread], null).length === 1) {
      // Fork: the filters are the persisted project multi-select, hidden
      // projects, and environments; clear whichever hides the thread.
      const projectKey = `${thread.environmentId}:${thread.projectId}`;
      const hiddenByProjects =
        hiddenPhysicalProjectKeys.has(projectKey) ||
        (scopedProjectKeys !== null && !scopedProjectKeys.has(projectKey));
      const hiddenByEnvironment =
        environmentFilter.resolvedScope !== null &&
        !environmentFilter.resolvedScope.has(thread.environmentId);
      if (hiddenByProjects || hiddenByEnvironment) {
        // The row renders under the widened filters; scroll on that pass.
        if (hiddenByProjects) clearProjectFilters();
        if (hiddenByEnvironment) environmentFilter.selectAll();
        return;
      }
    }
    const activeRow = document.querySelector('[data-sidebar="content"] [aria-current="page"]');
    if (!activeRow) return;
    completeSidebarRouteReveal(routeReveal);
    mountRevealOwed.current = false;
    activeRow.scrollIntoView({ block: "nearest" });
  });
  useEffect(revealRouteRow, [
    revealRouteRow,
    routeRowThreadKey,
    threads,
    isSearchingThreads,
    projectFilterSignature,
    environmentFilter.signature,
  ]);

  // Ranked across environments as the palette ranks them, so one
  // environment's list does not sit above another's better matches; rows
  // already shown keep their places while slower environments answer.
  const threadByMatchKey =
    threadSearch.matches.length === 0
      ? null
      : new Map(
          searchableThreads.map((thread) => [
            threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
            thread,
          ]),
        );
  const rankedServerMatches =
    threadByMatchKey === null
      ? []
      : rankMessageMatches(
          threadSearch.matches,
          (match) => {
            const thread = threadByMatchKey.get(threadSearchMatchKey(match));
            return thread ? threadSearchSubject(thread, null) : undefined;
          },
          foldSearchQuery(threadSearchQuery),
          Date.now(),
          // A list filter, as on mobile: a pick would move rows unexplained.
          { picks: false },
        );
  const serverMatchByKey = new Map(
    rankedServerMatches.map((match) => [threadSearchMatchKey(match), match] as const),
  );
  const [shownMessageOrder, setShownMessageOrder] = useState<ShownOrder | null>(null);
  const messageOrder = nextShownOrder(
    shownMessageOrder,
    threadSearch.query,
    [...serverMatchByKey.keys()],
    Number.POSITIVE_INFINITY,
  );
  if (messageOrder !== shownMessageOrder) setShownMessageOrder(messageOrder);
  const { titleMatches: threadTitleResults, contentMatches: threadContentResults } =
    searchSidebarThreads(searchableThreads, threadSearchQuery, new Set(messageOrder.keys));
  const threadSearchResults = [...threadTitleResults, ...threadContentResults];
  // Only rows listed for their messages show one, and open find on it.
  const threadSearchMatchByKey = new Map(
    threadContentResults.flatMap((thread) => {
      const key = threadSearchMatchKey({
        environmentId: thread.environmentId,
        threadId: thread.id,
      });
      const match = serverMatchByKey.get(key);
      return match ? [[key, match] as const] : [];
    }),
  );
  const threadSearchResultKeys = threadSearchResults.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );

  // The highlight follows its thread, so rows that arrive late do not move
  // it under Enter; a new query starts at the top.
  const activeSearchResultIndex = Math.max(
    0,
    searchHighlightKey === null ? 0 : threadSearchResultKeys.indexOf(searchHighlightKey),
  );
  const setActiveSearchResultIndex = (index: number | ((index: number) => number)) =>
    setSearchHighlightKey(
      threadSearchResultKeys[
        typeof index === "function" ? index(activeSearchResultIndex) : index
      ] ?? null,
    );
  const activeSearchResultKey = isSearchingThreads
    ? (threadSearchResultKeys[activeSearchResultIndex] ?? null)
    : null;
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
  // Direct picks land in the active pane; navigation after settle/archive keeps
  // navigateToThread, which always retargets the primary route. The route ref is
  // re-parsed from the latest key: passing the render's routeThreadRef would make
  // the compiler assume the helper mutates it and stop caching route-derived values.
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
    setSearchHighlightKey(null);
  };
  const selectThreadSearchResult = (thread: EnvironmentThreadShell) => {
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    // A row listed for a message match opens find on it, as the palette does.
    const match = threadSearchMatchByKey.get(
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
    );
    const query = threadSearch.query;
    clearThreadSearch();
    openThreadFromSidebar(ref);
    if (match) requestThreadFindQuery(scopedThreadKey(ref), findForMessageMatch(match, query));
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

  // Snapshot navigation before partition mutation; background parks use a null plan.
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
  // useSensor memoizes options identity; fresh options rebuild DndContext and every sortable row.
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
  // Only order, section, or draft changes need layout reads and motion.
  const listMotionLayoutKey = [
    sidebarListItemsKey,
    visibleDraftSessionCount,
    routeDraftIdForRows ?? "",
  ].join("\0");
  const listMotionAnimate =
    dragState === null && sidebarListItems.length + visibleDraftSessionCount > 0;
  // Cache on both fields so layout-key changes trigger the effect even when animate is unchanged.
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
  // Keep non-drag orders constant to preserve sorting strategy and row identity during streaming.
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
    routeThreadKey: routeRowThreadKey,
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
            // The menu may outlive draft promotion; discarding then would strand the send.
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
          canShareWithGuest: appAtomRegistry.get(canShareWithGuestAtom(threadRef.environmentId)),
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
          case "share-guest":
            openGuestShareDialog(threadRef);
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
            currentThreadId: routeRowThreadKey,
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
    routeRowThreadKey,
    routeTerminalOpen,
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
                    setSearchHighlightKey(null);
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
                          aria-label={`Filter threads by project: ${projectScopeDetail}`}
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
                            {/* Same 24px slot as the buttons after it so icons space
                                evenly; place-content-center (not flex) keeps the badge's
                                ml-auto from pushing it off-center. */}
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
                        isRouteActive={routeRowThreadKey === threadKey}
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
                        searchMatchQuery={threadSearch.query}
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
                    // Presentation flattens VoiceOver's list interaction boundary while preserving descendant
                    // controls.
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
                            isActive={routeRowThreadKey === threadKey}
                            isRouteThread={routeThreadKey === threadKey}
                            splitPaneMarker={
                              splitSecondaryKey === null
                                ? null
                                : threadKey === splitSecondaryKey
                                  ? "right"
                                  : threadKey === routeRowThreadKey
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
              {/* A filter appears only when clearing it alone admits a row
                  (`emptyStateCause`). An unavailable environment scope outranks
                  "No projects yet": a project added under it would stay hidden. */}
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
