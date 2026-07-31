import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";

import { getCompactBrandHeaderOptions } from "../../components/CompactBrandTitle";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { checkForAppUpdateOnLaunch } from "../updates/app-updates";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { useHomeModelFilterOptions } from "./use-home-model-filter-options";
import { buildHomeProjectScopes, hasHomeThreadListContent } from "./homeThreadList";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useArchivedThreadListActions, useThreadListActions } from "./useThreadListActions";
import { shouldShowWorkspaceConnectionStatus } from "./workspace-connection-status";
import { useThreadAttentionFilter } from "../threads/use-thread-attention-filter";
import { pendingTaskAttentionKey } from "../threads/threadAttention";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState("");
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

  useEffect(() => {
    void checkForAppUpdateOnLaunch();
  }, []);

  const { archiveThread, confirmDeleteThread, settleThread, unsettleThread } =
    useThreadListActions();
  const { unarchiveThread, confirmDeleteThread: confirmDeleteArchivedThread } =
    useArchivedThreadListActions();
  const hasAnyThreads = hasHomeThreadListContent({
    threads,
    pendingTaskCount: pendingTasks.length,
  });
  const compactHeaderConnectionStatusState =
    hasAnyThreads && shouldShowWorkspaceConnectionStatus(catalogState) ? catalogState : null;
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(() => {
    const connectionStateByEnvironmentId = new Map(
      workspaceEnvironments.map(
        (environment) => [environment.environmentId, environment.connectionState] as const,
      ),
    );
    return Arr.sort(
      Object.values(savedConnectionsById).map((connection) => ({
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        connectionState:
          connectionStateByEnvironmentId.get(connection.environmentId) ?? "available",
      })),
      Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
    );
  }, [savedConnectionsById, workspaceEnvironments]);
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const { modelFilterOptions, availableModels } = useHomeModelFilterOptions(threads);
  const {
    options: listOptions,
    setSelectedEnvironmentId,
    setSelectedModel,
    setProjectSortOrder,
    setThreadSortOrder,
  } = useHomeListOptions(availableEnvironmentIds, availableModels);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  const selectedModelLabel =
    modelFilterOptions.find((model) => model.key === listOptions.selectedModel)?.label ?? null;
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const projectFilterOptions = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: selectedEnvironmentId,
        projectGroupingMode: listOptions.projectGroupingMode,
      }).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [listOptions.projectGroupingMode, projects, selectedEnvironmentId],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);

  // In split layouts the persistent sidebar IS the thread list — Home becomes
  // an empty detail pane so selecting a thread never transitions layouts.
  if (layout.usesSplitView) {
    return (
      <>
        <NativeStackScreenOptions
          options={{ title: "", headerTitle: "", unstable_headerLeftItems: () => [] }}
        />
        <WorkspaceSidebarToolbar
          afterSidebarButton={
            <NativeHeaderToolbar.Button
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
            />
          }
        />
        <WorkspaceEmptyDetail
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
        />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout
      onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
    >
      <>
        {/* Restore the compact title after the split branch blanks the detail header. */}
        <NativeStackScreenOptions options={getCompactBrandHeaderOptions()} />
        <HomeHeader
          attentionFilterEnabled={attentionFilter.enabled}
          attentionFilterReady={attentionFilter.ready}
          connectionStatusState={compactHeaderConnectionStatusState}
          environments={environments}
          projects={projectFilterOptions}
          models={modelFilterOptions}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          selectedModel={listOptions.selectedModel}
          projectSortOrder={listOptions.projectSortOrder}
          threadSortOrder={listOptions.threadSortOrder}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onModelChange={setSelectedModel}
          onOpenEnvironments={() =>
            navigation.navigate("SettingsSheet", { screen: "SettingsEnvironments" })
          }
          onOpenSettings={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
          onProjectSortOrderChange={setProjectSortOrder}
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
          onThreadSortOrderChange={setThreadSortOrder}
          onToggleAttentionFilter={attentionFilter.toggle}
        />

        <HomeScreen
          attentionMemberPendingTaskKeys={attentionFilter.memberPendingTaskKeys}
          attentionMemberThreadKeys={attentionFilter.memberThreadKeys}
          catalogState={catalogState}
          environments={environments}
          onAddConnection={() =>
            navigation.navigate("SettingsSheet", { screen: "SettingsEnvironmentNew" })
          }
          onArchiveThread={archiveThread}
          onDeleteArchivedThread={confirmDeleteArchivedThread}
          onClearAttentionFilter={attentionFilter.clear}
          onDeleteThread={confirmDeleteThread}
          onSettleThread={settleThread}
          onUnsettleThread={unsettleThread}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenEnvironments={() =>
            navigation.navigate("SettingsSheet", { screen: "SettingsEnvironments" })
          }
          onOpenSettings={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
          onOpenAllArchivedThreads={() =>
            navigation.navigate("SettingsSheet", { screen: "SettingsArchive" })
          }
          onProjectSortOrderChange={setProjectSortOrder}
          onSearchQueryChange={setSearchQuery}
          onSelectThread={(thread) => {
            // Compact drills into the thread and leaves the search field
            // behind; the native one comes back empty, so a retained query
            // would silently filter the list on the way back. Split view is
            // unaffected — its sidebar and search bar stay on screen.
            setSearchQuery("");
            // Settled threads are live shells: opening one is plain
            // navigation, and sending a message un-settles server-side.
            navigation.navigate("Thread", {
              environmentId: thread.environmentId,
              threadId: thread.id,
            });
          }}
          onSelectPendingTask={openPendingTask}
          onDeletePendingTask={confirmDeletePendingTask}
          onNewThreadInProject={(project) => {
            navigation.navigate("NewTaskSheet", {
              screen: "NewTaskDraft",
              params: {
                environmentId: String(project.environmentId),
                projectId: String(project.id),
                title: project.title,
              },
            });
          }}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
          onThreadSortOrderChange={setThreadSortOrder}
          onUnarchiveThread={unarchiveThread}
          pendingTasks={pendingTasks}
          projectGroupingMode={listOptions.projectGroupingMode}
          projects={projects}
          projectSortOrder={listOptions.projectSortOrder}
          savedConnectionsById={savedConnectionsById}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedModel={listOptions.selectedModel}
          selectedModelLabel={selectedModelLabel}
          selectedProjectKey={selectedProjectKey}
          threads={threads}
          threadSortOrder={listOptions.threadSortOrder}
        />
      </>
    </AndroidHomeFabLayout>
  );
}
