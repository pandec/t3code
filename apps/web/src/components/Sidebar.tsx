import { ThreadHoverCard, ThreadHoverCardPopup } from "./ThreadHoverCard";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";
import { setThreadChangeRequestSnapshot } from "./ThreadStatusIndicators";
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
  snoozeShelfLabel,
  snoozeWakeSortMs,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import { createInboxReturnTracker } from "@t3tools/client-runtime/state/thread-inbox";
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
  canForkImportedSessionWith,
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
  ClockIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GitForkIcon,
  GroupIcon,
  InboxIcon,
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
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useParams, useRouter } from "@tanstack/react-router";

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
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import {
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
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
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
import { useAccentTintSettings, useClientSettings } from "../hooks/useSettings";
import {
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
  useThreadShells,
} from "../state/entities";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { threadEnvironment } from "../state/threads";
import { useEnvironmentQuery } from "../state/query";
import { useThreadSearch } from "../state/queries";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { formatCompactRelativeTimeLabel, parseTimestampDate } from "../timestampFormat";
import { useRecentArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import type { SidebarThreadSummary } from "../types";
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
import { foldSplitForParkedThread } from "./thread-split/threadSplitStore";
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
  sortSidebarV2ProjectGroups,
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
  nextThreadChangeRequestSnapshot,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  terminalStatusFromRunningIds,
  threadChangeRequestSnapshotsAtom,
  type ThreadChangeRequestSnapshot,
  synchronizeTerminalPulse,
  type TerminalStatusIndicator,
  useLinkedThreadPullRequest,
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

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more.
const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, ProviderInstanceEntry> = new Map();
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

// Working beta: when this client saw each thread leave the Working shelf.
// Module scope keeps the inbox order across routes that unmount the sidebar.
const inboxReturns = createInboxReturnTracker();

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

function threadTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return formatCompactRelativeTimeLabel(timestamp);
}

// Settled rows read "how long ago did this wrap up", matching their sort
// key: both go through resolveSettledThreadTimestamp so label and order can't
// disagree.
function settledTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = resolveSettledThreadTimestamp(thread);
  return timestamp === null ? "" : formatCompactRelativeTimeLabel(timestamp);
}

// Floats at the row's right edge, vertically centered, while the jump
// modifier is held. An overlay pill instead of an inline slot: the hint
// must neither displace the status/time label (holding ⌘ used to blank
// out "Working") nor shift any layout when it appears. pointer-events-none
// so it never swallows clicks meant for the settle/un-settle buttons it
// can overlap.
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

// Self-ticking so only this span re-renders each second, not the whole row.
function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, [startedMs]);
  if (Number.isNaN(startedMs)) return null;
  return <span className="tabular-nums">{formatWorkingDurationLabel(Date.now() - startedMs)}</span>;
}

function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

function SidebarProviderStack(props: {
  thread: SidebarThreadSummary;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
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
      // Glyph dims, badge stays saturated; offset matches the composer trigger.
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
  providerEntry: ProviderInstanceEntry | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
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
              // Initials would swallow a size-3 glyph: accent dot, name in label.
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

/**
 * Hover entry point for snooze: a clock button opening the preset menu.
 * Controlled by the row (which also uses the open state to pin its hover
 * actions while the menu is up).
 */
function SnoozeMenuButton(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (preset: Pick<SnoozePreset, "snoozedUntil" | "untilDone">) => void;
  timestampFormat: TimestampFormat;
  untilWokenSupported: boolean;
  untilDoneOffered: boolean;
}) {
  const { open, onOpenChange, onSnooze, timestampFormat, untilWokenSupported, untilDoneOffered } =
    props;
  // Presets resolve at open time so "In 1 hour" is relative to the click,
  // not to when the row mounted.
  const presets = useMemo(
    () =>
      open
        ? resolveSnoozePresets(new Date(), timestampFormat, {
            untilWoken: untilWokenSupported,
            untilDone: untilDoneOffered,
          })
        : [],
    [open, timestampFormat, untilWokenSupported, untilDoneOffered],
  );
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

// Subset of useSortable applied to a thread row's root <li>. Listeners go
// on the whole row (no dedicated handle): the pointer sensor's distance
// constraint keeps plain clicks working, and we skip dnd-kit's aria
// attributes since there is no keyboard sensor and the row body already
// carries its own button semantics.
type SortableThreadRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

function SortableThreadRow(props: {
  id: string;
  disabled: boolean;
  contextDrag: boolean;
  environmentId: EnvironmentId;
  children: (bag: SortableThreadRowBag) => ReactNode;
}) {
  const canOperateThread = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: { draggable: props.disabled || !canOperateThread },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // dnd-kit memoizes each field but not the bag, so the memoized row would
  // rerender on every shell update without this.
  const bag = useMemo(
    () => ({
      listeners,
      setNodeRef,
      transform: props.contextDrag ? null : transform,
      // The lifted row normally follows the pointer without a transition.
      // When it becomes a context ghost, glide its sidebar copy back home.
      transition: props.contextDrag && isDragging ? "transform 150ms ease-out" : transition,
      isDragging: isDragging && !props.contextDrag,
    }),
    [listeners, setNodeRef, transform, transition, isDragging, props.contextDrag],
  );
  return props.children(bag);
}

// Unsent work shares one look: the new-thread draft rows and thread rows
// with unsent composer text both use this tint and pen so they read alike.
const draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8";
const draftPenClassName = "size-3 shrink-0 text-warning-foreground";

// Structural list items — the section headers and the
// empty-section placeholders — take part in the sortable list so they shift
// with the rows and the gap can open on either side of them. They can't be
// picked up, and a marker is the sortable `over` when the pointer is on it,
// which resolveSidebarDropTarget turns into the section the gap sits in.
function SortableSidebarMarker(props: {
  marker: SidebarListMarker;
  className?: string;
  children?: ReactNode;
  "data-testid"?: string | undefined;
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id: sidebarMarkerId(props.marker),
    disabled: { draggable: true },
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
        // A newly revealed target must not slide from its hidden position.
        transition: props.marker.endsWith("-placeholder") ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

// Empty targets stay measurable without reserving space at rest. The sorting
// strategy opens their hint space during a drag.
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

// Pointer travel before a press on a row starts a drag, or a press on its
// action button starts a sweep. Shorter presses stay clicks.
const SIDEBAR_DRAG_DISTANCE = 6;

type SidebarSweepAction = "settle" | "unsettle" | "unsnooze";

// Zero-height markers reserve no label space at rest. During a drag the
// sorting strategy opens 24px for a 16px label with 4px clearance on each side.
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

// Shelf headers stay visible and keep their measured height while dragging.
function SidebarSectionHeader(props: {
  marker: "working-header" | "snoozed-header" | "settled-header";
  label: string;
  className?: string;
  // While dragging, the settled header reads at full strength and takes the
  // accent while the lifted row is over it.
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

// One unsent draft session the user has invested content in. Two lines,
// nothing else: project name, then the typed prompt. All the draft's
// settings (model, env mode, branch, worktree) still travel with it —
// clicking is a plain navigation to /draft/$draftId, which touches nothing.
// While the draft is open the row renders a frozen snapshot (see
// SidebarDraftBlock); memoized so per-keystroke block re-renders skip it
// entirely.
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
  const handleActivate = useCallback(() => onNavigate(draftId), [draftId, onNavigate]);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
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
    },
    [draftId, onContextMenu, onNavigate],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(draftId, { x: event.clientX, y: event.clientY });
    },
    [draftId, onContextMenu],
  );
  const handleDiscard = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onDiscard(draftId);
    },
    [draftId, onDiscard],
  );
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
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), [setExpanded]);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore((store) => store.draftsByThreadKey);
  // The open draft's row is FROZEN at the moment the draft became the route:
  // it stays visible (like a thread row) but never repaints while the user
  // types. A draft that was never navigated away from has no snapshot to
  // freeze, so a fresh typing session shows no row at all. Captured
  // synchronously on route change (setState-during-render derived state) so
  // the row never flickers out for a frame between route change and capture.
  const [frozenActive, setFrozenActive] = useState<{
    routeDraftId: string | null;
    row: SidebarDraftRowData | null;
  }>({ routeDraftId: null, row: null });
  if (frozenActive.routeDraftId !== props.routeDraftId) {
    let row: SidebarDraftRowData | null = null;
    if (props.routeDraftId !== null) {
      const draftId = DraftId.make(props.routeDraftId);
      const store = useComposerDraftStore.getState();
      const session = store.getDraftSession(draftId);
      const composer = store.getComposerDraft(draftId);
      row =
        session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
          ? { draftId, session, composer }
          : null;
    }
    setFrozenActive({ routeDraftId: props.routeDraftId, row });
  }
  const drafts = useMemo(() => {
    const rows: SidebarDraftRowData[] = [];
    // Every non-promoted session with content gets a row, mapped or not:
    // new-thread surfaces mint fresh drafts and leave invested ones behind
    // unmapped, so the mapping only knows about the latest per project.
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
        // Open draft: render the frozen entry snapshot, or nothing for a
        // draft that has never been left. Gated on the LIVE session above so
        // send/discard still removes the row immediately.
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
  }, [
    draftThreadsByThreadKey,
    draftsByThreadKey,
    frozenActive,
    props.hiddenProjectKeys,
    props.routeDraftId,
    props.scopedEnvironmentIds,
    props.scopedProjectKeys,
  ]);
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
            // The /draft/$draftId route redirects home on its own when the
            // draft it renders disappears, so discarding the open draft needs
            // no special-casing here.
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

// Verb and icon on the lifted row while it hovers over another section. Uses
// the same icons as the row actions and context menu so the drop reads as the
// action it performs.
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

const SidebarThreadRow = memo(function SidebarThreadRow(props: {
  thread: SidebarThreadSummary;
  variant: "card" | "slim";
  // Settled rows un-settle, snoozed rows wake, and cards settle.
  variantAction: SidebarSweepAction;
  // False on environments whose server predates thread.settle/unsettle:
  // the lifecycle affordances hide entirely rather than fail on click.
  settlementSupported: boolean;
  // Same contract for thread.snooze/unsnooze.
  snoozeSupported: boolean;
  // Fork: server accepts a null wake time (indefinite "Until I wake it").
  snoozeUntilWokenSupported: boolean;
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
  // Present on rows whose server supports every drop outcome: dnd-kit
  // sortable bag applied to the row root so the whole row drags (the
  // pointer sensor's distance constraint keeps plain clicks working).
  sortable?: SortableThreadRowBag | undefined;
  dropVerb: SidebarDropVerb | null;
  /** Fork: "Move to <group>" while the lifted row hovers another custom group. */
  dropGroupLabel?: string | null;
  // While dragging, the pin marker stays only for a pinned thread still over
  // the pinned section. Any other position shows the verb badge instead, and
  // the badge carries its own icon.
  dragOverPinned: boolean;
  // The action this row will take when the sweep is released.
  sweepAction: SidebarSweepAction | null;
  // Compact wake countdown ("2h") for rows in the snoozed shelf.
  snoozeWakeLabelText: string | null;
  // When a snooze ended (timer or early wake); drives the Woke pill until
  // the user visits the thread.
  wokeAt: string | null;
  isActive: boolean;
  // Which split pane shows this thread, while the split view is on screen.
  splitPaneMarker: SplitPaneMarker | null;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  project: EnvironmentProject | null;
  // Null when the project has no accent, or when accent tints are switched off.
  projectAccentColor: SidebarProjectAccentColor | null;
  accentTintIntensityPercent: AccentTintIntensityPercent;
  compactCards: boolean;
  providerIconVisibility: SidebarThreadProviderIconVisibility;
  projectDisplayName: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
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
  changeRequestSnapshot: ThreadChangeRequestSnapshot | null;
  onChangeRequestSnapshot: (
    threadKey: string,
    snapshot: ThreadChangeRequestSnapshot | null,
  ) => void;
}) {
  const {
    isRenaming,
    changeRequestSnapshot,
    onChangeRequestSnapshot,
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
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
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
  // Unsent composer text on this thread. The open thread shows its own
  // composer, so the marker only decorates rows you have navigated away from.
  const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !isOnScreen;
  const handleDiscardDraftClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      discardComposerDraft(threadRef);
    },
    [threadRef],
  );

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

  // Same semantics as the legacy sidebar (never-visited counts as read):
  // switching sidebars must not light up every historical thread as unread.
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus(thread);
  const isInFlight =
    status === "working" ||
    status === "monitoring" ||
    status === "waiting" ||
    status === "approval" ||
    status === "input";
  // A woken thread reappears at its original position (the sort is
  // deliberately static), so the pill has to carry the weight. Snoozing is
  // an explicit act, so the pill clears only when the user re-engages:
  // reading a completion-triggered wake, clicking the pill, sending a
  // message, settling, archiving, or a change request state that settles the
  // thread. Timer wakes survive a mere visit. An unparseable visit timestamp
  // counts as never-visited, so corrupt local data cannot eat the wake signal.
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
  const isWoke =
    wokeAtDate !== null &&
    (lastVisitedDate === null || lastVisitedDate < wokeAtDate) &&
    thread.settledOverride !== "settled";
  // Background work always recedes when it is not selected: an unread parent
  // completion must not pull a still-working thread back into the foreground.
  // Ready and action-required rows keep their unread and wake prominence.
  const shouldRecede = shouldRecedeSidebarThread({
    status,
    isUnread,
    isWoke,
    isActive: props.isActive,
    isSelected,
  });
  // Status hues follow the system-wide convention set by sidebar v1 and the
  // mobile Live Activity/widgets (amber approval, indigo input, sky working)
  // so a thread reads the same color everywhere it surfaces.
  const topStatus =
    status === "working"
      ? {
          // A native /goal keeps the agent going across turns until it is met.
          label: thread.goal?.status === "active" ? "Goal" : "Working",
          icon: "working" as const,
          // No shimmer: a label that animates forever is noise in a sidebar
          // full of them (and repaints every vsync on high-refresh displays).
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
              icon: null,
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
                        className: "text-warning",
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

  // The local environment is "this machine" and needs no marker; every other
  // one gets its machine glyph. With no local environment (the hosted app)
  // that is every thread, which is the point: the glyph is what tells rows on
  // different machines apart.
  const isRemote = thread.environmentId !== props.currentEnvironmentId;

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

  const handleClick = useCallback(
    (event: ReactMouseEvent) => {
      onThreadClick(event, threadRef);
    },
    [onThreadClick, threadRef],
  );
  const handleAcknowledgeWokeClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (props.wokeAt === null) return;
      onAcknowledgeWoke(threadRef, props.wokeAt);
    },
    [onAcknowledgeWoke, props.wokeAt, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onThreadActivate(threadRef);
    },
    [onThreadActivate, threadRef],
  );
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
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
    },
    [isRenaming, onStartRename, thread.title, threadRef],
  );
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = useMemo(
    () =>
      onFileDropThreads
        ? makeWorkspaceFileDropHandlers({
            setDragActive: setIsFileDragOver,
            addFiles: (files) => {
              onFileDropThreads(threadRef, files);
            },
            addFolders: () => {},
          })
        : null,
    [onFileDropThreads, threadRef],
  );
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
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
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
    },
    [onCancelRename, onCommitRename, renamingTitle, thread.title, threadRef],
  );
  const handleRenameBlur = useCallback(() => {
    if (!renameCommittedRef.current) {
      onCommitRename(threadRef, renamingTitle, thread.title);
    }
  }, [onCommitRename, renamingTitle, thread.title, threadRef]);
  const handleSettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onSettle(threadRef);
    },
    [onSettle, threadRef],
  );
  const handleActionPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return;
      // Action buttons sweep their section rather than picking up the row.
      event.stopPropagation();
      onActionSweepStart(threadRef, variantAction, event.nativeEvent);
    },
    [onActionSweepStart, threadRef, variantAction],
  );
  const handleUnsettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsettle(threadRef);
    },
    [onUnsettle, threadRef],
  );
  const handleForkClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onFork(threadRef);
    },
    [onFork, threadRef],
  );
  const archiveAction = resolveArchiveToggleAction(thread);
  const archivePending = archiveAction === "cancel";
  const archiveLabel =
    archiveAction === "cancel"
      ? "Cancel pending archive"
      : archiveAction === "schedule"
        ? "Archive when done"
        : "Archive";
  const handleArchiveClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onArchive(threadRef, { expectedAction: archiveAction });
    },
    [archiveAction, onArchive, threadRef],
  );
  const showForkButton =
    canOperateThread &&
    canForkConversation(thread, {
      canForkImportedSession: canForkImportedSessionDriver(
        props.providerEntryByInstanceId.get(thread.providerInstanceId)?.driverKind,
      ),
    });
  const handleUnsnoozeClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsnooze(threadRef);
    },
    [onUnsnooze, threadRef],
  );
  const handlePinToggleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (props.isPinned) {
        onUnpin(threadRef);
      } else {
        onPin(threadRef);
      }
    },
    [onPin, onUnpin, props.isPinned, threadRef],
  );
  const handleToggleListeningClick = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    toggleLoadedListeningTrack();
  }, []);
  const handleSnoozePreset = useCallback(
    (preset: Pick<SnoozePreset, "snoozedUntil" | "untilDone">) => {
      onSnooze(threadRef, preset);
    },
    [onSnooze, threadRef],
  );
  // While the snooze popover is open the pointer leaves the row, which
  // would fade the hover actions out from under the open menu. Pin them and
  // suppress the row tooltip so its portal cannot overlap the popover.
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // Snooze is offered only where it can succeed: capability-gated and never
  // on blocked-on-you work or queued turns (the server rejects both).
  const showSnoozeButton =
    canOperateThread &&
    props.snoozeSupported &&
    canSnooze(thread, { now: new Date().toISOString() });
  const showHoverActions =
    (canOperateThread && props.settlementSupported) || showSnoozeButton || hasUnsentDraft;
  // If the thread becomes blocked while the popover is open, the button
  // unmounts without firing onOpenChange(false). Deriving the flag keeps a
  // stale true from permanently hiding the status label / pinning the
  // hover actions, and the effect clears the raw state so the popover
  // doesn't resurrect if the button later remounts.
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  useEffect(() => {
    if (!showSnoozeButton) setSnoozeMenuOpen(false);
  }, [showSnoozeButton]);
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>, targetUrl?: string) => {
      const url = targetUrl ?? pr?.url ?? currentLinkedPr?.url;
      if (!url) return;
      const showInRightPanel = targetUrl !== undefined || openPullRequestsInRightPanel;
      const openedInRightPanel = openPrLink(event, url, showInRightPanel ? threadRef : undefined);
      if (openedInRightPanel && showInRightPanel && !props.isActive) {
        onThreadActivate(threadRef);
      }
    },
    [
      onThreadActivate,
      openPrLink,
      openPullRequestsInRightPanel,
      pr,
      currentLinkedPr,
      props.isActive,
      threadRef,
    ],
  );

  // All sidebar rows share one surface model. Live threads used to look
  // like elevated cards while settled threads were plain rows, leaving neither
  // a useful hierarchy nor a reliable hover cue. Status now lives in the row
  // content; surface is reserved for interaction (hover, multi-select, route).
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
    // Background work fades as a whole row, status label included, so it
    // takes less attention than rows that need a human (input, approval).
    shouldRecede &&
      status === "working" &&
      "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
    isFileDragOver && "ring-1 ring-inset ring-primary/70",
    isFileDragOver && !isOnScreen && !isSelected && "bg-sidebar-row-hover",
    // The lifted row is an opaque card so the rows beneath it never show
    // through. The row tint is translucent in dark themes and the pointer
    // keeps the hover color applied, so both the tint and the solid sidebar
    // color are stacked as background images.
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
  // dnd-kit props for the row root. Same bag on both variants: every row in
  // the list translates around the gap as the drag passes it.
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
  // Sweeps reuse the corresponding row-drop action badge.
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

  // Stacks show their layer count; multiple unrelated links show their total count.
  // Either opens the thread's pull requests tab; a single PR link opens that PR and still
  // supports opening the host in a new tab.
  const prBadgeShape = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(thread.pullRequests)
    : null;
  const handlePrListClick = useCallback(() => {
    useRightPanelStore.getState().open(threadRef, "pull-requests");
    if (!props.isActive) onThreadActivate(threadRef);
  }, [onThreadActivate, props.isActive, threadRef]);
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
  const terminalStatusIcon = terminalStatus ? (
    <span
      role="img"
      aria-label={terminalProcessLabel(terminalProcessCount)}
      data-testid={`sidebar-terminal-status-${thread.id}`}
      className={cn("inline-flex shrink-0 items-center justify-center", terminalStatus.colorClass)}
    >
      <TerminalIcon
        className={cn("size-3.5", terminalStatus.pulse && "motion-safe:animate-status-pulse")}
        onAnimationStart={synchronizeTerminalPulse}
      />
    </span>
  ) : null;
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
              className="inline-flex cursor-pointer items-center rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
  // row variants until it runs or is cancelled from the thread menu.
  const archivePendingIndicator = hasPendingArchive(thread) ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Archives when done"
            className="inline-flex items-center text-warning-foreground"
          />
        }
      >
        <ArchiveIcon aria-hidden className="size-3 shrink-0" />
      </TooltipTrigger>
      <TooltipPopup>Archives when the current turn and background work finish</TooltipPopup>
    </Tooltip>
  ) : null;
  // Same pen the new-thread draft rows lead with, so both kinds of unsent
  // work read the same way in the list.
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
              className="group/unpin inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          {/* Pin marks the pinned state at rest; hover and focus swap in pin-off so the
              icon reads as the action the button performs. */}
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
          // Matches the h-9 row so unrendered rows never shift the list when they paint.
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
            {/* Settled history recedes: dimmed favicon at rest, restored on
              hover so the tail stays scannable when you're hunting. */}
            <span
              className={cn(
                "shrink-0 transition-opacity",
                (!isOnScreen || variantAction === "unsettle") &&
                  "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
              )}
            >
              {props.project ? <ProjectFavicon project={props.project} className="size-4" /> : null}
            </span>
            {draftIndicator}
            {title}
            {listeningIndicator}
            {archivePendingIndicator}
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
            {/* The PR badge stays outside the hover-fading slot: it must
              remain visible AND clickable while the row is hovered. Only
              the time/jump label yields to the settle affordance. */}
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
                    // Snoozed rows show when they come BACK, not when they were
                    // last touched — the return ticket is the row's whole story.
                    <span className="text-xs text-info-foreground tabular-nums">
                      {props.snoozeWakeLabelText}
                    </span>
                  ) : isWoke ? (
                    // A wake can land straight in the settled tail (e.g. PR
                    // merged while snoozed); the signal must survive the trip.
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Dismiss Woke notification"
                            disabled={!canOperateThread}
                            onClick={handleAcknowledgeWokeClick}
                            className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-warning-foreground outline-none enabled:cursor-pointer enabled:hover:underline focus-visible:ring-2 focus-visible:ring-ring"
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
                      {variantAction === "unsettle"
                        ? settledTimeLabel(thread)
                        : threadTimeLabel(thread)}
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
      <span className="text-diff-addition-foreground">+{diff.insertions}</span>{" "}
      <span className="text-diff-deletion-foreground">−{diff.deletions}</span>
    </span>
  ) : null;
  const machineAndProvider = (
    <span
      aria-hidden
      className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"
    >
      {isRemote ? (
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
              {archivePendingIndicator}
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
              {/* The visible state owns this slot's width: status at rest,
                  actions on hover/keyboard focus or while the popover is open. Keeping
                  the hidden state out of flow lets the project label reclaim
                  space without either state overlapping it. */}
              {sortable?.isDragging ? (
                dragDestination
              ) : (
                <span
                  className={cn(
                    "group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs",
                    props.sweepAction !== null && "hidden",
                  )}
                >
                  {/* Read-only status labels yield to the hover actions. Woke is
                    itself an action, so it stays pointer-enabled and visible
                    while the other controls appear beside it. */}
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
                                  "inline-flex items-center gap-1 rounded-sm font-medium outline-none enabled:cursor-pointer enabled:hover:underline focus-visible:ring-2 focus-visible:ring-ring",
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
                          ) : null}
                        </span>
                      )
                    ) : (
                      threadTimeLabel(thread)
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
                        untilWokenSupported={props.snoozeUntilWokenSupported}
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
              {/* A sweep hides the slot rather than unmounting it, so the
                  pressed action button stays connected and a cancelled sweep's
                  release click still fires and is consumed. */}
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
                  {machineAndProvider}
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
                ) : (
                  <span className="flex-1" />
                )}
                {splitPaneIcon}
                {terminalStatusIcon}
                {prBadge}
                {diffStat}
                {machineAndProvider}
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
  // Shells don't carry checkpoint summaries; diff stats render only when the
  // shell projection grows them. Kept as a seam so the row layout is ready.
  void thread;
  return null;
}

// Fork: a row of the recent-archive shelf; opening it shows the archived thread.
const SidebarV2ArchivedRow = memo(function SidebarV2ArchivedRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly project: ProjectFaviconProject | null;
  readonly projectTitle: string | null;
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
          "flex h-10 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sidebar-muted-foreground/65 outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring",
          props.isActive && "bg-sidebar-row-hover text-sidebar-foreground",
        )}
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
  thread: SidebarThreadSummary;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
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
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(
    props.isHighlighted || props.isRouteActive,
  );
  // Same details tooltip as the regular rows: a search hit is still a thread,
  // and the hover card is how you disambiguate identically-titled results.
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
  const fileDropHandlers = useMemo(
    () =>
      makeWorkspaceFileDropHandlers({
        setDragActive: setIsFileDragOver,
        addFiles: (files) => {
          props.onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      }),
    [props.onFileDropThreads, threadRef],
  );
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
              type="button"
              role="option"
              // aria-activedescendant options: focus stays on the search input,
              // which owns all keyboard interaction for the listbox.
              tabIndex={-1}
              aria-selected={props.isHighlighted}
              aria-current={accessibility.current}
              aria-label={accessibility.label}
              onMouseMove={props.onHighlight}
              onClick={props.onSelect}
              className={cn(
                "flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
                props.isHighlighted || props.isRouteActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                isFileDragOver && "ring-1 ring-inset ring-primary/70",
                isFileDragOver && !props.isRouteActive && "bg-sidebar-row-hover",
              )}
            />
          }
        >
          {props.project ? (
            <ProjectFavicon project={props.project} className="size-4 shrink-0" />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground/55 tabular-nums">
                {threadTimeLabel(thread)}
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

export default function Sidebar() {
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const storedProjectScopeKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
  const storedHiddenProjectKeys = useUiStateStore((store) => store.sidebarHiddenProjectKeys);
  const updateSidebarProjectFilters = useUiStateStore((store) => store.updateSidebarProjectFilters);
  const threads = useThreadShells();
  // Fork: custom thread groups. Headers appear only while the catalog has groups.
  const customGroups = useThreadGroupCatalog();
  const hasCustomGroups = customGroups.groups.length > 0;
  const threadGroupsButton = useClientSettings((s) => s.sidebarThreadGroupsButton);
  const [collapsedGroupIds, setCollapsedGroupIds] = useLocalStorage(
    "t3:collapsed-thread-groups",
    [] as readonly string[],
    COLLAPSED_GROUP_IDS_SCHEMA,
  );
  const collapsedGroups = useMemo(() => new Set(collapsedGroupIds), [collapsedGroupIds]);
  const toggleCustomGroup = useCallback(
    (id: string) =>
      setCollapsedGroupIds((current) =>
        current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
      ),
    [setCollapsedGroupIds],
  );
  const allEnvironmentShellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadUnpin = useClientSettings((s) => s.confirmThreadUnpin);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
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
  const archivedSectionVisibleCount = useClientSettings((s) =>
    clampArchivedSectionVisibleCount(s.archivedSectionVisibleCount),
  );
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
  const openAddProjectCommandPalette = useCallback(
    () => openCommandPalette({ open: "add-project" }),
    [],
  );
  const environments = useEnvironmentIdentities();
  // The environment filter needs the presentation records and catalog readiness.
  const { environments: environmentPresentations, isReady: environmentsReady } = useEnvironments();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const acknowledgeWoke = useAcknowledgeThreadWoke();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTargetRef = useRef(routeTarget);
  routeTargetRef.current = routeTarget;
  const splitSecondaryKey = useSplitSecondaryThreadKey();
  // Post-settle navigation validates against the CURRENT route, not the one
  // captured when the settle started: if the user navigated elsewhere while
  // the command was in flight, completing it must not yank them away.
  const routeThreadKeyRef = useRef(routeThreadKey);
  routeThreadKeyRef.current = routeThreadKey;

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const environmentMachineById = useEnvironmentMachines();
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [
      environmentLabelById,
      orderedProjects,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
      sidebarProjectSortOrder,
    ],
  );
  const projectGroups = useMemo(
    () => sortSidebarV2ProjectGroups(unsortedProjectGroups, threads, sidebarProjectSortOrder),
    [sidebarProjectSortOrder, threads, unsortedProjectGroups],
  );
  const projectGroupsRef = useRef(projectGroups);
  projectGroupsRef.current = projectGroups;
  const resolvedProjectScopeKeysRef = useRef<SidebarProjectScope>(null);
  // Threads on non-primary environments (T3 Connect, hosted) resolve their
  // provider entry from their own environment's config: default instance ids
  // are driver slugs, so a flat map would collide across environments.
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers, config.settings] as const,
        ),
      ),
    [serverConfigs],
  );
  // Rows read the project record for its icon and cwd. Group labels can include
  // a repository owner or a different title, so they travel separately.
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const projectDisplayNameByKey = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjects.map(
            (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
          ),
        ),
      ),
    [projectGroups],
  );
  // Empty while tints are switched off: every tinted surface reads this map,
  // so the toggle lands in one place. Accents themselves are untouched — the
  // project rows still show their dot and the picker still writes colors.
  const projectAccentColorByKey = useMemo(
    () =>
      new Map(
        accentTint.enabled
          ? projectGroups.flatMap((group) => {
              const color = projectAccentColors.resolve(group.memberProjects);
              return color === null
                ? []
                : group.memberProjectRefs.map(
                    (projectRef) =>
                      [`${projectRef.environmentId}:${projectRef.projectId}`, color] as const,
                  );
            })
          : [],
      ),
    [accentTint.enabled, projectAccentColors, projectGroups],
  );

  const nowMinute = useNowMinute();
  const changeRequestSnapshotByKey = useAtomValue(threadChangeRequestSnapshotsAtom);
  // Snooze wake times are second-precise, so classifying with the quantized
  // minute would hold a woken thread on the shelf for up to a minute. The
  // tick is a plain counter bumped exactly at the next wake boundary (armed
  // below, after the partition knows the boundary); the partition reads a
  // fresh clock whenever it recomputes.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);

  // Project visibility is persisted because /settings routes temporarily unmount
  // the sidebar, and because a reload must not silently widen the view. Scope
  // and hidden keys are mutually exclusive; each interaction writes both lists
  // together so the latest click wins without stale overlap.
  const projectScopeKeys = useMemo<SidebarProjectScope>(
    () => (storedProjectScopeKeys === null ? null : new Set(storedProjectScopeKeys)),
    [storedProjectScopeKeys],
  );
  const hiddenProjectKeys = useMemo(
    () => new Set(storedHiddenProjectKeys),
    [storedHiddenProjectKeys],
  );
  // Same-named projects on two machines are only told apart by where they
  // live, so rows on another machine carry its icon once the catalog spans
  // more than one environment; a single-machine catalog stays as it was.
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
  );
  const scopedProjectGroups = useMemo(
    () =>
      projectScopeKeys === null
        ? []
        : projectGroups.filter((project) => projectScopeKeys.has(project.projectKey)),
    [projectGroups, projectScopeKeys],
  );
  const singleScopedProjectGroup =
    projectScopeKeys?.size === 1 && scopedProjectGroups.length === 1
      ? scopedProjectGroups[0]!
      : null;
  const resolvedProjectScopeKeys = useMemo(
    () => resolveSidebarProjectScope(projectGroups, projectScopeKeys),
    [projectGroups, projectScopeKeys],
  );
  resolvedProjectScopeKeysRef.current = resolvedProjectScopeKeys;
  const scopedProjectKeys = useMemo(
    () => resolveSidebarProjectScopePhysicalKeys(projectGroups, resolvedProjectScopeKeys),
    [projectGroups, resolvedProjectScopeKeys],
  );
  const resolvedHiddenProjectKeys = useMemo(
    () => resolveSidebarProjectScope(projectGroups, hiddenProjectKeys) ?? new Set<string>(),
    [hiddenProjectKeys, projectGroups],
  );
  const hiddenPhysicalProjectKeys = useMemo(
    () =>
      resolveSidebarProjectScopePhysicalKeys(projectGroups, resolvedHiddenProjectKeys) ??
      new Set<string>(),
    [projectGroups, resolvedHiddenProjectKeys],
  );
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
  // The archive shelf follows the environment and project filters the way
  // live rows do: per environment, the physical project ids left after
  // scoping and hiding. No project filter keeps the unrestricted query.
  const archivedProjectIdsByEnvironment = useMemo(() => {
    if (scopedProjectKeys === null && hiddenPhysicalProjectKeys.size === 0) return undefined;
    const byEnvironment = new Map<EnvironmentId, ProjectId[]>();
    for (const environmentId of environmentFilter.environmentIds) {
      byEnvironment.set(environmentId, []);
    }
    for (const project of projects) {
      const projectKey = `${project.environmentId}:${project.id}`;
      if (hiddenPhysicalProjectKeys.has(projectKey)) continue;
      if (scopedProjectKeys !== null && !scopedProjectKeys.has(projectKey)) continue;
      byEnvironment.get(project.environmentId)?.push(project.id);
    }
    return byEnvironment;
  }, [environmentFilter.environmentIds, hiddenPhysicalProjectKeys, projects, scopedProjectKeys]);
  const { snapshots: archivedSnapshots } = useRecentArchivedThreadSnapshots(
    environmentFilter.environmentIds,
    archivedSectionVisibleCount,
    archivedProjectIdsByEnvironment,
  );
  const selectProjectScope = useCallback(
    (scopeKey: string) => {
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
    },
    [projectGroups, updateSidebarProjectFilters],
  );
  const toggleProjectHidden = useCallback(
    (scopeKey: string) => {
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
    },
    [projectGroups, updateSidebarProjectFilters],
  );
  const clearProjectFilters = useCallback(
    () => updateSidebarProjectFilters(() => ({ scopeKeys: null, hiddenProjectKeys: [] })),
    [updateSidebarProjectFilters],
  );
  // The thread menu's "Filter by project" over the persisted multi-select:
  // isolate this project, or return to all projects when it is already alone.
  const isolateProjectScope = useCallback(
    (scopeKey: string) => {
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
    },
    [projectGroups, updateSidebarProjectFilters],
  );
  // Keyed on the stored intent, not the resolved scope: clearing the selection
  // and collapsing the settled tail answer "the user changed the filter", and
  // an environment reconnecting must not wipe staged bulk work. Bulk actions
  // already ignore selected keys whose rows are not rendered.
  const projectFilterSignature = useMemo(
    () =>
      `${sidebarProjectScopeSignature(projectScopeKeys)}|hidden:${JSON.stringify(
        [...hiddenProjectKeys].toSorted(),
      )}`,
    [hiddenProjectKeys, projectScopeKeys],
  );
  // The menu stays open across clicks now that it multi-selects, and
  // projectGroups is activity-sorted, so a background thread update would
  // reorder rows under the pointer mid-selection. Freeze the order while the
  // popup is open; projects added or removed meanwhile still appear.
  const openProjectScopeOrderRef = useRef(projectGroups);
  if (!projectScopeMenuOpen) openProjectScopeOrderRef.current = projectGroups;
  const menuProjectGroups = useMemo(() => {
    if (!projectScopeMenuOpen) return projectGroups;
    const frozenRank = new Map(
      openProjectScopeOrderRef.current.map(
        (project, index) => [project.projectKey, index] as const,
      ),
    );
    return projectGroups
      .map((project, index) => ({
        project,
        rank: frozenRank.get(project.projectKey) ?? frozenRank.size + index,
      }))
      .toSorted((left, right) => left.rank - right.rank)
      .map((entry) => entry.project);
  }, [projectGroups, projectScopeMenuOpen]);
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
  // Count-only subscription: the parent needs "are there draft rows" for the
  // empty state, while SidebarDraftBlock owns the per-keystroke content
  // subscription. Selecting a number keeps typing in a draft composer from
  // re-rendering the whole sidebar. Approximates the block's row filter
  // (every non-promoted session with content); it can overcount by one for
  // an open never-left draft, which only softens the empty state.
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
  useEffect(() => {
    clearSelection();
  }, [clearSelection, environmentFilter.signature, projectFilterSignature]);

  const openProjectSettings = useCallback(
    (projectGroup: SidebarProjectSnapshot) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/projects/$projectKey",
        params: { projectKey: projectGroup.projectKey },
      });
    },
    [isMobile, router, setOpenMobile],
  );
  const handleProjectSettings = useCallback(
    (
      event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
      projectGroup: SidebarProjectSnapshot,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      setProjectScopeMenuOpen(false);
      openProjectSettings(projectGroup);
    },
    [openProjectSettings],
  );

  // Keep a dropped row at its destination while its server applies the
  // lifecycle command and any order-key writes. The next pickup waits for
  // this hold so a second drop cannot replace an unconfirmed placement.
  const [optimisticDrop, setOptimisticDrop] = useState<{
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
    /** Full destination order for pinned and active drops. */
    readonly order: readonly string[] | null;
    /** Destination order keys before the drop, to recognize concurrent writes. */
    readonly keysAtDrop: ReadonlyMap<string, string | null>;
    /** The keys this drop writes (one per planned assignment). The
        override holds until all of them appear in canonical state. */
    readonly assignedKeys: ReadonlyMap<string, string>;
  } | null>(null);
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
  } = useMemo(() => {
    // Snooze classification uses a REAL clock, not the quantized minute:
    // wake times are second-precise and a woken thread must not linger on
    // the shelf for the rest of the minute. snoozeWakeTick re-runs this
    // memo exactly at the next wake boundary.
    void snoozeWakeTick;
    const preciseNow = new Date().toISOString();
    // Subagent child threads live in the parent's Agents surface, not the
    // sidebar roster (v2 models them as real threads with lineage). Each fork
    // filter is then evaluated separately so the empty state can be attributed
    // by counterfactual — "would clearing just this one admit a row?" — rather
    // than by which filters happen to be switched on.
    let admittedWithoutEnvironment = 0;
    let admittedWithoutProjects = 0;
    const visible = filterSidebarV2VisibleThreads(threads, null).filter((thread) => {
      const projectKey = `${thread.environmentId}:${thread.projectId}`;
      const passesEnvironment =
        environmentFilter.resolvedScope === null ||
        environmentFilter.resolvedScope.has(thread.environmentId);
      const passesProjects =
        !hiddenPhysicalProjectKeys.has(projectKey) &&
        (scopedProjectKeys === null || scopedProjectKeys.has(projectKey));
      if (passesProjects) admittedWithoutEnvironment += 1;
      if (passesEnvironment) admittedWithoutProjects += 1;
      return passesEnvironment && passesProjects;
    });
    inboxReturns.observe(workingShelfEnabled ? threads : null);
    const pinned: EnvironmentThreadShell[] = [];
    const active: EnvironmentThreadShell[] = [];
    const working: EnvironmentThreadShell[] = [];
    // Working beta: only inbox threads fold away. Pins stay where the user
    // put them, and snoozed or settled threads keep their shelves.
    const inbox = (thread: EnvironmentThreadShell) =>
      workingShelfEnabled && isSidebarThreadWorking(thread) ? working : active;
    const snoozed: EnvironmentThreadShell[] = [];
    const settled: EnvironmentThreadShell[] = [];
    const draggable = new Set<string>();
    const activeReorderable = new Set<string>();
    for (const thread of visible) {
      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      // Threads on servers without the settlement capability (old server,
      // or descriptor not loaded yet) never classify as settled: the user
      // could neither un-settle nor pin them, so auto-settling them would
      // strand rows in a tail with no working affordances.
      const supportsSettlement = capabilities?.threadSettlement === true;
      const supportsSnooze = capabilities?.threadSnooze === true;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      if (capabilities?.threadActiveReorder === true) activeReorderable.add(threadKey);
      // Older servers retain their existing drag actions. Active placement
      // additionally requires its own ordering capability at the drop target.
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
    // One shared rule on every platform (see sortPinnedThreadsByOrderKey):
    // user-arranged keys first, keyless threads in creation order below.
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
              getId: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
            }),
      draggableThreadKeys: draggable,
      activeReorderableThreadKeys: activeReorderable,
      activeThreads:
        optimisticDrop?.section !== "active" || optimisticDrop.order === null
          ? sortedActive
          : orderItemsByPreferredIds({
              items: sortedActive,
              preferredIds: optimisticDrop.order,
              getId: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
            }),
      // Newest send first; finishing and waking again do not move a row.
      workingThreads: sortWorkingThreadsBySend(working),
      // Soonest wake first: "what comes back next" is the shelf's question.
      // snoozeWakeSortMs parks indefinite snoozes (no wake time) last.
      snoozedThreads: snoozed.toSorted(
        (left, right) => snoozeWakeSortMs(left) - snoozeWakeSortMs(right),
      ),
      settledThreads: sortSettledThreads(settled),
      snoozeNow: preciseNow,
      emptyStateCause: resolveSidebarEmptyStateCause({
        environmentScopeActive: environmentFilter.scope !== null,
        projectFiltersActive: scopedProjectKeys !== null || hiddenPhysicalProjectKeys.size > 0,
        admittedWithoutEnvironment,
        admittedWithoutProjects,
      }),
    };
  }, [
    hiddenPhysicalProjectKeys,
    nowMinute,
    optimisticDrop,
    environmentFilter.resolvedScope,
    environmentFilter.scope,
    scopedProjectKeys,
    serverConfigs,
    snoozeWakeTick,
    threads,
    workingShelfEnabled,
  ]);

  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const isSearchingThreads = threadSearchQuery.trim().length > 0;
  const searchableThreads = useMemo(
    () => [
      ...pinnedThreads,
      ...activeThreads,
      ...workingThreads,
      ...snoozedThreads,
      ...settledThreads,
    ],
    [activeThreads, pinnedThreads, settledThreads, snoozedThreads, workingThreads],
  );
  const searchEnvironmentIds = useConnectedEnvironmentIds();
  // useThreadSearch owns the debounce and the two-character floor.
  const threadSearch = useThreadSearch(searchEnvironmentIds, threadSearchQuery);
  const threadSearchMatchByKey = useMemo(
    () =>
      new Map(threadSearch.matches.map((match) => [threadSearchMatchKey(match), match] as const)),
    [threadSearch.matches],
  );
  const threadSearchResults = useMemo(
    () =>
      searchSidebarThreads(
        searchableThreads,
        threadSearchQuery,
        new Set(threadSearchMatchByKey.keys()),
      ),
    [searchableThreads, threadSearchQuery, threadSearchMatchByKey],
  );
  const threadSearchResultOrderKey = threadSearchResults
    .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
    .join("\0");

  useEffect(() => {
    setActiveSearchResultIndex(0);
  }, [threadSearchResultOrderKey]);

  useEffect(() => {
    if (!isSearchingThreads) return;
    document
      .getElementById(`sidebar-thread-search-result-${activeSearchResultIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultIndex, isSearchingThreads, threadSearchResultOrderKey]);

  // Arm a timeout for the earliest upcoming wake so the shelf empties the
  // moment a snooze expires instead of on the next minute tick. Scans every
  // row: until-done rows sort first but carry no timer, so entry 0 is not
  // the boundary.
  useEffect(() => {
    let nextWakeAtMs = Number.NaN;
    for (const thread of snoozedThreads) {
      if (thread.snoozedUntil == null) continue;
      const wakeAtMs = Date.parse(thread.snoozedUntil);
      if (Number.isNaN(wakeAtMs)) continue;
      if (Number.isNaN(nextWakeAtMs) || wakeAtMs < nextWakeAtMs) nextWakeAtMs = wakeAtMs;
    }
    if (Number.isNaN(nextWakeAtMs)) return;
    // setTimeout delays are signed 32-bit: anything larger overflows and
    // fires immediately, turning a far-future wake (event-condition snoozes
    // synced from elsewhere) into a tight re-arm loop. Clamped, the timer
    // just re-arms every ~24.8 days until the wake is in range.
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [snoozedThreads]);

  // The settled tail renders in pages: history shouldn't dominate the
  // sidebar, and the common lookups are recent. Expansion resets when the
  // filter context changes so a scope/search flip never inherits a deep
  // page state.
  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_TAIL_INITIAL_COUNT);
  const settledResetKey = `${projectFilterSignature}:${environmentFilter.signature}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT);
  }
  const visibleSettledThreads = useMemo(() => {
    if (settledThreads.length <= settledVisibleCount) return settledThreads;
    const visible = settledThreads.slice(0, settledVisibleCount);
    // The open thread must never hide under "Show more": navigating into a
    // deep settled thread (search, deep link) pulls its row into the visible
    // tail so the highlight and the un-settle affordance stay reachable.
    if (routeThreadKey !== null) {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
        );
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible;
  }, [routeThreadKey, settledThreads, settledVisibleCount]);
  const hiddenSettledCount = settledThreads.length - visibleSettledThreads.length;
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT),
    [],
  );
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const toggleSettledShelf = useCallback(
    () => setSettledShelfExpanded((value) => !value),
    [setSettledShelfExpanded],
  );
  const renderedSettledThreads = useMemo(() => {
    if (settledShelfExpanded) return visibleSettledThreads;
    if (routeThreadKey === null) return EMPTY_THREADS;
    const routeThread = visibleSettledThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, settledShelfExpanded, visibleSettledThreads]);

  // The snoozed shelf is collapsed by default: out of the way, never gone.
  // Collapsed threads don't render (and so don't participate in jump
  // shortcuts or multi-select), matching the settled tail's paging model.
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleSnoozedShelf = useCallback(
    () => setSnoozedShelfExpanded((value) => !value),
    [setSnoozedShelfExpanded],
  );
  // Pinned is the block the user curated to the top, so it starts expanded;
  // folding it is still remembered per device like every other shelf.
  const [pinnedShelfExpanded, setPinnedShelfExpanded] = useLocalStorage(
    PINNED_SHELF_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const togglePinnedShelf = useCallback(
    () => setPinnedShelfExpanded((value) => !value),
    [setPinnedShelfExpanded],
  );
  // Same exception every other shelf makes: the open thread keeps its row,
  // so a folded pinned block never hides the thread being read.
  const visiblePinnedThreads = useMemo(() => {
    if (pinnedShelfExpanded) return pinnedThreads;
    if (routeThreadKey === null) return EMPTY_THREADS;
    const routeThread = pinnedThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [pinnedShelfExpanded, pinnedThreads, routeThreadKey]);
  const visibleSnoozedThreads = useMemo(() => {
    if (snoozedShelfExpanded) return snoozedThreads;
    // The open thread must never vanish behind the collapsed shelf: a
    // snoozed thread reached by route (deep link, open before snoozing
    // elsewhere) keeps its row — with highlight and wake affordance — same
    // exception the settled tail's "Show more" makes.
    if (routeThreadKey === null) return EMPTY_THREADS;
    const routeThread = snoozedThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, snoozedShelfExpanded, snoozedThreads]);

  // The Working shelf (beta) collapses the same way, with the same route
  // exception: sending a message folds the open thread into the shelf, and
  // its row must stay visible there.
  const [workingShelfExpanded, setWorkingShelfExpanded] = useLocalStorage(
    WORKING_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleWorkingShelf = useCallback(
    () => setWorkingShelfExpanded((value) => !value),
    [setWorkingShelfExpanded],
  );
  const visibleWorkingThreads = useMemo(() => {
    if (workingShelfExpanded) return workingThreads;
    if (routeThreadKey === null) return EMPTY_THREADS;
    const routeThread = workingThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, workingShelfExpanded, workingThreads]);

  // Fork: the built-in Active group folds like a custom group, open by
  // default and remembered per device under its own key.
  const [activeShelfExpanded, setActiveShelfExpanded] = useLocalStorage(
    ACTIVE_SHELF_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const toggleActiveShelf = useCallback(
    () => setActiveShelfExpanded((value) => !value),
    [setActiveShelfExpanded],
  );
  // Fork: Active split into custom group sections (Active itself is null),
  // in catalog placement order; without groups, Active is the only section.
  // A folded section keeps the open thread's row, and search shows every match.
  const activeGroupSections = useMemo(() => {
    const sections = new Map<string | null, EnvironmentThreadShell[]>([
      [null, []],
      ...customGroups.groups.map((group) => [group.id, [] as EnvironmentThreadShell[]] as const),
    ]);
    for (const thread of activeThreads)
      sections.get(threadGroupId(thread, customGroups.groups))!.push(thread);
    return threadGroupSections(customGroups.groups).map((group) => ({
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
  }, [
    activeThreads,
    customGroups.groups,
    collapsedGroups,
    activeShelfExpanded,
    isSearchingThreads,
    routeThreadKey,
  ]);
  // Fork: the recent-archive shelf, folded by default and remembered per
  // device like the snoozed shelf. The open thread keeps its row either way.
  const recentArchive = useMemo(
    () =>
      selectRecentArchivedThreads(archivedSnapshots, archivedSectionVisibleCount, routeThreadKey),
    [archivedSectionVisibleCount, archivedSnapshots, routeThreadKey],
  );
  const [archivedShelfExpanded, setArchivedShelfExpanded] = useLocalStorage(
    ARCHIVED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleArchivedShelf = useCallback(
    () => setArchivedShelfExpanded((value) => !value),
    [setArchivedShelfExpanded],
  );
  const visibleArchivedThreads = useMemo(
    () =>
      archivedShelfExpanded
        ? recentArchive.threads
        : recentArchive.threads.filter(
            (thread) =>
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
          ),
    [archivedShelfExpanded, recentArchive.threads, routeThreadKey],
  );

  const orderedThreads = useMemo(
    () => [
      ...visiblePinnedThreads,
      ...activeGroupSections.flatMap((section) => section.threads),
      ...visibleWorkingThreads,
      ...visibleSnoozedThreads,
      ...renderedSettledThreads,
    ],
    [
      visiblePinnedThreads,
      activeGroupSections,
      visibleWorkingThreads,
      visibleSnoozedThreads,
      renderedSettledThreads,
    ],
  );
  const orderedThreadKeys = useMemo(
    () =>
      orderedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [orderedThreads],
  );
  // Rows call back into the click handler without carrying the ordered list as
  // a prop — a fresh array identity per shell update would defeat every row's
  // memoization. The ref keeps shift-range-select working against the list as
  // rendered at click time.
  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  orderedThreadKeysRef.current = orderedThreadKeys;
  const threadByKey = useMemo(
    () =>
      new Map(
        orderedThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [orderedThreads],
  );
  // Handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey);
  threadByKeyRef.current = threadByKey;
  // handleNewThread is inherently unstable (depends on the projects list);
  // a ref keeps it out of attemptSettle's dependency array.
  const handleNewThreadRef = useRef(newThreadContext.handleNewThread);
  handleNewThreadRef.current = newThreadContext.handleNewThread;
  const settledThreadKeys = useMemo(
    () =>
      new Set(
        settledThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [settledThreads],
  );
  const settledThreadKeysRef = useRef(settledThreadKeys);
  settledThreadKeysRef.current = settledThreadKeys;
  const snoozedThreadKeys = useMemo(
    () =>
      new Set(
        snoozedThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [snoozedThreads],
  );
  const snoozedThreadKeysRef = useRef(snoozedThreadKeys);
  snoozedThreadKeysRef.current = snoozedThreadKeys;

  const jumpLabelByKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  }, [keybindings, orderedThreadKeys]);
  const { showThreadJumpHints: showJumpHints, updateThreadJumpHintsVisibility } =
    useThreadJumpHintVisibility();

  // Settled threads are live shells, so opening one is plain navigation:
  // history stays readable without un-settling, and sending a message or
  // starting a session un-settles server-side.
  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
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
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );
  // Direct picks (row clicks, Enter/Space, search results) route through the
  // split-aware helper so the thread lands in the active pane; forward
  // navigation after settle/archive keeps using navigateToThread — it must
  // always retarget the primary route. The primary branch delegates to
  // navigateToThread wholesale, so only the split-local branches repeat its
  // selection/mobile prep. The sidebar sits outside both pane roots, so the
  // click's own pointerdown never changes which pane is active.
  const openThreadFromSidebar = useCallback(
    (threadRef: ScopedThreadRef) => {
      const { plan } = openThreadInActivePane({
        targetRef: threadRef,
        routeThreadRef,
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
    },
    [clearSelection, isMobile, navigateToThread, routeThreadRef, setOpenMobile, setSelectionAnchor],
  );
  const attemptUnarchive = useCallback(
    (threadRef: ScopedThreadRef) => {
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
    },
    [unarchiveThread],
  );
  const handleArchivedThreadContextMenu = useCallback(
    (thread: EnvironmentThreadShell, position: { x: number; y: number }) => {
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
    },
    [attemptUnarchive, confirmAndDeleteThread],
  );
  const openAllArchivedThreads = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void router.navigate({ to: "/settings/archived" });
  }, [isMobile, router, setOpenMobile]);

  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const handleThreadFileDrop = useCallback(
    async (threadRef: ScopedThreadRef, files: File[]) => {
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
    },
    [clearPendingFileDrop, navigateToThread, queuePendingFileDrop, router],
  );

  const navigateToDraft = useCallback(
    (draftId: DraftId) => {
      // Unconditional: also drops a stale selection anchor left by
      // plain-click navigation, so a later shift-click starts fresh
      // instead of ranging from a row that is no longer the context.
      // (clearSelection no-ops when there is nothing to clear.)
      clearSelection();
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [clearSelection, isMobile, router, setOpenMobile],
  );

  const clearThreadSearch = useCallback(() => {
    setThreadSearchQuery("");
    setActiveSearchResultIndex(0);
  }, []);
  const selectThreadSearchResult = useCallback(
    (thread: EnvironmentThreadShell) => {
      clearThreadSearch();
      openThreadFromSidebar(scopeThreadRef(thread.environmentId, thread.id));
    },
    [clearThreadSearch, openThreadFromSidebar],
  );
  const handleThreadSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // IME composition (Japanese/Chinese input) uses the same keys; committing
      // a candidate must not move the highlight or navigate away mid-compose.
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
    },
    [
      activeSearchResultIndex,
      clearThreadSearch,
      isSearchingThreads,
      selectThreadSearchResult,
      threadSearchResults,
    ],
  );

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const startThreadRename = useCallback((threadRef: ScopedThreadRef, title: string) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
  }, []);
  const cancelThreadRename = useCallback(() => setRenamingThreadKey(null), []);
  const commitThreadRename = useCallback(
    (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
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
    },
    [updateThreadMetadata],
  );

  const handleThreadClick = useCallback(
    (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
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
    },
    [openThreadFromSidebar, rangeSelectTo, toggleThreadSelection],
  );

  // A settle per thread at a time: double clicks and repeated menu picks
  // must not dispatch a second settle that fails and toasts a false error.
  const settlingThreadKeysRef = useRef(new Set<string>());
  // Parking the thread you're looking at (settle or snooze) moves you
  // forward: the next remaining card (never a settled or snoozed row, never
  // one leaving in the same batch), or a fresh draft in this project when it
  // was the last active one. Callers snapshot the plan BEFORE the command
  // mutates the partition; background parks never navigate (null plan).
  const planForwardNavigation = useCallback(
    (threadKey: string, coParkingKeys?: ReadonlySet<string>): (() => void) | null => {
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
    },
    [navigateToThread, router],
  );

  const attemptSettle = useCallback(
    (threadRef: ScopedThreadRef, opts: { coSettlingKeys?: ReadonlySet<string> } = {}) => {
      void (async () => {
        const threadKey = scopedThreadKey(threadRef);
        if (settlingThreadKeysRef.current.has(threadKey)) return;
        settlingThreadKeysRef.current.add(threadKey);
        try {
          const navigateAfterSettle = planForwardNavigation(threadKey, opts.coSettlingKeys);
          const result = await settleThread(threadRef);
          if (result._tag === "Failure") {
            // Never navigate away from a thread that did not settle.
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
          // Only move forward if the user is still on the settled thread —
          // a navigation made during the await wins over ours.
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
        } finally {
          settlingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [planForwardNavigation, settleThread],
  );
  // Post-settle navigation must skip threads settling in this same batch —
  // they are all leaving the card block together. Rows that are already
  // explicitly settled are skipped: nothing to do on a valid mixed selection.
  // Pinned rows ARE included: the decider clears the pin as part of settling,
  // so they park like the rest.
  const settleThreads = useCallback(
    (threadKeys: readonly string[]) => {
      const coSettlingKeys = new Set(threadKeys);
      for (const threadKey of threadKeys) {
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread || thread.settledOverride === "settled") continue;
        attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys });
      }
    },
    [attemptSettle],
  );
  const attemptUnsettle = useCallback(
    (threadRef: ScopedThreadRef) => {
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
    },
    [unsettleThread],
  );
  const attemptFork = useCallback(
    (threadRef: ScopedThreadRef) => {
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
    },
    [forkThread],
  );
  const attemptUnsnooze = useCallback(
    (threadRef: ScopedThreadRef) => {
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
    },
    [unsnoozeThread],
  );
  const threadListRef = useRef<HTMLUListElement | null>(null);
  const sidebarRemSizeRef = useRef(16);
  const dragLabelOffsetRef = useRef(0);
  const restrictBelowPins = useCallback<Modifier>(
    (args) => restrictBelowSidebarLabel(args, dragLabelOffsetRef.current),
    [],
  );
  const listMotionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const attachListMotionRef = useCallback((node: HTMLUListElement | null) => {
    threadListRef.current = node;
    if (node !== null) {
      sidebarRemSizeRef.current =
        Number.parseFloat(getComputedStyle(node.ownerDocument.documentElement).fontSize) || 16;
    }
    listMotionRef.current?.dispose();
    listMotionRef.current = node === null ? null : createSidebarListMotion(node);
    listMotionRef.current?.update(false);
  }, []);

  // Hold the chosen section and order until every key write arrives. This
  // also covers first-time ordering, which assigns keys to keyless neighbors.
  // A failed write, concurrent reorder, or membership change releases the hold.
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
  const isContextDrag = dragState?.contextDrag === true;
  const dragTargetSection = isContextDrag ? null : (dragState?.targetSection ?? null);
  const dragSensorRef = useRef<SidebarPointerSensor | null>(null);
  const contextDragKeyRef = useRef<string | null>(null);
  const finishThreadDrag = useCallback((started: boolean) => {
    dragSensorRef.current = null;
    contextDragKeyRef.current = null;
    endThreadContextDrag();
    if (started) {
      listMotionRef.current?.release();
      setDragState(null);
    }
  }, []);
  const attachDragSensor = useCallback((sensor: SidebarPointerSensor) => {
    dragSensorRef.current = sensor;
  }, []);
  const cancelThreadDrag = useCallback(() => {
    dragSensorRef.current?.cancel();
  }, []);
  // Dragged threads: the multi-selection when the picked-up row is part of it.
  const contextDragThreads = useCallback((): ReadonlyArray<ScopedThreadRef> => {
    const key = contextDragKeyRef.current;
    if (key === null) return [];
    const selected = useThreadSelectionStore.getState().selectedThreadKeys;
    const keys = selected.has(key) ? [...selected] : [key];
    return keys.flatMap((candidate) => {
      const ref = parseScopedThreadKey(candidate);
      return ref ? [ref] : [];
    });
  }, []);
  const pointerOutsideThreadList = useCallback((point: { x: number; y: number }) => {
    const bounds = threadListRef.current?.getBoundingClientRect();
    return bounds !== undefined && (point.x < bounds.left || point.x > bounds.right);
  }, []);
  const moveThreadContextDrag = useCallback(
    (point: { x: number; y: number }) => {
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
    },
    [contextDragThreads, pointerOutsideThreadList],
  );
  const dropThreadContextDrag = useCallback(
    (point: { x: number; y: number }) => {
      if (!pointerOutsideThreadList(point)) return false;
      dropThreadContext(point, contextDragThreads());
      // Releasing outside the list never reorders, whether or not a composer took the drop.
      return true;
    },
    [contextDragThreads, pointerOutsideThreadList],
  );
  const dndSensors = useSensors(
    useSensor(SidebarPointerSensor, {
      distance: SIDEBAR_DRAG_DISTANCE,
      onAttach: attachDragSensor,
      onFinish: finishThreadDrag,
      onMove: moveThreadContextDrag,
      onDrop: dropThreadContextDrag,
    }),
  );
  const sectionByThreadKey = useMemo(() => {
    const map = new Map<string, SidebarSection>();
    const add = (list: readonly EnvironmentThreadShell[], section: SidebarSection) => {
      for (const thread of list) {
        map.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), section);
      }
    };
    add(pinnedThreads, "pinned");
    add(activeThreads, "active");
    add(workingThreads, "working");
    add(snoozedThreads, "snoozed");
    add(settledThreads, "settled");
    return map;
  }, [activeThreads, pinnedThreads, settledThreads, snoozedThreads, workingThreads]);
  const sectionByThreadKeyRef = useRef(sectionByThreadKey);
  sectionByThreadKeyRef.current = sectionByThreadKey;
  // Drag a row action to apply it to the armed rows in the same section.
  // Staying in one section keeps an overshoot from changing neighboring
  // sections, whose boundaries may be hidden outside a row drag. The sweep
  // runs on the row drag's sensor and ref, so unmounting the list cancels it.
  const [actionSweep, setActionSweep] = useState<{
    action: SidebarSweepAction;
    keys: ReadonlySet<string>;
  } | null>(null);
  const startActionSweep = useCallback(
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
        // Also runs after a press that never moved. Nothing is swept then,
        // and the button's own click applies its action. Rows that changed
        // section mid-gesture, say pinned from another device, are skipped.
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
    [attemptUnsettle, attemptUnsnooze, serverConfigs, settleThreads],
  );
  const pinnedKeys = useMemo(
    () =>
      visiblePinnedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [visiblePinnedThreads],
  );
  const activeKeys = useMemo(
    () =>
      activeThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [activeThreads],
  );
  useEffect(() => {
    if (optimisticDrop === null) return;
    const canonicalByKey = new Map(
      threads.map((thread) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        thread,
      ]),
    );
    const thread = canonicalByKey.get(optimisticDrop.key);
    if (thread === undefined || thread.archivedAt !== null) {
      setOptimisticDrop(null);
      return;
    }
    const canonicalSection = effectiveSnoozed(thread, { now: new Date().toISOString() })
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
      setOptimisticDrop(null);
      return;
    }
    if (optimisticDrop.order === null) {
      // Settle also emits unpin/unsnooze events. Wait for the entire move
      // before releasing the projected fields and sort timestamps.
      if (
        canonicalSection === optimisticDrop.section &&
        thread.pinnedAt == null &&
        (!optimisticDrop.clearsSnooze || (thread.snoozedUntil == null && thread.snoozedAt == null))
      ) {
        setOptimisticDrop(null);
      }
      return;
    }
    // Fork: a competing group move or a deleted target group releases the hold.
    const currentGroupId = threadGroupId(thread, customGroups.groups);
    if (
      optimisticDrop.section === "active" &&
      shouldReleaseSidebarGroupDrop({
        sourceGroupId: optimisticDrop.sourceCustomGroupId,
        targetGroupId: optimisticDrop.customGroupId,
        currentGroupId,
        targetExists:
          optimisticDrop.customGroupId === null ||
          customGroups.groups.some((group) => group.id === optimisticDrop.customGroupId),
        targetSeen: optimisticDrop.customGroupSeen,
      })
    ) {
      setOptimisticDrop(null);
      return;
    }
    if (
      optimisticDrop.section === "active" &&
      !optimisticDrop.customGroupSeen &&
      currentGroupId === optimisticDrop.customGroupId
    ) {
      setOptimisticDrop({ ...optimisticDrop, customGroupSeen: true });
      return;
    }
    if (canonicalSection !== optimisticDrop.section) return;
    if (
      canonicalSection === "active" &&
      threadGroupId(thread, customGroups.groups) !== optimisticDrop.customGroupId
    )
      return;
    if (optimisticDrop.clearsSnooze && (thread.snoozedUntil != null || thread.snoozedAt != null)) {
      return;
    }
    // Fork: an active drop is placed among its destination group's rows only.
    const destinationKeys =
      optimisticDrop.section === "pinned"
        ? pinnedKeys
        : activeKeys.filter((key) => {
            const canonical = canonicalByKey.get(key);
            return (
              canonical !== undefined &&
              threadGroupId(canonical, customGroups.groups) === optimisticDrop.customGroupId
            );
          });
    const canonicalDestination = destinationKeys.flatMap((key) => {
      const canonical = canonicalByKey.get(key);
      return canonical === undefined ? [] : [canonical];
    });
    const keyByThread = new Map(
      canonicalDestination.map((thread) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
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
    if (membershipChanged || foreignKeyLanded || allAssignmentsLanded) {
      setOptimisticDrop(null);
    }
  }, [activeKeys, optimisticDrop, pinnedKeys, threads, customGroups.groups]);
  const attemptPin = useCallback(
    (threadRef: ScopedThreadRef) => {
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
    },
    [pinThread],
  );
  const attemptUnpin = useCallback(
    (threadRef: ScopedThreadRef) => {
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
    },
    [confirmAndUnpinThread],
  );

  // Fork: the Pinned shelf header and the group headers already mark these
  // boundaries, so their drag labels stay hidden and open no space. Any space
  // opened here draws every row below it away from its at-rest drop rect.
  const pinnedDragLabelHeight = pinnedThreads.length > 0 ? 0 : SIDEBAR_DRAG_LABEL_HEIGHT;
  const dividerDragLabelHeight = hasCustomGroups ? 0 : SIDEBAR_DRAG_LABEL_HEIGHT;
  const handleThreadDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeKey = String(event.active.id);
      contextDragKeyRef.current = activeKey;
      const activeSection = sectionByThreadKey.get(activeKey);
      if (activeSection === undefined) return;
      // Stop normal section motion before dnd-kit measures the picked-up row.
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
    },
    [sectionByThreadKey, threadByKey, customGroups.groups, pinnedDragLabelHeight],
  );
  // Include every visible row in the measured order. Older servers disable
  // pickup on their rows without changing where those rows render.
  const sidebarListItems = useMemo((): readonly SidebarListItem[] => {
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
              customGroupId: threadGroupId(thread, customGroups.groups),
            }
          : { kind: "thread", key, section };
      });
    if (
      pinnedThreads.length +
        activeThreads.length +
        workingThreads.length +
        snoozedThreads.length +
        settledThreads.length +
        customGroups.groups.length ===
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
  }, [
    activeThreads,
    activeGroupSections,
    hasCustomGroups,
    customGroups.groups,
    pinnedThreads.length,
    visiblePinnedThreads,
    renderedSettledThreads,
    settledThreads.length,
    snoozedThreads.length,
    visibleSnoozedThreads,
    visibleWorkingThreads,
    workingThreads.length,
  ]);
  useEffect(() => {
    if (
      dragState !== null &&
      !sidebarListItems.some((item) => item.kind === "thread" && item.key === dragState.activeKey)
    ) {
      cancelThreadDrag();
    }
  }, [cancelThreadDrag, dragState, sidebarListItems]);
  const listMotionPaused = dragState !== null;
  // Every shell event rebuilds sidebarListItems, but rows only move when the
  // rendered order or a row's section changes. Keying the motion pass on that
  // keeps ordinary updates from forcing a layout read and animating rows
  // whose position drifted for other reasons.
  const sidebarListOrderKey = useMemo(
    () =>
      sidebarListItems
        .map((item) => (item.kind === "thread" ? `${item.key}:${item.section}` : item.marker))
        .join("\0"),
    [sidebarListItems],
  );
  const sidebarListHasRows = sidebarListItems.length + visibleDraftSessionCount > 0;
  useLayoutEffect(() => {
    // Drag release clears the baseline, so its commit cannot replay the
    // sortable preview; rows glide from their released positions instead.
    // Later thread actions can animate while writes settle.
    // Draft navigation can reveal a frozen row without changing the draft count.
    void sidebarListOrderKey;
    listMotionRef.current?.update(!listMotionPaused && sidebarListHasRows);
  }, [
    listMotionPaused,
    routeDraftIdForRows,
    sidebarListHasRows,
    sidebarListOrderKey,
    visibleDraftSessionCount,
  ]);
  const handleThreadDragOver = useCallback(
    (event: DragOverEvent) => {
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
    },
    [sidebarListItems],
  );
  const sortableIds = useMemo(() => sidebarListItems.map(sidebarListItemId), [sidebarListItems]);
  const draggedSettledOrder = useMemo(() => {
    const thread = dragState === null ? undefined : threadByKey.get(dragState.activeKey);
    if (dragState === null || thread === undefined) return [];
    const key = (candidate: EnvironmentThreadShell) =>
      scopedThreadKey(scopeThreadRef(candidate.environmentId, candidate.id));
    return sortSettledThreads([
      ...settledThreads.filter((candidate) => key(candidate) !== dragState.activeKey),
      applySidebarThreadDrop(thread, "settled", dragState.occurredAt),
    ]).map(key);
  }, [dragState, settledThreads, threadByKey]);
  // Working beta: the inbox is time-ordered too, so the preview shows the
  // slot a drop will land in, not the slot under the pointer.
  const draggedActiveOrder = useMemo(() => {
    const thread = dragState === null ? undefined : threadByKey.get(dragState.activeKey);
    if (!workingShelfEnabled || dragState === null || thread === undefined) return undefined;
    const key = (candidate: EnvironmentThreadShell) =>
      scopedThreadKey(scopeThreadRef(candidate.environmentId, candidate.id));
    return sortInboxThreadsByReturn(
      [
        ...activeThreads.filter((candidate) => key(candidate) !== dragState.activeKey),
        applySidebarThreadDrop(thread, "active", dragState.occurredAt),
      ],
      inboxReturns.returnedAt,
    ).map(key);
  }, [activeThreads, dragState, threadByKey, workingShelfEnabled]);
  const foldedGroupIds = useMemo(
    () =>
      new Set<string | null>(activeShelfExpanded ? collapsedGroups : [...collapsedGroups, null]),
    [activeShelfExpanded, collapsedGroups],
  );
  const sidebarSortingStrategy = useMemo(
    () =>
      createSidebarSortingStrategy({
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
        cardHeight: (compactCards ? 3.75 : 5.125) * sidebarRemSizeRef.current,
        slimHeight: 2.25 * sidebarRemSizeRef.current,
      }),
    [
      compactCards,
      dividerDragLabelHeight,
      draggedActiveOrder,
      draggedSettledOrder,
      foldedGroupIds,
      isContextDrag,
      pinnedDragLabelHeight,
      routeThreadKey,
      settledShelfExpanded,
      settledVisibleCount,
      sidebarListItems,
      snoozedThreads.length,
    ],
  );
  // Hidden and filtered threads keep their keys. Reserve those slots without
  // including the rows in the visible drop order or writing to them.
  const { pinnedKeysById, activeKeysById } = useMemo(
    () => ({
      pinnedKeysById: new Map(
        threads.map((thread) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          thread.pinOrderKey ?? null,
        ]),
      ),
      activeKeysById: new Map(
        threads.map((thread) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          thread.activeOrderKey ?? null,
        ]),
      ),
    }),
    [threads],
  );
  const draggedThreadKey = dragState?.activeKey;
  const draggedFromSection = dragState?.activeSection;
  const dragActivationY = dragState?.activationY;
  const dndCollisionDetection = useMemo(() => {
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
  }, [
    customGroups.groups,
    activeKeysById,
    pinnedKeysById,
    serverConfigs,
    activeKeys,
    activeReorderableThreadKeys,
    draggedThreadKey,
    draggedFromSection,
    dragActivationY,
    draggableThreadKeys,
    pinnedKeys,
    sidebarListItems,
    threadByKey,
    workingShelfEnabled,
  ]);
  const handleThreadDragEnd = useCallback(
    (event: DragEndEvent) => {
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
          serverConfigs.get(activeThread.environmentId)?.environment.capabilities
            .threadSettlement === true,
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
      // A drop rewrites the dragged row and every row it renumbers, so all of
      // them must be writable before any of them changes.
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
        const destination = target.customGroupId;
        setCollapsedGroupIds((current) => current.filter((id) => id !== destination));
      } else if (target.section === "active") setActiveShelfExpanded(true);
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
          // A late failure must not cancel a newer drag's preview.
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
            // The drag expresses unpin intent; button/menu confirmation is unchanged.
            if (plan.unpin && !(await run(unpinThread(threadRef), "Failed to unpin thread")))
              return;
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
                pinThread(
                  threadRef,
                  plan.orderKey === undefined ? {} : { orderKey: plan.orderKey },
                ),
                "Failed to pin thread",
              ))
            )
              return;
            break;
          case "reorder-pinned":
            break;
        }
        // Stop on failure; each successful key write remains a valid placement.
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
    },
    [
      customGroups.groups,
      hasCustomGroups,
      setCollapsedGroupIds,
      setActiveShelfExpanded,
      setThreadCustomGroup,
      activeKeysById,
      pinnedKeysById,
      serverConfigs,
      activeKeys,
      activeReorderableThreadKeys,
      draggableThreadKeys,
      pinThread,
      pinnedKeys,
      planForwardNavigation,
      reorderPinnedThread,
      reorderActiveThread,
      sectionByThreadKey,
      settleThread,
      sidebarListItems,
      threadByKey,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
      workingShelfEnabled,
    ],
  );
  // One snooze per thread at a time — same double-dispatch guard as settle.
  const snoozingThreadKeysRef = useRef(new Set<string>());
  const performSnooze = useCallback(
    async (
      threadRef: ScopedThreadRef,
      preset: Pick<SnoozePreset, "snoozedUntil" | "untilDone">,
      opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
    ) => {
      const threadKey = scopedThreadKey(threadRef);
      if (snoozingThreadKeysRef.current.has(threadKey)) {
        return { status: "skipped" } as const;
      }
      snoozingThreadKeysRef.current.add(threadKey);
      try {
        // Snoozing the open thread moves you forward, same as settle —
        // both park the thread you're done with for now.
        const navigateAfterSnooze = planForwardNavigation(threadKey, opts.coSnoozingKeys);
        const result = await snoozeThread(threadRef, preset.snoozedUntil, {
          untilDone: preset.untilDone === true,
        });
        if (result._tag === "Failure") {
          // Never navigate away from a thread that did not snooze.
          return isAtomCommandInterrupted(result)
            ? ({ status: "interrupted" } as const)
            : ({ status: "failure", error: squashAtomCommandFailure(result) } as const);
        }
        // In a split, the other pane's thread takes over instead. Otherwise
        // move forward only if the user is still on the snoozed thread — a
        // navigation made during the await wins over ours.
        if (
          !foldSplitForParkedThread(threadKey, routeThreadKeyRef.current, navigateToThread) &&
          shouldNavigateAfterThreadPark({
            threadKey,
            currentThreadKey: routeThreadKeyRef.current,
            action: "snooze",
            now: new Date().toISOString(),
            thread: readThreadShell(threadRef),
          })
        ) {
          navigateAfterSnooze?.();
        }
        return { status: "success" } as const;
      } finally {
        snoozingThreadKeysRef.current.delete(threadKey);
      }
    },
    [navigateToThread, planForwardNavigation, snoozeThread],
  );
  const attemptSnooze = useCallback(
    (
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
    },
    [performSnooze],
  );

  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      // One exact actionable set: keys whose rows are actually rendered
      // right now. Selections can outlive their rows (settled-tail paging,
      // thread deletion elsewhere) and the menu labels must count only what
      // the actions will touch.
      const selectedThreadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      const threadKeys = selectedThreadKeys.filter((threadKey) =>
        threadByKeyRef.current.has(threadKey),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      // Snooze (N) is offered when every selected thread can actually take
      // it — a mixed selection with blocked-on-you work would half-apply.
      const selectionNow = new Date();
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
          canSnooze(thread, { now: selectionNow.toISOString() }),
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
      // Unpin (k) counts only the pinned rows in pin-capable environments —
      // on a mixed selection the unpinned rows are untouched, and the item
      // is omitted entirely when nothing selected is pinned.
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
      // The indefinite preset needs every selected environment to support
      // it; a mixed selection would half-apply.
      const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat, {
        untilWoken: selectedThreads.every(
          (thread) =>
            serverConfigs.get(thread.environmentId)?.environment.capabilities
              .threadSnoozeIndefinite === true,
        ),
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
          // Post-snooze navigation must skip threads snoozing in this same
          // batch — they are all leaving the card block together.
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
        // Each unpin reports its own failure, like the single-row action.
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
    [
      clearSelection,
      confirmThreadDelete,
      confirmThreadUnpin,
      customGroups.groups,
      hasCustomGroups,
      deleteThread,
      markThreadUnread,
      performSnooze,
      removeFromSelection,
      serverConfigs,
      setThreadCustomGroup,
      settleThreads,
      unpinThread,
      updateThreadMetadata,
      timestampFormat,
    ],
  );

  const handleDraftContextMenu = useCallback(
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
            if (projectGroup) openProjectSettings(projectGroup);
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
    [copyBranchToClipboard, copyPathToClipboard, openProjectSettings, projectByKey],
  );

  const handleThreadContextMenu = useCallback(
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
        // Un-settle pins the thread active until real activity clears the pin.
        // Environments without
        // the settlement capability get no lifecycle items at all.
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
        // Presets resolve at menu-open time (same as the popover).
        const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat, {
          untilWoken:
            serverConfigs.get(thread.environmentId)?.environment.capabilities
              .threadSnoozeIndefinite === true,
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
          canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
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
              canForkImportedSession: canForkImportedSessionWith(
                thread.providerInstanceId,
                serverConfigs.get(thread.environmentId)?.providers,
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
            if (threadProjectGroup) openProjectSettings(threadProjectGroup);
            return;
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
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
    [
      attemptArchiveThread,
      attemptFork,
      attemptPin,
      attemptSettle,
      attemptSnooze,
      attemptUnpin,
      attemptUnsettle,
      attemptUnsnooze,
      confirmThreadDelete,
      copyBranchToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      handleMultiSelectContextMenu,
      markThreadUnread,
      isolateProjectScope,
      openProjectSettings,
      projectByKey,
      serverConfigs,
      setThreadAutoSettle,
      setThreadCustomGroup,
      customGroups.groups,
      hasCustomGroups,
      startThreadRename,
      updateThreadMetadata,
      timestampFormat,
    ],
  );

  // Thread jump (cmd+1..9) and prev/next traversal reuse the same commands as
  // v1 — the keybinding layer is shared, only the ordered list differs.
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
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

  // Same predicate as v1: hints show only while the held modifiers exactly
  // match a thread-jump binding. Adding Shift (screenshots) or Alt no
  // longer matches ⌘1..9, so the overlay hides for chords like ⌘⇧4.
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
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

  // New thread defaults to the project you're in (active thread's project,
  // falling back to the top project) — same resolution the command palette
  // uses. The command palette already offers a "New thread in..." submenu
  // for multi-project setups.
  const handleNewThreadClick = useCallback(
    (event?: ReactMouseEvent) => {
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
    },
    [
      environmentFilter.resolvedScope,
      hiddenPhysicalProjectKeys,
      isMobile,
      newThreadContext,
      projectGroups.length,
      scopedProjectKeys,
      setOpenMobile,
    ],
  );

  // The button mirrors chat.new: in multi-project setups both route through
  // the command palette's "New thread in..." picker, and in single-project
  // setups both create immediately. In multi-project setups the label is only
  // the picker's shortcut: falling back to chat.newLocal would advertise the
  // same shortcut for both the picker and direct create. In single-project
  // setups both commands create directly, so chat.newLocal is a valid
  // fallback. The second tooltip line (multi-project only) advertises
  // shift+click and its keyboard twin chat.newLocal for direct create.
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
          // Lifted above the stage backdrop, whose fade bleeds below the
          // header and would otherwise paint across the search row's outline.
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
                  <Menu open={projectScopeMenuOpen} onOpenChange={setProjectScopeMenuOpen}>
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
                        <FolderIcon className="size-4 shrink-0" />
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
                        <span className="min-w-0 truncate text-sm">All projects</span>
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
                                "min-w-0 flex-1 truncate text-sm",
                                isHidden && "line-through",
                              )}
                            >
                              {project.displayName}
                              {isHidden ? <span className="sr-only"> (hidden)</span> : null}
                            </span>
                            {showProjectEnvironments ? (
                              <ProjectEnvironmentBadge
                                group={project}
                                primaryEnvironmentId={primaryEnvironmentId}
                                machineByEnvironmentId={environmentMachineById}
                              />
                            ) : null}
                            {/* Dot after the badge: the badge is only present
                                on some rows, so the dots would otherwise sit
                                in two columns. */}
                            {accentColor ? (
                              <>
                                <span
                                  aria-hidden
                                  className="size-2.5 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/10"
                                  style={{ backgroundColor: accentColor }}
                                />
                                <span className="sr-only">Accent {accentColor}</span>
                              </>
                            ) : null}
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    aria-label={`${isHidden ? "Show" : "Hide"} ${project.displayName}`}
                                    className="ml-auto inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/55 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
                            className="absolute right-8 top-1/2 z-10 inline-flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground/70 outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
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
                modifiers={[
                  restrictToVerticalAxis,
                  restrictBelowPins,
                  restrictToFirstScrollableAncestor,
                ]}
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
                      // An action sweep owns the pointer: rows it passes over
                      // neither show hover actions nor open tooltips, even
                      // controls that opt back in, like the Woke pill.
                      actionSweep !== null && "**:pointer-events-none",
                    )}
                  >
                    {(() => {
                      const renderThreadRowInner = (
                        thread: EnvironmentThreadShell,
                        section: SidebarSection,
                        sortable?: SortableThreadRowBag,
                      ) => {
                        const threadKey = scopedThreadKey(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        // Settled and snoozed are the ONLY things that collapse a
                        // row: every other thread is a full card. Density comes
                        // from users (or the auto rules) actually parking work,
                        // not from the sidebar second-guessing what still matters.
                        // Working rows stay cards so their live status shows.
                        const isCard =
                          section === "active" || section === "pinned" || section === "working";
                        const rowVariant = isCard ? "card" : "slim";
                        return (
                          <SidebarThreadRow
                            // Fade between card and compact rows while the outer
                            // sortable wrapper keeps its identity during a drag.
                            key={`${threadKey}:${rowVariant}`}
                            thread={thread}
                            variant={rowVariant}
                            // Snoozed rows wake, settled rows un-settle, and cards settle.
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
                            snoozeUntilWokenSupported={
                              serverConfigs.get(thread.environmentId)?.environment.capabilities
                                .threadSnoozeIndefinite === true
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
                            sortable={sortable}
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
                                  : snoozeShelfLabel(thread)
                                : null
                            }
                            // All sections: a woken thread can classify straight
                            // into the settled tail (PR merged while snoozed), and
                            // the wake signal must survive the trip. Still-snoozed
                            // rows resolve to null on their own.
                            wokeAt={threadWokeAt(thread, { now: snoozeNow })}
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
                            changeRequestSnapshot={
                              changeRequestSnapshotByKey.get(threadKey) ?? null
                            }
                            onChangeRequestSnapshot={setThreadChangeRequestSnapshot}
                          />
                        );
                      };
                      const renderThreadRow = (
                        thread: EnvironmentThreadShell,
                        section: SidebarSection,
                      ) => {
                        const threadKey = scopedThreadKey(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        return (
                          <SortableThreadRow
                            key={threadKey}
                            id={threadKey}
                            contextDrag={isContextDrag}
                            environmentId={thread.environmentId}
                            disabled={
                              renamingThreadKey === threadKey ||
                              section === "working" ||
                              !draggableThreadKeys.has(threadKey) ||
                              optimisticDrop !== null
                            }
                          >
                            {(bag) => renderThreadRowInner(thread, section, bag)}
                          </SortableThreadRow>
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
