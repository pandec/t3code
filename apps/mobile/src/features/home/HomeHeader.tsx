import type { EnvironmentId, SidebarThreadSortOrder } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import Constants from "expo-constants";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useCallback, useMemo, useRef } from "react";
import { Platform, Pressable, Text as RNText, TextInput, View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { T3Wordmark } from "../../components/T3Wordmark";
import { HOME_HORIZONTAL_INSET } from "../../lib/layoutMetrics";
import { resolveMobileStageLabel } from "../../lib/mobileBranding";
import { useThemeColor } from "../../lib/useThemeColor";
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
import type { HomeProjectSortOrder } from "./homeThreadList";
import { WorkspaceConnectionTitle } from "./WorkspaceConnectionTitle";
import {
  buildHomeListFilterMenu,
  type HomeListFilterMenuEnvironment,
  type HomeListFilterMenuModel,
  type HomeListFilterMenuProject,
} from "./home-list-filter-menu";
import {
  hasActiveHomeListFilters,
  hasCustomHomeListOptions,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
} from "./home-list-options";

export type HomeHeaderEnvironment = HomeListFilterMenuEnvironment;

export function HomeHeader(props: {
  readonly environments: ReadonlyArray<HomeHeaderEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly models: ReadonlyArray<HomeListFilterMenuModel>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly selectedModel: string | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly attentionFilterEnabled: boolean;
  /** False while thread shells are still loading; gates enabling the filter. */
  readonly attentionFilterReady: boolean;
  readonly onToggleAttentionFilter: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onModelChange: (model: string | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly onOpenEnvironments: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
}) {
  if (Platform.OS === "android") {
    return <AndroidHomeHeader {...props} />;
  }

  return <IosHomeHeader {...props} />;
}

type HomeHeaderProps = Parameters<typeof HomeHeader>[0];

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

function AndroidHomeHeader(props: HomeHeaderProps) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const primaryColor = useThemeColor("--color-primary");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const attentionFilterGated = !props.attentionFilterReady && !props.attentionFilterEnabled;
  const stageLabel = resolveMobileStageLabel(Constants.expoConfig?.extra?.appVariant);
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
      <View
        className="border-b border-header-border bg-header pb-3"
        style={{
          paddingHorizontal: HOME_HORIZONTAL_INSET,
          paddingTop: Math.max(insets.top, 12),
        }}
      >
        <View className="w-full max-w-[720px] self-center gap-3">
          <View className="flex-row items-center gap-2.5">
            {/* Brand slot doubles as the connection status surface: while an
                environment reconnects, the lockup fades to a status label in
                place (no layout shift in the list below). */}
            <WorkspaceConnectionTitle
              grow
              onPress={props.onOpenEnvironments}
              showThreadSync
              brand={
                <View className="flex-row items-center gap-2">
                  {/* Mirrors the desktop SidebarBrand: T3 mark + muted "Code". */}
                  <T3Wordmark color={iconColor} height={15} />
                  <RNText className="-ml-0.5 text-[21px] font-t3-medium tracking-[-0.5px] text-foreground-muted">
                    Code
                  </RNText>
                  {stageLabel === null ? null : (
                    <View className="rounded-full bg-subtle px-2 py-0.75">
                      <RNText className="text-[11px] font-t3-bold tracking-[1.1px] text-foreground-muted uppercase">
                        {stageLabel}
                      </RNText>
                    </View>
                  )}
                </View>
              }
            />

            {/* Built identically to the filter button so the two circles
                match exactly (ControlPill sizes via Tailwind classes and
                resolves to a different box). */}
            <Pressable
              accessibilityLabel="Open settings"
              accessibilityRole="button"
              onPress={props.onOpenSettings}
              className="size-11 items-center justify-center rounded-full bg-subtle"
            >
              <SymbolView name="gearshape" size={18} tintColor={iconColor} type="monochrome" />
            </Pressable>
            {threadListV2Enabled ? (
              <Pressable
                accessibilityLabel={
                  attentionFilterGated
                    ? "Loading threads"
                    : props.attentionFilterEnabled
                      ? "Clear attention filter"
                      : "Show only threads needing attention"
                }
                accessibilityRole="togglebutton"
                accessibilityState={{
                  checked: props.attentionFilterEnabled,
                  disabled: attentionFilterGated,
                }}
                disabled={attentionFilterGated}
                onPress={props.onToggleAttentionFilter}
                className="size-11 items-center justify-center rounded-full bg-subtle"
                style={attentionFilterGated ? { opacity: 0.4 } : undefined}
              >
                <SymbolView
                  name={
                    props.attentionFilterEnabled
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle"
                  }
                  size={18}
                  tintColor={props.attentionFilterEnabled ? primaryColor : iconColor}
                  type="monochrome"
                />
              </Pressable>
            ) : null}
            <ControlPillMenu
              actions={menuActions}
              isAnchoredToRight
              onPressAction={handleMenuAction}
            >
              <Pressable
                accessibilityLabel="Filter and sort threads"
                accessibilityRole="button"
                className="size-11 items-center justify-center rounded-full bg-subtle"
              >
                <SymbolView
                  name={
                    hasCustomListOptions
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle"
                  }
                  size={16}
                  tintColor={iconColor}
                  type="monochrome"
                />
              </Pressable>
            </ControlPillMenu>
          </View>

          <View className="min-h-12 flex-row items-center gap-2.5 rounded-2xl border border-input-border bg-input px-3.5">
            <SymbolView name="magnifyingglass" size={17} tintColor={mutedColor} type="monochrome" />
            <TextInput
              accessibilityLabel="Search threads"
              autoCapitalize="none"
              onChangeText={props.onSearchQueryChange}
              placeholder="Search threads"
              placeholderTextColorClassName="accent-placeholder"
              className="flex-1 py-2.5 text-base font-sans text-foreground"
              value={props.searchQuery}
            />
            {props.searchQuery.length > 0 ? (
              <Pressable
                accessibilityLabel="Clear search"
                hitSlop={10}
                onPress={() => props.onSearchQueryChange("")}
              >
                <SymbolView
                  name="xmark.circle.fill"
                  size={17}
                  tintColor={mutedColor}
                  type="monochrome"
                />
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </>
  );
}

function IosHomeHeader(props: HomeHeaderProps) {
  const searchBarRef = useRef<SearchBarCommands>(null);
  const iconColor = useThemeColor("--color-icon");
  const primaryColor = useThemeColor("--color-primary");
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
          unstable_headerRightItems:
            Platform.OS === "ios"
              ? () => [
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
                ]
              : undefined,
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
                  ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease.circle"
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
