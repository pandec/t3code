import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useCallback, useRef } from "react";
import type { SearchBarCommands } from "react-native-screens";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import {
  createNativeAttentionFilterHeaderItem,
  createNativeFilterMenuHeaderItem,
} from "../layout/native-filter-menu-items";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { buildHomeListFilterMenu } from "./home-list-filter-menu";
import {
  hasActiveHomeListFilters,
  hasCustomHomeListOptions,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
} from "./home-list-options";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

export function HomeHeader(props: HomeHeaderProps) {
  const searchBarRef = useRef<SearchBarCommands>(null);
  const theme = useUniwindTheme();
  const iconColor = theme["--color-icon"];
  const primaryColor = theme["--color-primary"];
  // Thread List v2 lays the list out in fixed creation order, so the
  // sort/group filter controls would be silently ignored — hide them and
  // key the "customized" icon state off the environment filter alone.
  const threadListV2Enabled = useThreadListV2Enabled();
  const hasActiveFilters = hasActiveHomeListFilters(props);
  const hasCustomListOptions = threadListV2Enabled
    ? hasActiveFilters
    : hasCustomHomeListOptions(props);
  const focusSearch = useCallback(() => {
    searchBarRef.current?.focus();
    return searchBarRef.current !== null;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const filterMenu = buildHomeListFilterMenu({
    ...props,
    onClearFilters: () => {
      props.onEnvironmentChange(null);
      props.onProjectChange(null);
      props.onModelChange(null);
    },
    listOrganization: !threadListV2Enabled,
  });
  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={[
          filterMenu.items,
          props.attentionFilterEnabled,
          props.attentionFilterReady,
        ]}
        options={{
          // Static header config (glass, title, fonts) lives in Stack.tsx
          // (GLASS_HEADER_OPTIONS). Only dynamic values are set here.
          title: "Threads",
          headerTintColor: iconColor,
          unstable_headerRightItems: () => [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Open settings",
              icon: { name: "ellipsis", type: "sfSymbol" } as const,
              identifier: "home-settings",
              label: "",
              onPress: props.onOpenSettings,
              type: "button",
            }),
            ...(threadListV2Enabled
              ? [
                  createNativeAttentionFilterHeaderItem({
                    enabled: props.attentionFilterEnabled,
                    gated: !props.attentionFilterReady && !props.attentionFilterEnabled,
                    activeTintColor: primaryColor,
                    identifier: "home-attention-filter",
                    onToggle: props.onToggleAttentionFilter,
                  }),
                ]
              : []),
            createNativeFilterMenuHeaderItem({
              filterIcon: hasCustomListOptions
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle",
              filterMenu,
            }),
          ],
          // The keys below are set per-branch (not `undefined`) so a later
          // reapply cannot clobber options owned by NativeHeaderToolbar.
          ...(NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED
            ? {
                unstable_headerToolbarItems: () => [
                  createNativeMailSearchToolbarItem({
                    composeButtonId: "home-new-task",
                    composeSystemImageName: "square.and.pencil",
                    onComposePress: props.onStartNewTask,
                    onSearchTextChange: props.onSearchQueryChange,
                    placeholder: "Search",
                    searchTextChangeId: "home-search-text",
                    showsSearchDismissButton: true,
                  }),
                ],
              }
            : {
                // Pre-Liquid-Glass iOS: standard pull-down search in the nav
                // bar; create + sort live in the plain bottom toolbar below.
                headerSearchBarOptions: {
                  ref: searchBarRef,
                  autoCapitalize: "none" as const,
                  hideNavigationBar: false,
                  placeholder: "Search",
                  onCancelButtonPress: () => {
                    props.onSearchQueryChange("");
                  },
                  onChangeText: (event) => {
                    props.onSearchQueryChange(event.nativeEvent.text);
                  },
                },
              }),
        }}
      />

      {NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED ? null : (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.Menu
            accessibilityLabel="Filter and sort threads"
            icon={
              hasCustomListOptions
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            title="Thread list options"
            separateBackground
          >
            {hasActiveFilters ? (
              <NativeHeaderToolbar.MenuAction
                onPress={() => {
                  props.onEnvironmentChange(null);
                  props.onProjectChange(null);
                  props.onModelChange(null);
                }}
              >
                <NativeHeaderToolbar.Label>Clear filters</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            ) : null}

            <NativeHeaderToolbar.Menu title="Environment">
              <NativeHeaderToolbar.Label>Environment</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                isOn={props.selectedEnvironmentId === null}
                onPress={() => props.onEnvironmentChange(null)}
                subtitle="Show threads from every environment"
              >
                <NativeHeaderToolbar.Label>All environments</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              {props.environments.map((environment) => (
                <NativeHeaderToolbar.MenuAction
                  key={environment.environmentId}
                  isOn={props.selectedEnvironmentId === environment.environmentId}
                  onPress={() => props.onEnvironmentChange(environment.environmentId)}
                >
                  <NativeHeaderToolbar.Label>{environment.label}</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>

            {props.projects.length > 0 ? (
              <NativeHeaderToolbar.Menu title="Project">
                <NativeHeaderToolbar.Label>Project</NativeHeaderToolbar.Label>
                <NativeHeaderToolbar.MenuAction
                  isOn={props.selectedProjectKey === null}
                  onPress={() => props.onProjectChange(null)}
                  subtitle="Show threads from every project"
                >
                  <NativeHeaderToolbar.Label>All projects</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
                {props.projects.map((project) => (
                  <NativeHeaderToolbar.MenuAction
                    key={project.key}
                    isOn={props.selectedProjectKey === project.key}
                    onPress={() => props.onProjectChange(project.key)}
                  >
                    <NativeHeaderToolbar.Label>{project.label}</NativeHeaderToolbar.Label>
                  </NativeHeaderToolbar.MenuAction>
                ))}
              </NativeHeaderToolbar.Menu>
            ) : null}

            {props.models.length < 2 ? null : (
              <NativeHeaderToolbar.Menu title="Model">
                <NativeHeaderToolbar.Label>Model</NativeHeaderToolbar.Label>
                <NativeHeaderToolbar.MenuAction
                  isOn={props.selectedModel === null}
                  onPress={() => props.onModelChange(null)}
                >
                  <NativeHeaderToolbar.Label>All models</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
                {props.models.map((model) => (
                  <NativeHeaderToolbar.MenuAction
                    key={model.key}
                    isOn={props.selectedModel === model.key}
                    onPress={() => props.onModelChange(model.key)}
                  >
                    <NativeHeaderToolbar.Label>{model.label}</NativeHeaderToolbar.Label>
                  </NativeHeaderToolbar.MenuAction>
                ))}
              </NativeHeaderToolbar.Menu>
            )}

            {threadListV2Enabled ? null : (
              <NativeHeaderToolbar.Menu title="Sort projects">
                <NativeHeaderToolbar.Label>Sort projects</NativeHeaderToolbar.Label>
                {PROJECT_SORT_OPTIONS.map((option) => (
                  <NativeHeaderToolbar.MenuAction
                    key={option.value}
                    isOn={props.projectSortOrder === option.value}
                    onPress={() => props.onProjectSortOrderChange(option.value)}
                  >
                    <NativeHeaderToolbar.Label>{option.label}</NativeHeaderToolbar.Label>
                  </NativeHeaderToolbar.MenuAction>
                ))}
              </NativeHeaderToolbar.Menu>
            )}

            {threadListV2Enabled ? null : (
              <NativeHeaderToolbar.Menu title="Sort threads">
                <NativeHeaderToolbar.Label>Sort threads</NativeHeaderToolbar.Label>
                {THREAD_SORT_OPTIONS.map((option) => (
                  <NativeHeaderToolbar.MenuAction
                    key={option.value}
                    isOn={props.threadSortOrder === option.value}
                    onPress={() => props.onThreadSortOrderChange(option.value)}
                  >
                    <NativeHeaderToolbar.Label>{option.label}</NativeHeaderToolbar.Label>
                  </NativeHeaderToolbar.MenuAction>
                ))}
              </NativeHeaderToolbar.Menu>
            )}
          </NativeHeaderToolbar.Menu>
          {threadListV2Enabled ? (
            <NativeHeaderToolbar.Button
              accessibilityLabel={
                props.attentionFilterEnabled
                  ? "Clear attention filter"
                  : props.attentionFilterReady
                    ? "Show only threads needing attention"
                    : "Loading threads"
              }
              disabled={!props.attentionFilterReady && !props.attentionFilterEnabled}
              icon={
                props.attentionFilterEnabled
                  ? "exclamationmark.circle.fill"
                  : "exclamationmark.circle"
              }
              onPress={props.onToggleAttentionFilter}
              tintColor={props.attentionFilterEnabled ? primaryColor : undefined}
            />
          ) : null}
          <NativeHeaderToolbar.Spacer flexible />
          <NativeHeaderToolbar.Button
            accessibilityLabel="New task"
            icon="square.and.pencil"
            onPress={props.onStartNewTask}
            separateBackground
          />
        </NativeHeaderToolbar>
      )}
    </>
  );
}
