import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { selectRecentArchivedThreads } from "@t3tools/client-runtime/state/threads";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { LegendList } from "@legendapp/list/react-native";
import type { MenuAction } from "@react-native-menu/menu";
import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SearchBarCommands } from "react-native-screens";

import { AppText as Text } from "../../components/AppText";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useProjects, useThreadShells } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";
import {
  mergePendingArchivedThreads,
  useThreadLifecyclePresentation,
} from "../../state/thread-lifecycle-outbox";
import { useThreadListV2State } from "./use-thread-list-v2-enabled";
import {
  useAlwaysShowPinnedInAttention,
  useArchivedSectionVisibleCount,
  useOlderSectionSettings,
  useSortActiveByLatestUserMessage,
  useThreadShelfExpansion,
} from "../../state/use-mobile-preferences";
import { useRecentArchivedThreadSnapshots } from "../archive/useArchivedThreadSnapshots";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useThreadAttentionFilter } from "./use-thread-attention-filter";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import {
  hasActiveHomeListFilters,
  hasCustomHomeListOptions,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
  useHomeListOptions,
} from "../home/home-list-options";
import { buildHomeListFilterMenu } from "../home/home-list-filter-menu";
import { useHomeModelFilterOptions } from "../home/use-home-model-filter-options";
import {
  buildHomeListLayout,
  DEFAULT_GROUP_DISPLAY_STATE,
  EMPTY_HOME_LIST_LAYOUT,
  homeListItemsAreEqual,
  nextGroupDisplayState,
  type HomeGroupDisplayAction,
  type HomeGroupDisplayState,
  type HomeListItem,
} from "../home/homeListItems";
import { buildHomeProjectScopes, buildHomeThreadGroups } from "../home/homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { useArchivedThreadListActions, useThreadListActions } from "../home/useThreadListActions";
import {
  getConnectionAwareBrandHeaderOptions,
  WorkspaceConnectionTitle,
} from "../home/WorkspaceConnectionTitle";
import { SidebarHeaderActions } from "./sidebar-header-actions";
import { SidebarFilterButton } from "./sidebar-filter-button";
import { createSidebarHeaderItems } from "./sidebar-native-header-items";
import { SidebarNavigationShell } from "./sidebar-navigation-shell";
import {
  PendingTaskListRow,
  ThreadListGroupHeader,
  ThreadListRow,
  ThreadListShowMoreRow,
} from "./thread-list-items";
import {
  ThreadListV2PendingRow,
  ThreadListV2PinnedDivider,
  ThreadListV2PinnedShelfHeader,
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2SnoozedShelfHeader,
} from "./thread-list-v2-items";
import { ThreadListV2OlderShelfHeader } from "./thread-list-v2-older-shelf";
import { resolveThreadProviderDriver } from "./thread-provider";
import { pendingTaskAttentionKey } from "./threadAttention";
import { useProjectAccentColors } from "../../state/use-project-accent-colors";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2ListItem,
} from "./threadListV2";
import { RecentArchivedThreadSection } from "./RecentArchivedThreadSection";

/** The sidebar list serves both lists: v1 grouped items or, when the Thread
    List v2 beta is on, flat v2 rows with queued tasks spliced in, and a settled
    "Show more" pager. */
type SidebarListItem =
  | HomeListItem
  | ThreadListV2ListItem
  | { readonly type: "v2-show-more"; readonly key: string; readonly hiddenCount: number };

const SIDEBAR_STICKY_HEADER_HEIGHT = 106;

interface ThreadNavigationSidebarProps {
  readonly width: number;
  readonly visible: boolean;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onOpenArchivedThreads: () => void;
  readonly onOpenEnvironmentSettings: () => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onSelectedThreadRemoved: () => void;
  readonly onRequestVisibility: () => void;
  readonly searchQuery: string;
}

/**
 * iPad/large-width sidebar column.
 *
 * On iOS the pane is hosted inside its own navigation-inert single-screen
 * native stack (SidebarNavigationShell) so the header is a real
 * UINavigationBar: large title, native bar-button items, and a
 * UISearchController search field — the same chrome a UISplitViewController
 * column gets. Other platforms keep the custom header chrome.
 */
export function ThreadNavigationSidebar(props: ThreadNavigationSidebarProps) {
  if (Platform.OS !== "ios") {
    return <ThreadNavigationSidebarPane {...props} nativeChrome={false} />;
  }
  return <NativeSidebarContainer {...props} />;
}

function NativeSidebarContainer(props: ThreadNavigationSidebarProps) {
  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1 border-border bg-drawer"
      style={{ borderRightWidth: StyleSheet.hairlineWidth, width: props.width }}
    >
      <SidebarNavigationShell>
        <ThreadNavigationSidebarPane {...props} nativeChrome />
      </SidebarNavigationShell>
    </View>
  );
}

function ThreadNavigationSidebarPane(
  props: ThreadNavigationSidebarProps & { readonly nativeChrome: boolean },
) {
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const canonicalThreads = useThreadShells();
  const threadListV2 = useThreadListV2State();
  const threadLifecyclePresentation = useThreadLifecyclePresentation(canonicalThreads);
  const threads = threadListV2.enabled
    ? threadLifecyclePresentation.activeThreads
    : canonicalThreads;
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const searchInputRef = useRef<TextInput>(null);
  const searchBarRef = useRef<SearchBarCommands>(null);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const sidebarScrollGesture = useMemo(() => Gesture.Native(), []);
  const threadListV2Enabled = threadListV2.enabled;
  const {
    archiveThread,
    forkThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    movePinnedThread,
    regenerateThreadTitle,
  } = useThreadListActions({
    offlineArchiveEnabled: threadListV2.archiveQueueEnabled,
    selectedThreadKey: props.selectedThreadKey,
    onSelectedThreadRemoved: props.onSelectedThreadRemoved,
  });
  const { unarchiveThread, confirmDeleteThread: confirmDeleteArchivedThread } =
    useArchivedThreadListActions();
  const archivedSectionVisibleCount = useArchivedSectionVisibleCount();
  const alwaysShowPinnedInAttention = useAlwaysShowPinnedInAttention();
  const sortActiveByLatestUserMessage = useSortActiveByLatestUserMessage();
  const olderSection = useOlderSectionSettings();
  const { expanded: olderShelfExpanded, toggle: toggleOlderShelf } =
    useThreadShelfExpansion("older");
  const { expanded: archivedShelfExpanded, toggle: toggleArchivedShelf } =
    useThreadShelfExpansion("archived");
  const pendingTasks = usePendingNewTasks();
  const pendingTaskKeys = useMemo(
    () =>
      pendingTasks.map((task) =>
        pendingTaskAttentionKey({
          environmentId: task.message.environmentId,
          messageId: task.message.messageId,
        }),
      ),
    [pendingTasks],
  );
  const attentionFilter = useThreadAttentionFilter(threads, pendingTaskKeys);
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(
    () =>
      Object.values(savedConnectionsById)
        .map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [savedConnectionsById],
  );
  const archivedEnvironmentIds = useMemo(
    () => (threadListV2Enabled ? environments.map((environment) => environment.environmentId) : []),
    [environments, threadListV2Enabled],
  );
  const { snapshots: archivedSnapshots } = useRecentArchivedThreadSnapshots(
    archivedEnvironmentIds,
    archivedSectionVisibleCount,
  );
  const recentArchive = useMemo(
    () =>
      selectRecentArchivedThreads(
        archivedSnapshots,
        archivedSectionVisibleCount,
        props.selectedThreadKey,
      ),
    [archivedSectionVisibleCount, archivedSnapshots, props.selectedThreadKey],
  );
  const archivedEnvironmentLabels = useMemo(
    () =>
      Object.fromEntries(
        environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [environments],
  );
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  // The same configs name the models behind the filter menu, each row's
  // provider mark, and (below) the settlement/snooze capabilities.
  const { modelFilterOptions, availableModels, serverConfigs } = useHomeModelFilterOptions(threads);
  const {
    options,
    setSelectedEnvironmentId,
    setSelectedModel,
    setProjectSortOrder,
    setThreadSortOrder,
  } = useHomeListOptions(availableEnvironmentIds, availableModels);
  const searchEnvironmentIds = useMemo(
    () =>
      options.selectedEnvironmentId === null
        ? workspaceEnvironments
            .filter((environment) => environment.connectionState === "connected")
            .map((environment) => environment.environmentId)
        : workspaceEnvironments.some(
              (environment) =>
                environment.environmentId === options.selectedEnvironmentId &&
                environment.connectionState === "connected",
            )
          ? [options.selectedEnvironmentId]
          : [],
    [options.selectedEnvironmentId, workspaceEnvironments],
  );
  const threadSearch = useThreadSearch(searchEnvironmentIds, props.searchQuery);
  const threadSearchMatchByKey = useMemo(() => {
    const matches = new Map<string, EnvironmentThreadSearchMatch>();
    for (const match of threadSearch.matches) {
      if (match.source === "user" || match.source === "assistant") {
        matches.set(threadSearchMatchKey(match), match);
      }
    }
    return matches;
  }, [threadSearch.matches]);
  const matchedThreadKeys = useMemo(
    () => new Set(threadSearch.matches.map(threadSearchMatchKey)),
    [threadSearch.matches],
  );
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const selectedModelLabel =
    modelFilterOptions.find((model) => model.key === options.selectedModel)?.label ?? null;
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: options.selectedEnvironmentId,
        projectGroupingMode: options.projectGroupingMode,
      }),
    [options.projectGroupingMode, options.selectedEnvironmentId, projects],
  );
  const projectFilterOptions = useMemo(
    () =>
      projectScopes.map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [projectScopes],
  );
  const projectTitleByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [projectScopes],
  );
  // Accents are shared server settings, so the iPad sidebar tints rows with
  // the same color the desktop sidebar and the Home list use.
  const resolveProjectAccentColor = useProjectAccentColors();
  const projectAccentByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) => {
          const accentColor = resolveProjectAccentColor(scope.projects);
          return accentColor === null
            ? []
            : scope.projectRefs.map(
                (projectRef) =>
                  [
                    scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                    accentColor,
                  ] as const,
              );
        }),
      ),
    [projectScopes, resolveProjectAccentColor],
  );
  const selectedProjectScope = useMemo(
    () =>
      selectedProjectKey === null
        ? null
        : (projectScopes.find((scope) => scope.key === selectedProjectKey) ?? null),
    [projectScopes, selectedProjectKey],
  );
  const archiveShelfVisible =
    props.searchQuery.trim().length === 0 &&
    !attentionFilter.enabled &&
    options.selectedEnvironmentId === null &&
    options.selectedModel === null &&
    selectedProjectScope === null;
  const displayedServerArchive = archiveShelfVisible
    ? recentArchive
    : { threads: [], totalCount: 0 };
  const displayedRecentArchive = useMemo(
    () =>
      mergePendingArchivedThreads(
        displayedServerArchive,
        archiveShelfVisible ? threadLifecyclePresentation.pendingArchivedThreads : [],
        archivedSectionVisibleCount,
        props.selectedThreadKey,
      ),
    [
      archiveShelfVisible,
      archivedSectionVisibleCount,
      displayedServerArchive,
      props.selectedThreadKey,
      threadLifecyclePresentation.pendingArchivedThreads,
    ],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);
  const selectedProjectRefs = useMemo(
    () =>
      selectedProjectScope === null
        ? null
        : new Set(
            selectedProjectScope.projectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [selectedProjectScope],
  );
  const scopedProjects = useMemo(
    () =>
      threadListV2Enabled
        ? []
        : selectedProjectRefs === null
          ? projects
          : projects.filter((project) =>
              selectedProjectRefs.has(scopedProjectKey(project.environmentId, project.id)),
            ),
    [threadListV2Enabled, projects, selectedProjectRefs],
  );
  const scopedThreads = useMemo(
    () =>
      threadListV2Enabled
        ? []
        : selectedProjectRefs === null
          ? threads
          : threads.filter((thread) =>
              selectedProjectRefs.has(scopedProjectKey(thread.environmentId, thread.projectId)),
            ),
    [threadListV2Enabled, selectedProjectRefs, threads],
  );
  const scopedPendingTasks = useMemo(
    () =>
      threadListV2Enabled
        ? []
        : selectedProjectRefs === null
          ? pendingTasks
          : pendingTasks.filter((pendingTask) =>
              selectedProjectRefs.has(
                scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
              ),
            ),
    [threadListV2Enabled, pendingTasks, selectedProjectRefs],
  );
  const groups = useMemo(
    () =>
      threadListV2Enabled
        ? []
        : buildHomeThreadGroups({
            projects: scopedProjects,
            threads: scopedThreads,
            pendingTasks: scopedPendingTasks,
            environmentId: options.selectedEnvironmentId,
            model: options.selectedModel,
            searchQuery: props.searchQuery,
            matchedThreadKeys,
            projectSortOrder: options.projectSortOrder,
            threadSortOrder: options.threadSortOrder,
            projectGroupingMode: options.projectGroupingMode,
          }),
    [
      threadListV2Enabled,
      matchedThreadKeys,
      options,
      props.searchQuery,
      scopedPendingTasks,
      scopedProjects,
      scopedThreads,
    ],
  );
  const [groupDisplayStates, setGroupDisplayStates] = useState<
    ReadonlyMap<string, HomeGroupDisplayState>
  >(() => new Map());
  const updateGroupDisplay = useCallback((key: string, action: HomeGroupDisplayAction) => {
    setGroupDisplayStates((previous) => {
      const next = new Map(previous);
      next.set(
        key,
        nextGroupDisplayState(previous.get(key) ?? DEFAULT_GROUP_DISPLAY_STATE, action),
      );
      return next;
    });
  }, []);
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const projectAccentByGroupKey = useMemo(
    () =>
      new Map(
        groups.flatMap((group) => {
          const accentColor = resolveProjectAccentColor(group.projects);
          return accentColor === null ? [] : [[group.key, accentColor] as const];
        }),
      ),
    [groups, resolveProjectAccentColor],
  );
  const listLayout = useMemo(
    () =>
      threadListV2Enabled
        ? EMPTY_HOME_LIST_LAYOUT
        : buildHomeListLayout({
            groups,
            displayStates: groupDisplayStates,
            showAllThreads: hasSearchQuery,
          }),
    [threadListV2Enabled, groups, groupDisplayStates, hasSearchQuery],
  );
  const projectCwdByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project.workspaceRoot);
    }
    return map;
  }, [projects]);
  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [projects]);

  // Thread List v2 (beta) support — same model as the compact Home list
  // (HomeScreen.tsx): flat creation-order card block + settled recency tail.
  // The settled tail renders in pages; expansion resets when the filter
  // context changes so environment/search flips never inherit a deep page.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  // JSON, not a colon join: model slugs, project keys, and searches all admit
  // colons, so a delimited string can collide across different filter states
  // and silently skip the reset.
  const settledResetKey = JSON.stringify([
    options.selectedEnvironmentId,
    selectedProjectKey,
    options.selectedModel,
    props.searchQuery.trim(),
    attentionFilter.enabled,
  ]);
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT),
    [],
  );
  const {
    expanded: snoozedShelfExpanded,
    loaded: shelfPreferencesLoaded,
    toggle: toggleSnoozedShelf,
  } = useThreadShelfExpansion("snoozed");
  const { expanded: settledShelfExpanded, toggle: toggleSettledShelf } =
    useThreadShelfExpansion("settled");
  const { expanded: pinnedShelfExpanded, toggle: togglePinnedShelf } =
    useThreadShelfExpansion("pinned");
  // Queued-start, snooze, and Older helpers need a clock while the pane stays open.
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useEffect(() => {
    if (!threadListV2Enabled) return;
    // Refresh immediately because the mount-time value can be hours old.
    setNowMinute(new Date().toISOString().slice(0, 16));
    const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
    return () => clearInterval(id);
  }, [threadListV2Enabled]);
  const settlementEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSettlement === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const snoozeEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSnooze === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const pinningEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinning === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const pinReorderEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinReorder === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const titleRegenerationEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadTitleRegeneration === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const machineByEnvironmentId = useMemo(
    () =>
      new Map(
        [...serverConfigs].map(
          ([environmentId, config]) =>
            [environmentId, resolveEnvironmentMachineKind(config)] as const,
        ),
      ),
    [serverConfigs],
  );
  // Canonical arranged pinned order for Move up/down flags — computed from
  // all shells so search/scope filtering never disables a valid move.
  const arrangedPinnedKeys = useMemo(() => {
    const pinned = sortPinnedThreadsByOrderKey(
      threads.filter(
        (thread) =>
          thread.pinnedAt != null &&
          thread.archivedAt === null &&
          pinReorderEnvironmentIds.has(thread.environmentId),
      ),
    );
    return pinned.map((thread) => `${thread.environmentId}:${thread.id}`);
  }, [pinReorderEnvironmentIds, threads]);
  const threadListV2Layout = useMemo(() => {
    if (!threadListV2Enabled)
      return {
        items: [],
        hiddenSettledCount: 0,
        pinnedCount: 0,
        pinnedShelfHeaderVisible: false,
        olderCount: 0,
        olderShelfHeaderIndex: null,
        snoozedCount: 0,
        snoozedShelfHeaderIndex: null,
        settledCount: 0,
        settledShelfHeaderIndex: null,
        nextSnoozeWakeAt: null,
      };
    return buildThreadListV2Items({
      threads: threads.filter((thread) => thread.archivedAt === null),
      attentionMemberThreadKeys: attentionFilter.memberThreadKeys,
      alwaysShowPinnedInAttention,
      sortActiveByLatestUserMessage,
      environmentId: options.selectedEnvironmentId,
      model: options.selectedModel,
      projectRefs: selectedProjectScope === null ? null : selectedProjectScope.projectRefs,
      searchQuery: props.searchQuery,
      matchedThreadKeys,
      olderSectionEnabled: olderSection.enabled,
      olderSectionAfterDays: olderSection.afterDays,
      olderShelfExpanded,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      settledLimit: settledVisibleCount,
      now: new Date().toISOString(),
      snoozedShelfExpanded,
      settledShelfExpanded,
      pinnedShelfExpanded,
      selectedThreadKey: props.selectedThreadKey ?? null,
    });
  }, [
    alwaysShowPinnedInAttention,
    sortActiveByLatestUserMessage,
    attentionFilter.memberThreadKeys,
    olderSection.enabled,
    olderSection.afterDays,
    olderShelfExpanded,
    nowMinute,
    snoozeWakeTick,
    snoozedShelfExpanded,
    settledShelfExpanded,
    pinnedShelfExpanded,
    props.selectedThreadKey,
    options.selectedEnvironmentId,
    options.selectedModel,
    props.searchQuery,
    matchedThreadKeys,
    settledVisibleCount,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    threadListV2Enabled,
    threads,
    selectedProjectScope,
  ]);
  // Re-partition the moment the earliest snooze expires (clamped to the
  // signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
  const nextSnoozeWakeAt = threadListV2Layout.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire (wake beyond the 32-bit setTimeout
    // range) the boundary string is identical and the chain would die.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);
  const listItems = useMemo<readonly SidebarListItem[]>(() => {
    if (!threadListV2Enabled) return listLayout.items;
    // Queued offline tasks are not thread shells, so the v2 item builder
    // never sees them; the shared splice puts them below the active block
    // (mirrors the compact Home v2 list) where they stay visible and
    // deletable while their environment is offline. Queued work is unresolved,
    // so snapshots include current tasks and admit tasks queued afterward.
    const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase();
    const v2PendingTasks = pendingTasks.filter(
      (pendingTask) =>
        (attentionFilter.memberPendingTaskKeys === null ||
          attentionFilter.memberPendingTaskKeys.has(
            pendingTaskAttentionKey({
              environmentId: pendingTask.message.environmentId,
              messageId: pendingTask.message.messageId,
            }),
          )) &&
        (options.selectedEnvironmentId === null ||
          pendingTask.message.environmentId === options.selectedEnvironmentId) &&
        (options.selectedModel === null ||
          pendingTask.message.modelSelection?.model === options.selectedModel) &&
        (selectedProjectRefs === null ||
          selectedProjectRefs.has(
            scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
          )) &&
        (v2SearchQuery.length === 0 ||
          pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery)),
    );
    const items: SidebarListItem[] = buildThreadListV2ListItems({
      items: threadListV2Layout.items,
      pendingTasks: v2PendingTasks,
      pinnedCount: threadListV2Layout.pinnedCount,
      pinnedShelfExpanded,
      pinnedShelfHeaderVisible: threadListV2Layout.pinnedShelfHeaderVisible,
      olderCount: threadListV2Layout.olderCount,
      olderShelfExpanded,
      olderShelfHeaderIndex: threadListV2Layout.olderShelfHeaderIndex,
      snoozedCount: threadListV2Layout.snoozedCount,
      snoozedShelfExpanded,
      snoozedShelfHeaderIndex: threadListV2Layout.snoozedShelfHeaderIndex,
      settledCount: threadListV2Layout.settledCount,
      settledShelfExpanded,
      settledShelfHeaderIndex: threadListV2Layout.settledShelfHeaderIndex,
      snoozeLabelNow: `${nowMinute}:00.000Z`,
    });
    if (settledShelfExpanded && threadListV2Layout.hiddenSettledCount > 0) {
      items.push({
        type: "v2-show-more",
        key: "v2-show-more",
        hiddenCount: threadListV2Layout.hiddenSettledCount,
      });
    }
    return items;
  }, [
    listLayout.items,
    attentionFilter.memberPendingTaskKeys,
    nowMinute,
    options.selectedEnvironmentId,
    options.selectedModel,
    pendingTasks,
    props.searchQuery,
    selectedProjectRefs,
    olderShelfExpanded,
    pinnedShelfExpanded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    threadListV2Enabled,
    threadListV2Layout,
  ]);
  const listMenuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            subtitle: "Show threads from every environment",
            state: options.selectedEnvironmentId === null ? "on" : "off",
          },
          ...environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state:
              options.selectedEnvironmentId === environment.environmentId
                ? ("on" as const)
                : ("off" as const),
          })),
        ],
      },
      ...(projectFilterOptions.length === 0
        ? []
        : ([
            {
              id: "project",
              title: "Project",
              subactions: [
                {
                  id: "project:all",
                  title: "All projects",
                  subtitle: "Show threads from every project",
                  state: selectedProjectKey === null ? "on" : "off",
                },
                ...projectFilterOptions.map((project) => ({
                  id: `project:${project.key}`,
                  title: project.label,
                  state: selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
                })),
              ],
            },
          ] satisfies MenuAction[])),
      // Only once it can discriminate (same rule as the shared iOS builder).
      ...(modelFilterOptions.length < 2
        ? []
        : ([
            {
              id: "model",
              title: "Model",
              subactions: [
                {
                  // "clear", not "all": a model slug could legitimately be
                  // "all" and would then be unselectable.
                  id: "model:clear",
                  title: "All models",
                  subtitle: "Show threads on every model",
                  state: options.selectedModel === null ? "on" : "off",
                },
                ...modelFilterOptions.map((model) => ({
                  id: `model:${model.key}`,
                  title: model.label,
                  state: options.selectedModel === model.key ? ("on" as const) : ("off" as const),
                })),
              ],
            },
          ] satisfies MenuAction[])),
      // v2 lays the list out in fixed creation order — offering sort/group
      // controls it silently ignores would be a lie. Environment still
      // scopes the v2 partition, so it stays.
      ...(threadListV2Enabled
        ? []
        : ([
            {
              id: "project-sort",
              title: "Sort projects",
              subactions: PROJECT_SORT_OPTIONS.map((option) => ({
                id: `project-sort:${option.value}`,
                title: option.label,
                state: options.projectSortOrder === option.value ? "on" : "off",
              })),
            },
            {
              id: "thread-sort",
              title: "Sort threads",
              subactions: THREAD_SORT_OPTIONS.map((option) => ({
                id: `thread-sort:${option.value}`,
                title: option.label,
                state: options.threadSortOrder === option.value ? "on" : "off",
              })),
            },
          ] satisfies MenuAction[])),
    ],
    [
      environments,
      modelFilterOptions,
      options,
      projectFilterOptions,
      selectedProjectKey,
      threadListV2Enabled,
    ],
  );
  const handleListMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      const event = nativeEvent.event;
      if (event === "environment:all") {
        setSelectedEnvironmentId(null);
        return;
      }
      if (event.startsWith("environment:")) {
        const environment = environments.find(
          (candidate) => String(candidate.environmentId) === event.slice("environment:".length),
        );
        if (environment) setSelectedEnvironmentId(environment.environmentId);
        return;
      }
      if (event === "project:all") {
        setSelectedProjectKey(null);
        return;
      }
      if (event.startsWith("project:")) {
        const projectKey = event.slice("project:".length);
        if (projectFilterOptions.some((project) => project.key === projectKey)) {
          setSelectedProjectKey(projectKey);
        }
        return;
      }
      if (event === "model:clear") {
        setSelectedModel(null);
        return;
      }
      if (event.startsWith("model:")) {
        const modelKey = event.slice("model:".length);
        if (modelFilterOptions.some((model) => model.key === modelKey)) {
          setSelectedModel(modelKey);
        }
        return;
      }
      const projectSort = PROJECT_SORT_OPTIONS.find(
        (option) => `project-sort:${option.value}` === event,
      );
      if (projectSort) {
        setProjectSortOrder(projectSort.value);
        return;
      }
      const threadSort = THREAD_SORT_OPTIONS.find(
        (option) => `thread-sort:${option.value}` === event,
      );
      if (threadSort) {
        setThreadSortOrder(threadSort.value);
        return;
      }
    },
    [
      environments,
      modelFilterOptions,
      projectFilterOptions,
      setProjectSortOrder,
      setSelectedEnvironmentId,
      setSelectedModel,
      setThreadSortOrder,
    ],
  );

  // Native header items cannot consume a className; the attention filter's
  // active tint crosses that boundary as a raw color value.
  const primaryColor = useUniwindTheme()["--color-primary"];
  const [measuredHeaderHeight, setMeasuredHeaderHeight] = useState<number | null>(null);
  // The sticky header (title row, search field, optional connection status)
  // is measured so the list inset always matches its real height — no
  // hardcoded per-variant constants.
  const stickyHeaderHeight = measuredHeaderHeight ?? insets.top + SIDEBAR_STICKY_HEADER_HEIGHT;
  const topListInset = stickyHeaderHeight + 6;
  const handleStickyHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setMeasuredHeaderHeight((current) => (current === nextHeight ? current : nextHeight));
  }, []);
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);
  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);
  const handleSelectThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      props.onSelectThread(thread);
      openSwipeableRef.current?.close();
    },
    [props.onSelectThread],
  );
  const archivedSectionFooter =
    threadListV2Enabled && displayedRecentArchive.threads.length > 0 ? (
      <RecentArchivedThreadSection
        environmentLabels={archivedEnvironmentLabels}
        projects={projects}
        threads={displayedRecentArchive.threads}
        totalCount={displayedRecentArchive.totalCount}
        expanded={archivedShelfExpanded}
        onToggle={toggleArchivedShelf}
        onDelete={confirmDeleteArchivedThread}
        onOpen={handleSelectThread}
        onOpenAll={props.onOpenArchivedThreads}
        onUnarchive={unarchiveThread}
        pane="sidebar"
        pendingThreadKeys={threadLifecyclePresentation.pendingArchivedThreadKeys}
        selectedThreadKey={props.selectedThreadKey}
      />
    ) : null;
  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScrollBeginDrag: handleScrollBeginDrag,
  });
  // Project shells load after the first rows draw, so the maps they feed have
  // to bust the recycler's memoization — otherwise a row keeps the blank
  // favicon and fallback title it was first rendered with.
  const listExtraData = useMemo(
    () => ({
      selectedThreadKey: props.selectedThreadKey ?? "",
      projectAccentByGroupKey,
      projectAccentByProjectKey,
      projectByKey,
      projectCwdByKey,
      projectTitleByProjectKey,
      savedConnectionsById,
      serverConfigs,
      snoozePresetMinute: nowMinute,
      threadSearchMatchByKey,
    }),
    [
      props.selectedThreadKey,
      projectAccentByGroupKey,
      projectAccentByProjectKey,
      projectByKey,
      projectCwdByKey,
      projectTitleByProjectKey,
      savedConnectionsById,
      serverConfigs,
      nowMinute,
      threadSearchMatchByKey,
    ],
  );
  const sidebarItemsAreEqual = useCallback(
    (previous: SidebarListItem, item: SidebarListItem): boolean => {
      if (previous.type === "v2-thread" && item.type === "v2-thread") {
        return (
          previous.key === item.key &&
          previous.item.thread === item.item.thread &&
          previous.item.variant === item.item.variant &&
          previous.item.snoozed === item.item.snoozed &&
          previous.item.pinned === item.item.pinned &&
          previous.snoozeWakeLabelText === item.snoozeWakeLabelText
        );
      }
      if (previous.type === "v2-show-more" && item.type === "v2-show-more") {
        return previous.hiddenCount === item.hiddenCount;
      }
      if (previous.type === "v2-pending" && item.type === "v2-pending") {
        return (
          previous.pendingTask === item.pendingTask &&
          previous.showPendingDivider === item.showPendingDivider
        );
      }
      // Static rule: identical whenever both sides are the divider.
      if (previous.type === "v2-pinned-divider" || item.type === "v2-pinned-divider") {
        return previous.type === item.type;
      }
      if (previous.type === "v2-pinned-shelf" && item.type === "v2-pinned-shelf") {
        return previous.count === item.count && previous.expanded === item.expanded;
      }
      if (previous.type === "v2-older-shelf" && item.type === "v2-older-shelf") {
        return previous.count === item.count && previous.expanded === item.expanded;
      }
      if (previous.type === "v2-snoozed-shelf" && item.type === "v2-snoozed-shelf") {
        return previous.count === item.count && previous.expanded === item.expanded;
      }
      if (previous.type === "v2-settled-shelf" && item.type === "v2-settled-shelf") {
        return previous.count === item.count && previous.expanded === item.expanded;
      }
      if (
        previous.type === "v2-thread" ||
        previous.type === "v2-show-more" ||
        previous.type === "v2-pending" ||
        previous.type === "v2-pinned-shelf" ||
        previous.type === "v2-older-shelf" ||
        previous.type === "v2-snoozed-shelf" ||
        previous.type === "v2-settled-shelf" ||
        item.type === "v2-thread" ||
        item.type === "v2-show-more" ||
        item.type === "v2-pending" ||
        item.type === "v2-pinned-shelf" ||
        item.type === "v2-older-shelf" ||
        item.type === "v2-snoozed-shelf" ||
        item.type === "v2-settled-shelf"
      ) {
        return false;
      }
      return homeListItemsAreEqual(previous, item);
    },
    [],
  );
  const focusSearch = useCallback(() => {
    const focus = () => {
      if (props.nativeChrome) {
        searchBarRef.current?.focus();
        return;
      }
      searchInputRef.current?.focus();
    };
    if (!props.visible) {
      props.onRequestVisibility();
      setTimeout(focus, 240);
    } else {
      focus();
    }
    return true;
  }, [props.nativeChrome, props.onRequestVisibility, props.visible]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const renderListItem = useCallback(
    ({ item, index }: { readonly item: SidebarListItem; readonly index: number }) => {
      const nextItem = listItems[index + 1];
      const showTrailingDivider =
        nextItem?.type === "v2-thread" ||
        (nextItem?.type === "v2-pending" && !nextItem.showPendingDivider);
      switch (item.type) {
        case "v2-pending": {
          const pendingScopeKey = scopedProjectKey(
            item.pendingTask.message.environmentId,
            item.pendingTask.creation.projectId,
          );
          return (
            <ThreadListV2PendingRow
              pendingTask={item.pendingTask}
              project={projectByKey.get(pendingScopeKey) ?? null}
              projectTitle={projectTitleByProjectKey.get(pendingScopeKey)}
              projectAccentColor={projectAccentByProjectKey.get(pendingScopeKey) ?? null}
              environmentLabel={
                Object.keys(savedConnectionsById).length > 1
                  ? (savedConnectionsById[item.pendingTask.message.environmentId]
                      ?.environmentLabel ?? null)
                  : null
              }
              environmentMachine={machineByEnvironmentId.get(
                item.pendingTask.message.environmentId,
              )}
              pane="sidebar"
              showPendingDivider={item.showPendingDivider}
              showTrailingDivider={showTrailingDivider}
              onSelectPendingTask={openPendingTask}
              onDeletePendingTask={confirmDeletePendingTask}
            />
          );
        }
        case "v2-thread": {
          const thread = item.item.thread;
          const scopeKey = scopedProjectKey(thread.environmentId, thread.projectId);
          return (
            <ThreadListV2Row
              thread={thread}
              variant={item.item.variant}
              snoozed={item.item.snoozed}
              pinned={item.item.pinned}
              snoozePresetMinute={nowMinute}
              snoozeWakeLabelText={item.snoozeWakeLabelText}
              showTrailingDivider={showTrailingDivider}
              project={projectByKey.get(scopeKey) ?? null}
              projectTitle={projectTitleByProjectKey.get(scopeKey)}
              projectAccentColor={projectAccentByProjectKey.get(scopeKey) ?? null}
              providerDriver={resolveThreadProviderDriver(serverConfigs, thread)}
              environmentLabel={
                Object.keys(savedConnectionsById).length > 1
                  ? (savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
                  : null
              }
              environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
              searchMatch={threadSearchMatchByKey.get(
                threadSearchMatchKey({
                  environmentId: thread.environmentId,
                  threadId: thread.id,
                }),
              )}
              searchQuery={props.searchQuery}
              pane="sidebar"
              selected={
                scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
              }
              fullSwipeWidth={props.width - 20}
              onSelectThread={handleSelectThread}
              onDeleteThread={confirmDeleteThread}
              onArchiveThread={archiveThread}
              onForkThread={forkThread}
              onRegenerateThreadTitle={regenerateThreadTitle}
              titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
              settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
              onSettleThread={settleThread}
              snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
              pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
              pinReorderSupported={pinReorderEnvironmentIds.has(thread.environmentId)}
              canMovePinnedUp={
                arrangedPinnedKeys.indexOf(`${thread.environmentId}:${thread.id}`) > 0
              }
              canMovePinnedDown={(() => {
                const index = arrangedPinnedKeys.indexOf(`${thread.environmentId}:${thread.id}`);
                return index !== -1 && index < arrangedPinnedKeys.length - 1;
              })()}
              onSnoozeThread={snoozeThread}
              onUnsnoozeThread={unsnoozeThread}
              onUnsettleThread={unsettleThread}
              onPinThread={pinThread}
              onUnpinThread={unpinThread}
              onMovePinnedThread={movePinnedThread}
              projectCwd={projectCwdByKey.get(scopeKey) ?? null}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
              simultaneousSwipeGesture={sidebarScrollGesture}
            />
          );
        }
        case "v2-pinned-shelf":
          return (
            <ThreadListV2PinnedShelfHeader
              count={item.count}
              expanded={item.expanded}
              onToggle={togglePinnedShelf}
              pane="sidebar"
            />
          );
        case "v2-pinned-divider":
          return <ThreadListV2PinnedDivider pane="sidebar" />;
        case "v2-older-shelf":
          return (
            <ThreadListV2OlderShelfHeader
              count={item.count}
              expanded={item.expanded}
              onToggle={toggleOlderShelf}
              pane="sidebar"
            />
          );
        case "v2-snoozed-shelf":
          return (
            <ThreadListV2SnoozedShelfHeader
              count={item.count}
              disabled={!shelfPreferencesLoaded}
              expanded={item.expanded}
              onToggle={toggleSnoozedShelf}
              pane="sidebar"
            />
          );
        case "v2-settled-shelf":
          return (
            <ThreadListV2SettledShelfHeader
              count={item.count}
              disabled={!shelfPreferencesLoaded}
              expanded={item.expanded}
              onToggle={toggleSettledShelf}
              pane="sidebar"
            />
          );
        case "v2-show-more":
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show ${Math.min(item.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`}
              onPress={showMoreSettled}
              className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">
                Show more ({item.hiddenCount} settled hidden)
              </Text>
            </Pressable>
          );
        case "header":
          return (
            <ThreadListGroupHeader
              variant="sidebar"
              accentColor={projectAccentByGroupKey.get(item.group.key) ?? null}
              collapsed={item.collapsed}
              isFirst={item.isFirst}
              groupKey={item.group.key}
              onGroupAction={updateGroupDisplay}
              // Same gating as the compact Home list: aggregated groups have no
              // single target project, and pending-project groups hold a
              // placeholder shell rather than a real project.
              newThreadTarget={item.group.newThreadTarget}
              onNewThread={props.onNewThreadInProject}
              project={item.group.representative}
              threadCount={item.group.threads.length + item.group.pendingTasks.length}
              title={item.group.title}
            />
          );
        case "pending-task":
          return (
            <PendingTaskListRow
              variant="sidebar"
              pendingTask={item.pendingTask}
              environmentLabel={
                savedConnectionsById[item.pendingTask.message.environmentId]?.environmentLabel ??
                null
              }
              environmentMachine={machineByEnvironmentId.get(
                item.pendingTask.message.environmentId,
              )}
              isLast={item.isLast}
              onSelectPendingTask={openPendingTask}
              onDeletePendingTask={confirmDeletePendingTask}
            />
          );
        case "thread": {
          const thread = item.thread;
          return (
            <ThreadListRow
              variant="sidebar"
              thread={thread}
              environmentLabel={
                savedConnectionsById[thread.environmentId]?.environmentLabel ?? null
              }
              providerDriver={resolveThreadProviderDriver(serverConfigs, thread)}
              environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
              projectCwd={
                projectCwdByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ??
                null
              }
              isLast={item.isLast}
              searchMatch={threadSearchMatchByKey.get(
                threadSearchMatchKey({
                  environmentId: thread.environmentId,
                  threadId: thread.id,
                }),
              )}
              searchQuery={props.searchQuery}
              selected={
                scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
              }
              fullSwipeWidth={props.width - 20}
              onArchiveThread={archiveThread}
              onDeleteThread={confirmDeleteThread}
              onRegenerateThreadTitle={regenerateThreadTitle}
              titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
              onSelectThread={handleSelectThread}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
              simultaneousSwipeGesture={sidebarScrollGesture}
            />
          );
        }
        case "show-more":
          return (
            <ThreadListShowMoreRow
              variant="sidebar"
              hiddenCount={item.hiddenCount}
              canShowLess={item.canShowLess}
              groupKey={item.groupKey}
              onGroupAction={updateGroupDisplay}
            />
          );
      }
    },
    [
      archiveThread,
      arrangedPinnedKeys,
      confirmDeletePendingTask,
      confirmDeleteThread,
      forkThread,
      handleSelectThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      listItems,
      machineByEnvironmentId,
      movePinnedThread,
      openPendingTask,
      pinReorderEnvironmentIds,
      pinThread,
      pinningEnvironmentIds,
      projectAccentByGroupKey,
      projectAccentByProjectKey,
      projectByKey,
      projectCwdByKey,
      projectTitleByProjectKey,
      regenerateThreadTitle,
      props.onNewThreadInProject,
      props.searchQuery,
      props.selectedThreadKey,
      props.width,
      savedConnectionsById,
      serverConfigs,
      shelfPreferencesLoaded,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      settleThread,
      settlementEnvironmentIds,
      showMoreSettled,
      sidebarScrollGesture,
      snoozeEnvironmentIds,
      snoozeThread,
      nowMinute,
      toggleOlderShelf,
      toggleSettledShelf,
      toggleSnoozedShelf,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
      updateGroupDisplay,
    ],
  );
  // v2 ignores the sort/group options, so only the environment filter can
  // light the "customized" state while the beta is on.
  const filterCustomized = threadListV2Enabled
    ? hasActiveHomeListFilters({ ...options, selectedProjectKey })
    : hasCustomHomeListOptions({ ...options, selectedProjectKey });
  const filterIcon = filterCustomized
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
  const filterMenu = useMemo(
    () =>
      buildHomeListFilterMenu({
        environments,
        projects: projectFilterOptions,
        models: modelFilterOptions,
        selectedEnvironmentId: options.selectedEnvironmentId,
        selectedProjectKey,
        selectedModel: options.selectedModel,
        projectSortOrder: options.projectSortOrder,
        threadSortOrder: options.threadSortOrder,
        onEnvironmentChange: setSelectedEnvironmentId,
        onProjectChange: setSelectedProjectKey,
        onModelChange: setSelectedModel,
        onClearFilters: () => {
          setSelectedEnvironmentId(null);
          setSelectedProjectKey(null);
          setSelectedModel(null);
        },
        onProjectSortOrderChange: setProjectSortOrder,
        onThreadSortOrderChange: setThreadSortOrder,
        listOrganization: !threadListV2Enabled,
      }),
    [
      environments,
      modelFilterOptions,
      options,
      projectFilterOptions,
      selectedProjectKey,
      setProjectSortOrder,
      setSelectedEnvironmentId,
      setSelectedModel,
      setThreadSortOrder,
      threadListV2Enabled,
    ],
  );
  const nativeHeaderItems = useMemo(
    () =>
      createSidebarHeaderItems({
        attentionFilterEnabled: attentionFilter.enabled,
        attentionFilterReady: attentionFilter.ready,
        attentionFilterActiveTintColor: primaryColor,
        showAttentionFilter: threadListV2Enabled,
        filterIcon,
        filterMenu,
        onOpenSettings: props.onOpenSettings,
        onToggleAttentionFilter: attentionFilter.toggle,
      }),
    [
      attentionFilter.enabled,
      attentionFilter.ready,
      attentionFilter.toggle,
      filterIcon,
      filterMenu,
      primaryColor,
      props.onOpenSettings,
      threadListV2Enabled,
    ],
  );
  // Null suppresses the empty row entirely: the archived section below is
  // already showing threads, so "No threads yet" would read as data loss. It
  // only outranks that last fallback — a search or a filter that matches
  // nothing still has to say so, archive or not.
  const listEmptyMessage = catalogState.isLoadingConnections
    ? "Loading threads…"
    : props.searchQuery.trim().length > 0
      ? threadSearch.isPending
        ? "Searching thread messages…"
        : "No matching threads"
      : selectedProjectScope !== null
        ? `No threads in ${selectedProjectScope.title}`
        : // A model pin can empty the list in one tap; "No threads yet"
          // over a filtered inbox reads as data loss.
          options.selectedModel !== null
          ? `No threads on ${selectedModelLabel ?? options.selectedModel}`
          : displayedRecentArchive.threads.length > 0
            ? null
            : "No threads yet";
  const listEmpty =
    !catalogState.isLoadingConnections &&
    props.searchQuery.trim().length === 0 &&
    attentionFilter.enabled ? (
      <View className="items-start gap-3 px-2 py-4">
        <Text className="text-sm text-foreground-muted">No threads need attention</Text>
        <Pressable
          accessibilityLabel="Clear attention filter"
          accessibilityRole="button"
          className="rounded-full bg-primary px-4 py-2 active:opacity-70"
          onPress={attentionFilter.clear}
        >
          <Text className="text-sm font-t3-bold text-primary-foreground">
            Clear attention filter
          </Text>
        </Pressable>
      </View>
    ) : listEmptyMessage === null ? null : (
      <Text className="px-2 py-4 text-sm text-foreground-muted">{listEmptyMessage}</Text>
    );

  if (props.nativeChrome) {
    return (
      <>
        <NativeStackScreenOptions
          optionsVersion={[nativeHeaderItems, props.width]}
          options={{
            // Re-applies the shell's static brand slot with the
            // connection-status swap so reconnects surface in the header
            // instead of shifting the list.
            ...getConnectionAwareBrandHeaderOptions({
              headerWidth: props.width,
              trailingItemCount: nativeHeaderItems.length,
              onOpenEnvironments: props.onOpenEnvironmentSettings,
              fallbackTitleStyle: { fontSize: 18, fontWeight: "800" },
              showThreadSync: true,
            }),
            headerSearchBarOptions: {
              ref: searchBarRef,
              autoCapitalize: "none",
              hideNavigationBar: false,
              // Keep the search bar pinned under the title — UIKit's default
              // hidesSearchBarWhenScrolling collapses it on scroll.
              hideWhenScrolling: false,
              obscureBackground: false,
              placeholder: "Search",
              placement: "stacked",
              onCancelButtonPress: () => {
                props.onSearchQueryChange("");
              },
              onChangeText: (event) => {
                props.onSearchQueryChange(event.nativeEvent.text);
              },
            },
            unstable_headerRightItems: () => nativeHeaderItems,
          }}
        />
        <View className="flex-1">
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              <LegendList
                data={listItems}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={sidebarItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                automaticallyAdjustsScrollIndicatorInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
                contentInsetAdjustmentBehavior={
                  NATIVE_LIQUID_GLASS_SUPPORTED ? "automatic" : "never"
                }
                contentContainerStyle={[
                  styles.threadListContent,
                  {
                    paddingBottom: Math.max(insets.bottom, 16) + 16,
                    paddingTop: 6,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListEmptyComponent={listEmpty}
                ListFooterComponent={archivedSectionFooter}
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
        </View>
      </>
    );
  }

  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1 border-r border-border bg-drawer"
      style={{ width: props.width }}
    >
      <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
        <SwipeableScrollGateProvider enabled={swipeEnabled}>
          <GestureDetector gesture={sidebarScrollGesture}>
            <LegendList
              data={listItems}
              drawDistance={500}
              estimatedItemSize={64}
              extraData={listExtraData}
              getItemType={(item) => item.type}
              itemsAreEqual={sidebarItemsAreEqual}
              keyExtractor={(item) => item.key}
              renderItem={renderListItem}
              contentContainerStyle={[
                styles.threadListContent,
                {
                  paddingBottom:
                    Platform.OS === "android"
                      ? Math.max(insets.bottom, 16) + 88 - insets.bottom
                      : 16 + insets.bottom,
                  paddingTop: topListInset,
                },
              ]}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              {...scrollGateHandlers}
              recycleItems
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              style={styles.threadList}
              ListEmptyComponent={listEmpty}
              ListFooterComponent={archivedSectionFooter}
            />
          </GestureDetector>
        </SwipeableScrollGateProvider>
      </View>

      <View
        className="absolute inset-x-0 top-0 z-[4] bg-drawer"
        collapsable={false}
        onLayout={handleStickyHeaderLayout}
        pointerEvents="auto"
        style={{ paddingTop: insets.top }}
      >
        <View className="h-[50px] flex-row items-end gap-0.5 pr-2 pl-5">
          {/* Title slot doubles as the connection status surface: while an
              environment reconnects, the brand fades to a status label in
              place (no layout shift in the list below). */}
          <WorkspaceConnectionTitle
            grow
            onPress={props.onOpenEnvironmentSettings}
            showThreadSync
            size="pageTitle"
            brand={
              <View className="h-11 flex-1 justify-center">
                <CompactBrandTitle allowFontScaling={false} />
              </View>
            }
          />
          <View className="flex-row items-center gap-2.5">
            <ControlPillMenu actions={listMenuActions} onPressAction={handleListMenuAction}>
              <SidebarFilterButton accessibilityLabel="Filter and sort threads" icon={filterIcon} />
            </ControlPillMenu>
            {threadListV2Enabled ? (
              <SidebarFilterButton
                active={attentionFilter.enabled}
                accessibilityLabel={
                  attentionFilter.enabled
                    ? "Clear attention filter"
                    : attentionFilter.ready
                      ? "Show only threads needing attention"
                      : "Loading threads"
                }
                disabled={!attentionFilter.ready && !attentionFilter.enabled}
                icon={
                  attentionFilter.enabled ? "exclamationmark.circle.fill" : "exclamationmark.circle"
                }
                onPress={attentionFilter.toggle}
              />
            ) : null}
            <SidebarHeaderActions onOpenSettings={props.onOpenSettings} />
          </View>
        </View>

        <View className="mx-4 mt-[9px] h-[38px] flex-row items-center gap-1.5 rounded-xl bg-sidebar-search pr-2.5 pl-[11px]">
          <SymbolView
            name="magnifyingglass"
            size={15}
            tintColorClassName={"accent-foreground-muted"}
            type="monochrome"
          />
          <TextInput
            ref={searchInputRef}
            accessibilityLabel="Search threads"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            onChangeText={props.onSearchQueryChange}
            placeholder="Search"
            placeholderTextColorClassName={"accent-placeholder"}
            returnKeyType="search"
            className="h-[34px] flex-1 px-0 py-0 font-sans text-base text-foreground"
            value={props.searchQuery}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 8,
  },
});
