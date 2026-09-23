import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useMemo } from "react";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { MaterialThreadListToolbar } from "./MaterialThreadListToolbar";
import { hasActiveHomeListFilters } from "./home-list-options";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

export function HomeHeader(props: HomeHeaderProps) {
  const attentionFilterGated = !props.attentionFilterReady && !props.attentionFilterEnabled;
  const hasActiveFilters = hasActiveHomeListFilters(props);
  const hasCustomListOptions = hasActiveFilters;
  const menuActions = useMemo<MenuAction[]>(
    () => [
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
    ],
    [
      props.environments,
      props.models,
      props.projects,
      props.selectedEnvironmentId,
      props.selectedModel,
      props.selectedProjectKey,
      hasActiveFilters,
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
        attentionFilter={{
          enabled: props.attentionFilterEnabled,
          gated: attentionFilterGated,
          onToggle: props.onToggleAttentionFilter,
        }}
      />
    </>
  );
}
