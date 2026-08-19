import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";

const ARCHIVED_MENU_ACTIONS: MenuAction[] = [
  { id: "unarchive", title: "Unarchive", image: "arrow.uturn.backward" },
  {
    id: "delete",
    title: "Delete",
    image: "trash",
    attributes: { destructive: true },
  },
];

const RecentArchivedThreadRow = memo(function RecentArchivedThreadRow(props: {
  readonly environmentLabel: string | null;
  readonly project: EnvironmentProject | null;
  readonly thread: EnvironmentThreadShell;
  readonly isSelected: boolean;
  readonly onDelete: (thread: EnvironmentThreadShell) => void;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
  readonly onUnarchive: (thread: EnvironmentThreadShell) => void;
  readonly pane?: "screen" | "sidebar";
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "unarchive") props.onUnarchive(props.thread);
      if (nativeEvent.event === "delete") props.onDelete(props.thread);
    },
    [props],
  );
  return (
    <ControlPillMenu
      actions={ARCHIVED_MENU_ACTIONS}
      onPressAction={handleMenuAction}
      shouldOpenOnLongPress
    >
      <Pressable
        accessibilityHint="Opens the archived thread. Sending a message unarchives it."
        accessibilityLabel={props.thread.title}
        accessibilityRole="button"
        accessibilityState={{ selected: props.isSelected }}
        onPress={() => props.onOpen(props.thread)}
        className={
          props.pane === "sidebar"
            ? `mx-2 rounded-xl ${props.isSelected ? "bg-control" : "bg-drawer"}`
            : props.isSelected
              ? "bg-control"
              : "bg-screen"
        }
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <View
          className={
            props.pane === "sidebar"
              ? "flex-row items-center gap-2.5 px-3 py-2.5"
              : "flex-row items-center gap-3 px-5 py-2.5"
          }
        >
          {props.project ? (
            <ProjectFavicon
              environmentId={props.thread.environmentId}
              faviconPath={props.project.faviconPath}
              projectTitle={props.project.title}
              size={15}
              workspaceRoot={props.project.workspaceRoot}
            />
          ) : (
            <SymbolView name="archivebox" size={15} tintColor={iconColor} type="monochrome" />
          )}
          <View className="min-w-0 flex-1">
            <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
              {props.thread.title}
            </Text>
            <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
              {[props.project?.title, props.environmentLabel].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <Text className="text-xs tabular-nums text-foreground-tertiary">
            {relativeTime(
              props.thread.archivedAt ?? props.thread.updatedAt ?? props.thread.createdAt,
            )}
          </Text>
          <Pressable
            accessibilityLabel={`Unarchive ${props.thread.title}`}
            accessibilityRole="button"
            hitSlop={8}
            onPress={(event) => {
              event.stopPropagation();
              props.onUnarchive(props.thread);
            }}
            className="size-9 items-center justify-center"
          >
            <SymbolView
              name="arrow.uturn.backward"
              size={15}
              tintColor={iconColor}
              type="monochrome"
            />
          </Pressable>
        </View>
        {props.pane === "sidebar" ? null : <View className="ml-5 h-px bg-border-subtle" />}
      </Pressable>
    </ControlPillMenu>
  );
});

/**
 * Header for the archived shelf, in the settled shelf's muted idiom — archived
 * threads are the quietest thing in the list, and the fold state persists per
 * device (see `useThreadShelfExpansion`).
 */
const ArchivedShelfHeader = memo(function ArchivedShelfHeader(props: {
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
}) {
  const mutedColor = useThemeColor("--color-foreground-muted");
  return (
    <Pressable
      accessibilityHint={
        props.expanded ? "Collapses the archived threads." : "Expands the archived threads."
      }
      accessibilityLabel={
        props.count === 1 ? "1 archived thread" : `${props.count} archived threads`
      }
      accessibilityRole="button"
      accessibilityState={{ expanded: props.expanded }}
      className={`mb-1.5 mt-4 flex-row items-center gap-2.5 ${props.pane === "sidebar" ? "px-3" : "px-5"}`}
      onPress={props.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text className="text-xs font-t3-medium text-foreground-tertiary">
        {props.expanded ? "Archived" : `Archived (${props.count})`}
      </Text>
      <View className="h-px flex-1 bg-border" />
      <SymbolView
        name="chevron.down"
        size={10}
        tintColor={mutedColor}
        type="monochrome"
        style={{ transform: [{ rotate: props.expanded ? "180deg" : "0deg" }] }}
      />
    </Pressable>
  );
});

export function RecentArchivedThreadSection(props: {
  readonly environmentLabels: Readonly<Record<string, string>>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** Unclipped archived total, which is what the folded header reports. */
  readonly totalCount?: number;
  readonly onDelete: (thread: EnvironmentThreadShell) => void;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
  readonly onOpenAll: () => void;
  readonly onUnarchive: (thread: EnvironmentThreadShell) => void;
  readonly selectedThreadKey?: string | null;
  readonly pane?: "screen" | "sidebar";
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  if (props.threads.length === 0) return null;
  const projectByKey = new Map(
    props.projects.map((project) => [scopedProjectKey(project.environmentId, project.id), project]),
  );
  // The open thread keeps its row on a folded shelf, the same exception every
  // other shelf makes: a split-view detail must never lose its navigation row.
  const visibleThreads = props.expanded
    ? props.threads
    : props.threads.filter(
        (thread) => scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey,
      );
  return (
    <View>
      <ArchivedShelfHeader
        count={props.totalCount ?? props.threads.length}
        expanded={props.expanded}
        onToggle={props.onToggle}
        pane={props.pane}
      />
      {visibleThreads.map((thread) => (
        <RecentArchivedThreadRow
          key={`${thread.environmentId}:${thread.id}`}
          environmentLabel={props.environmentLabels[thread.environmentId] ?? null}
          project={
            projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null
          }
          thread={thread}
          isSelected={props.selectedThreadKey === scopedThreadKey(thread.environmentId, thread.id)}
          onDelete={props.onDelete}
          onOpen={props.onOpen}
          onUnarchive={props.onUnarchive}
          pane={props.pane}
        />
      ))}
      {props.expanded ? (
        <Pressable
          accessibilityLabel="View all archived threads"
          accessibilityRole="button"
          onPress={props.onOpenAll}
          className={
            props.pane === "sidebar"
              ? "mx-3 mt-2 h-10 items-center justify-center rounded-lg border border-dashed border-border"
              : "mx-5 mt-2 h-10 items-center justify-center rounded-lg border border-dashed border-border"
          }
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text className="text-xs font-t3-medium text-foreground-muted">
            View all archived threads
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
