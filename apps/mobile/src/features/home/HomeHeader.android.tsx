import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useMemo } from "react";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import { MaterialThreadListToolbar } from "./MaterialThreadListToolbar";
import {
  hasActiveHomeListFilters,
  hasCustomHomeListOptions,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
} from "./home-list-options";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

export function HomeHeader(props: HomeHeaderProps) {
  const attentionFilterGated = !props.attentionFilterReady && !props.attentionFilterEnabled;
  // Thread List v2 lays the list out in fixed creation order, so the
  // sort/group filter controls would be silently ignored — hide them and
  // key the "customized" icon state off the environment filter alone.
  const threadListV2Enabled = useThreadListV2Enabled();
  const hasActiveFilters = hasActiveHomeListFilters(props);
  const hasCustomListOptions = threadListV2Enabled
    ? hasActiveFilters
    : hasCustomHomeListOptions(props);
  const menuActions = useMemo<MenuAction[]>(
    () => [
      // Gated on the scope filters alone, matching the shared iOS builder:
      // "Clear filters" leaves sort order untouched, so offering it for a
      // non-default sort would be a no-op menu item.
      ...(hasActiveFilters
        ? ([
            {
              id: "clear-filters",
              title: "Clear filters",
            },
          ] satisfies MenuAction[])
        : []),
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            state: checkedMenuState(props.selectedEnvironmentId === null),
          },
          ...props.environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state: checkedMenuState(props.selectedEnvironmentId === environment.environmentId),
          })),
        ],
      },
      ...(props.projects.length === 0
        ? []
        : ([
            {
              id: "project",
              title: "Project",
              subactions: [
                {
                  id: "project:all",
                  title: "All projects",
                  state: checkedMenuState(props.selectedProjectKey === null),
                },
                ...props.projects.map((project) => ({
                  id: `project:${project.key}`,
                  title: project.label,
                  state: checkedMenuState(props.selectedProjectKey === project.key),
                })),
              ],
            },
          ] satisfies MenuAction[])),
      // One model across every thread makes the section a no-op; it appears
      // only once it can discriminate (same rule as the shared iOS builder).
      ...(props.models.length < 2
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
                  state: checkedMenuState(props.selectedModel === null),
                },
                ...props.models.map((model) => ({
                  id: `model:${model.key}`,
                  title: model.label,
                  state: checkedMenuState(props.selectedModel === model.key),
                })),
              ],
            },
          ] satisfies MenuAction[])),
      ...(threadListV2Enabled
        ? []
        : ([
            {
              id: "project-sort",
              title: "Sort projects",
              subactions: PROJECT_SORT_OPTIONS.map((option) => ({
                id: `project-sort:${option.value}`,
                title: option.label,
                state: checkedMenuState(props.projectSortOrder === option.value),
              })),
            },
            {
              id: "thread-sort",
              title: "Sort threads",
              subactions: THREAD_SORT_OPTIONS.map((option) => ({
                id: `thread-sort:${option.value}`,
                title: option.label,
                state: checkedMenuState(props.threadSortOrder === option.value),
              })),
            },
          ] satisfies MenuAction[])),
    ],
    [
      props.environments,
      props.models,
      props.projectSortOrder,
      props.projects,
      props.selectedEnvironmentId,
      props.selectedModel,
      props.selectedProjectKey,
      props.threadSortOrder,
      hasActiveFilters,
      threadListV2Enabled,
    ],
  );
  const handleMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const id = event.nativeEvent.event;
      if (id === "clear-filters") {
        props.onEnvironmentChange(null);
        props.onProjectChange(null);
        props.onModelChange(null);
        return;
      }

      if (id === "environment:all") {
        props.onEnvironmentChange(null);
        return;
      }

      if (id.startsWith("environment:")) {
        const environmentId = id.slice("environment:".length);
        const environment = props.environments.find(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (environment) {
          props.onEnvironmentChange(environment.environmentId);
        }
        return;
      }

      if (id === "project:all") {
        props.onProjectChange(null);
        return;
      }

      if (id.startsWith("project:")) {
        const projectKey = id.slice("project:".length);
        if (props.projects.some((project) => project.key === projectKey)) {
          props.onProjectChange(projectKey);
        }
        return;
      }

      if (id === "model:clear") {
        props.onModelChange(null);
        return;
      }

      if (id.startsWith("model:")) {
        const modelKey = id.slice("model:".length);
        if (props.models.some((model) => model.key === modelKey)) {
          props.onModelChange(modelKey);
        }
        return;
      }

      const projectSort = PROJECT_SORT_OPTIONS.find(
        (option) => id === `project-sort:${option.value}`,
      );
      if (projectSort) {
        props.onProjectSortOrderChange(projectSort.value);
        return;
      }

      const threadSort = THREAD_SORT_OPTIONS.find((option) => id === `thread-sort:${option.value}`);
      if (threadSort) {
        props.onThreadSortOrderChange(threadSort.value);
        return;
      }
    },
    [props],
  );

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <MaterialThreadListToolbar
        searchQuery={props.searchQuery}
        onSearchQueryChange={props.onSearchQueryChange}
        filterActions={menuActions}
        filterCustomized={hasCustomListOptions}
        onFilterAction={handleMenuAction}
        onOpenSettings={props.onOpenSettings}
        onOpenEnvironments={props.onOpenEnvironments}
        attentionFilter={
          threadListV2Enabled
            ? {
                enabled: props.attentionFilterEnabled,
                gated: attentionFilterGated,
                onToggle: props.onToggleAttentionFilter,
              }
            : undefined
        }
      />
    </>
  );
}
