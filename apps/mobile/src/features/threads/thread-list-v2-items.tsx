import type { ThreadRowProviderInstance } from "./thread-provider-instance";
import {
  THREAD_LIST_V2_MONO_FONT as MONO_FONT,
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  selectedThreadRowColors,
  getThreadListV2NewBranchMenuTitle,
  getThreadListV2RowAppearance,
} from "./thread-list-v2-row-appearance";
import { RowPressable } from "../../components/RowPressable";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import type { ThreadMoveDestination } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { AuthOrchestrationOperateScope, type EnvironmentMachineKind } from "@t3tools/contracts";
import {
  canForkConversation,
  canForkImportedSessionWith,
} from "@t3tools/client-runtime/state/thread-fork";
import {
  canSnooze,
  canSnoozeUntilDone,
  hasPendingArchive,
  resolveArchiveToggleAction,
  resolveSnoozePresets,
  SNOOZE_UNTIL_DONE_PRESET,
} from "@t3tools/client-runtime/state/thread-settled";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { Alert, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { resolveRowAccentTintAlpha, withAccentAlpha } from "../../lib/accentTint";
import { ProviderIcon, ProviderInstanceIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useThreadListeningState } from "../../state/listeningPlayback";
import { toggleLoadedListeningTrack } from "../../state/listeningPlayer";
import { useEnvironmentScope } from "../../state/session";
import { useAccentTintSettings } from "../../state/use-mobile-preferences";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useThreadPr } from "../../state/use-thread-pr";
import { useSwipeRowDormant } from "../home/swipe-row-activation";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import {
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  resolveThreadListV2MenuActionIds,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2SnoozeMenuSelection,
  threadHasUnseenCompletion,
  resolveThreadListV2Status,
  resolveThreadListV2ProviderDrivers,
  resolveThreadListV2SwipeActions,
  type ThreadListV2MenuActionId,
  type ThreadListV2Status,
} from "./threadListV2";
import { QueuedMessageIcon } from "./queued-message-icon";
import { shouldRecedeThreadRow } from "./thread-row-emphasis";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";

/**
 * Thread List v2 renders active work and lifecycle shelves with native swipe
 * and long-press actions. State reads through colored status labels and text
 * hierarchy.
 */

// Status hues follow the system-wide convention set by the
// Live Activity/widgets (amber approval, indigo input, sky working) so a
// thread reads the same color everywhere it surfaces.
// Icons match the web sidebar's status glyphs.
interface StatusLabel {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly className: string;
  readonly iconTintClassName: string;
}
const STATUS_LABEL_BY_STATUS: Partial<Record<ThreadListV2Status, StatusLabel>> = {
  approval: {
    label: "Approval",
    icon: "exclamationmark.shield",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
  input: {
    label: "Input",
    icon: "questionmark.bubble",
    className: "text-adaptive-indigo-600-300",
    iconTintClassName: "accent-adaptive-indigo-600-300",
  },
  working: {
    label: "Working",
    icon: "circle.dashed",
    className: "text-adaptive-sky-600-400",
    iconTintClassName: "accent-adaptive-sky-600-400",
  },
  // Fork: watch loops alone (monitors, PR watches) outliving the turn.
  monitoring: {
    label: "Monitoring",
    icon: "eye",
    className: "text-foreground-secondary",
    iconTintClassName: "accent-foreground-secondary",
  },
  failed: {
    label: "Failed",
    icon: "exclamationmark.circle",
    className: "text-danger-foreground",
    iconTintClassName: "accent-danger-foreground",
  },
  limited: {
    label: "Limited",
    icon: "exclamationmark.circle",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
};
const DONE_STATUS_LABEL: StatusLabel = {
  label: "Done",
  icon: "checkmark.circle",
  className: "text-adaptive-emerald-700-300",
  iconTintClassName: "accent-adaptive-emerald-700-300",
};

// The archive item's title follows the row's archive toggle (see archiveMenuItem).
const MENU_ACTION_BY_ID: Readonly<Record<ThreadListV2MenuActionId, MenuAction>> = {
  settle: { id: "settle", title: "Settle", image: "checkmark" },
  unsettle: { id: "unsettle", title: "Un-settle", image: "arrow.uturn.backward" },
  archive: { id: "archive", title: "Archive", image: "archivebox" },
  delete: { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
};

function menuActionsForRow(input: {
  readonly settlementSupported: boolean;
  readonly variant: "card" | "slim";
}): MenuAction[] {
  return resolveThreadListV2MenuActionIds(input).map((id) => MENU_ACTION_BY_ID[id]);
}

// Each list ends with Delete; rows splice their own items in before it.
const CARD_MENU_ACTIONS = menuActionsForRow({ settlementSupported: true, variant: "card" });
const SLIM_MENU_ACTIONS = menuActionsForRow({ settlementSupported: true, variant: "slim" });
const LEGACY_MENU_ACTIONS = menuActionsForRow({ settlementSupported: false, variant: "card" });
// Archive rides along so the swipe-right gesture keeps a menu (and
// VoiceOver) twin on the snoozed shelf.
const SNOOZED_MENU_ACTIONS: MenuAction[] = [
  { id: "unsnooze", title: "Wake thread", image: "clock" },
  MENU_ACTION_BY_ID.archive,
  MENU_ACTION_BY_ID.delete,
];

/** Rounded-row radius for the sidebar rows. */
const SIDEBAR_V2_ROW_RADIUS = 12;

/**
 * The project accent as a flat tint layered over the row's own background,
 * mirroring web's `color-mix` overlay. Null accent renders nothing, and a
 * selected row keeps its solid selection fill — the accent identifies the
 * project, selection identifies the open thread, and the second must win.
 *
 * The device's tint settings are read here rather than threaded through every
 * row: this is the one place a tint is painted, so it is also where the tint
 * opt-out is enforced. Accent resolution stays ungated on purpose — with tints
 * off the group-header dot still carries the project's color.
 */
function AccentTintOverlay(props: {
  readonly accentColor: string | null;
  readonly receded?: boolean;
  readonly borderRadius?: number;
}) {
  const { enabled, alphas } = useAccentTintSettings();
  const alpha = resolveRowAccentTintAlpha({ enabled, alphas, receded: props.receded === true });
  if (props.accentColor === null || alpha === null) return null;
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: withAccentAlpha(props.accentColor, alpha),
          borderRadius: props.borderRadius,
        },
      ]}
    />
  );
}

function ThreadListV2Section(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
  readonly tone?: "default" | "snoozed";
  /** The header leads the list, so it only needs room from the list edge. */
  readonly leading?: boolean;
  readonly disclosure?: {
    readonly expanded: boolean;
    readonly disabled?: boolean;
    readonly onToggle: () => void;
    readonly accessibilityLabel: string;
    readonly accessibilityHint: string;
  };
}) {
  const snoozed = props.tone === "snoozed";
  const sidebarPane = props.pane === "sidebar";
  const className = cn(
    "mb-1.5 flex-row items-center gap-2.5",
    props.leading ? "mt-2" : "mt-4",
    props.pane === "sidebar" ? "px-3" : "px-5",
  );
  const content = (
    <>
      <Text
        className={cn(
          "text-xs font-t3-medium",
          sidebarPane
            ? "text-drawer-foreground-muted"
            : snoozed
              ? "text-foreground-secondary"
              : "text-foreground-tertiary",
        )}
      >
        {props.label}
      </Text>
      <View
        className={cn(
          "h-px flex-1",
          snoozed ? "bg-primary/20" : sidebarPane ? "bg-drawer-border" : "bg-border",
        )}
      />
      {props.disclosure ? (
        <SymbolView
          name="chevron.down"
          size={10}
          tintColorClassName={
            sidebarPane
              ? "accent-drawer-foreground-muted"
              : snoozed
                ? "accent-icon-muted"
                : "accent-foreground-muted"
          }
          type="monochrome"
          style={{ transform: [{ rotate: props.disclosure.expanded ? "180deg" : "0deg" }] }}
        />
      ) : null}
    </>
  );

  return props.disclosure ? (
    <Pressable
      accessibilityHint={props.disclosure.accessibilityHint}
      accessibilityLabel={props.disclosure.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{
        disabled: props.disclosure.disabled,
        expanded: props.disclosure.expanded,
      }}
      className={className}
      disabled={props.disclosure.disabled}
      onPress={props.disclosure.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {content}
    </Pressable>
  ) : (
    <View className={className}>{content}</View>
  );
}

/** Section label + rule: the only structure in an otherwise flat list. */
export const ThreadListV2SectionDivider = memo(function ThreadListV2SectionDivider(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
}) {
  return <ThreadListV2Section {...props} />;
});

/**
 * Closes the pinned block, matching the web sidebar: a rule with more
 * breathing room than the hairline between rows. The shelf header above
 * carries the label, so the divider stays unlabeled.
 */
export const ThreadListV2PinnedDivider = memo(function ThreadListV2PinnedDivider(props: {
  readonly pane?: "screen" | "sidebar";
}) {
  return (
    <View className={cn("my-2", props.pane === "sidebar" ? "px-3" : "px-5")}>
      {/* `bg-border`, not the rows' `bg-border-subtle`: a block boundary has
          to read stronger than the hairline between neighboring rows. */}
      <View className="h-px bg-border" />
    </View>
  );
});

export const ThreadListV2PinnedShelfHeader = memo(function ThreadListV2PinnedShelfHeader(props: {
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
}) {
  return (
    <ThreadListV2Section
      label={props.expanded ? "Pinned" : `Pinned (${props.count})`}
      leading
      pane={props.pane}
      disclosure={{
        expanded: props.expanded,
        onToggle: props.onToggle,
        accessibilityLabel: props.count === 1 ? "1 pinned thread" : `${props.count} pinned threads`,
        accessibilityHint: props.expanded
          ? "Collapses the pinned threads."
          : "Expands the pinned threads.",
      }}
    />
  );
});

type ThreadListV2ShelfHeaderProps = {
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
};

const SHELF_LABEL = { working: "Working", snoozed: "Snoozed", settled: "Settled" } as const;

function ThreadListV2ShelfHeader(
  props: ThreadListV2ShelfHeaderProps & { readonly kind: keyof typeof SHELF_LABEL },
) {
  const label = SHELF_LABEL[props.kind];
  return (
    <ThreadListV2Section
      label={props.expanded ? label : `${label} (${props.count})`}
      pane={props.pane}
      tone={props.kind === "snoozed" ? "snoozed" : "default"}
      disclosure={{
        expanded: props.expanded,
        disabled: props.disabled,
        onToggle: props.onToggle,
        accessibilityLabel: `${props.count} ${props.kind} ${props.count === 1 ? "thread" : "threads"}`,
        accessibilityHint: `${props.expanded ? "Collapses" : "Expands"} the ${props.kind} threads.`,
      }}
    />
  );
}

export const ThreadListV2WorkingShelfHeader = memo(function ThreadListV2WorkingShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="working" />;
});

export const ThreadListV2SnoozedShelfHeader = memo(function ThreadListV2SnoozedShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="snoozed" />;
});

export const ThreadListV2SettledShelfHeader = memo(function ThreadListV2SettledShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="settled" />;
});

export const ThreadListV2ShowMoreRow = memo(function ThreadListV2ShowMoreRow(props: {
  readonly pane?: "screen" | "sidebar";
  readonly hiddenCount: number;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Show ${Math.min(props.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`}
      onPress={props.onPress}
      className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        className={
          props.pane === "sidebar"
            ? "text-xs font-t3-medium text-drawer-foreground-muted"
            : "text-xs font-t3-medium text-foreground-muted"
        }
      >
        Show more ({props.hiddenCount} settled hidden)
      </Text>
    </Pressable>
  );
});

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const DRAFT_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Discard", image: "trash", attributes: { destructive: true } },
];

/**
 * Unsent work, in the same idiom as an active v2 row: it is work the user
 * wrote, so it reads like the thread it will become. The status slot says
 * what happens next, not where the item sits: "Sends on reconnect" stays
 * uncolored because nothing is asked of the user; "Draft" takes the amber the
 * web sidebar uses for drafts, because this one waits on the user.
 */
export const ThreadListV2PendingRow = memo(function ThreadListV2PendingRow(props: {
  readonly pendingTask: PendingNewTask;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  /** Same shared project accent the thread rows carry — a queued task sits
      in the same list and must not be the one row without it. */
  readonly projectAccentColor?: string | null;
  readonly environmentLabel: string | null;
  /** Drawn beside the label; ignored while the label is null. */
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  /** Draws the "Unsent" divider above the first draft or queued row. */
  readonly showPendingDivider: boolean;
  /** Keeps row hairlines inside a section; section headers draw their own rule. */
  readonly showTrailingDivider?: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}) {
  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const sidebarPane = props.pane === "sidebar";
  const isDraft = pendingTask.kind === "draft";
  const projectTitle = props.projectTitle ?? props.project?.title ?? pendingTask.projectTitle ?? "";
  const branch = pendingTask.branch;

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  const rowContent = (
    <>
      <View className="flex-row items-center gap-1.5">
        {props.project ? (
          <ProjectFavicon
            environmentId={pendingTask.environmentId}
            faviconPath={props.project.faviconPath}
            projectIcon={props.project.projectIcon}
            size={15}
            projectTitle={projectTitle}
            workspaceRoot={props.project.workspaceRoot}
          />
        ) : null}
        <Text
          className={cn(
            "flex-1 text-sm font-t3-medium text-foreground-muted",
            sidebarPane && "text-drawer-foreground-muted",
          )}
          numberOfLines={1}
        >
          {projectTitle}
        </Text>
        {isDraft ? (
          <View className="flex-row items-center gap-1">
            <SymbolView
              name="square.and.pencil"
              size={10}
              tintColorClassName="accent-adaptive-amber-700-300"
              type="monochrome"
            />
            <Text className="text-xs text-adaptive-amber-700-300">Draft</Text>
          </View>
        ) : (
          <Text
            className={cn(
              "text-xs text-foreground-tertiary",
              sidebarPane && "text-drawer-foreground-muted",
            )}
          >
            Sends on reconnect
          </Text>
        )}
      </View>
      {/* One line, unlike the two an active row allows: a queued title is
          derived from the whole prompt rather than written as a title, so the
          second line is usually a stray word or emoji rather than meaning. */}
      <Text
        className={cn(
          "mt-1 text-base font-t3-medium text-foreground",
          sidebarPane && "text-drawer-foreground",
        )}
        numberOfLines={1}
      >
        {pendingTask.title}
      </Text>
      {branch || props.environmentLabel ? (
        <View className="mt-1 flex-row items-center gap-1">
          <Text
            className={cn(
              "shrink text-xs text-foreground-muted",
              sidebarPane && "text-drawer-foreground-muted",
            )}
            numberOfLines={1}
          >
            {branch ? (
              <Text
                className={cn(
                  "text-xs text-foreground-muted",
                  sidebarPane && "text-drawer-foreground-muted",
                )}
                style={{ fontFamily: MONO_FONT }}
              >
                {branch}
              </Text>
            ) : null}
            {branch && props.environmentLabel ? "  ·  " : null}
            {props.environmentLabel ? (
              <Text
                className={cn(
                  "text-xs text-foreground-tertiary",
                  sidebarPane && "text-drawer-foreground-muted",
                )}
              >
                {props.environmentLabel}
              </Text>
            ) : null}
          </Text>
          {props.environmentLabel && props.environmentMachine ? (
            <EnvironmentMachineSymbol
              kind={props.environmentMachine}
              size={11}
              tintColorClassName={
                sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-tertiary"
              }
            />
          ) : null}
        </View>
      ) : null}
    </>
  );

  return (
    <>
      {props.showPendingDivider ? (
        <ThreadListV2SectionDivider label="Unsent" pane={props.pane} />
      ) : null}
      <ControlPillMenu
        actions={isDraft ? DRAFT_TASK_MENU_ACTIONS : PENDING_TASK_MENU_ACTIONS}
        onPressAction={handleMenuAction}
        shouldOpenOnLongPress
      >
        <RowPressable
          accessibilityHint={
            isDraft
              ? "Opens the draft in the new task composer"
              : "Sends when the environment reconnects. Opens the task for editing"
          }
          accessibilityLabel={pendingTask.title}
          accessibilityRole="button"
          key={pendingTask.key}
          className={sidebarPane ? "bg-drawer" : "bg-screen"}
          interactionClassName={sidebarPane ? "bg-thread-hover" : "bg-row-hover"}
          onPress={() => onSelectPendingTask(pendingTask)}
          style={
            sidebarPane
              ? {
                  borderRadius: SIDEBAR_V2_ROW_RADIUS,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }
              : undefined
          }
        >
          {sidebarPane ? (
            <>
              <AccentTintOverlay
                accentColor={props.projectAccentColor ?? null}
                borderRadius={SIDEBAR_V2_ROW_RADIUS}
              />
              {rowContent}
            </>
          ) : (
            <View>
              <View className="px-5 py-2.5">
                <AccentTintOverlay accentColor={props.projectAccentColor ?? null} />
                {rowContent}
              </View>
              {props.showTrailingDivider !== false ? (
                <View className="ml-5 h-px bg-border-subtle" />
              ) : null}
            </View>
          )}
        </RowPressable>
      </ControlPillMenu>
    </>
  );
});

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  /** A message for this thread is waiting in the outbox. */
  readonly hasQueuedMessages?: boolean;
  /** Snoozed-shelf row: shows its wake time and offers Wake. */
  readonly snoozed?: boolean;
  /** Pinned-block row: shows the pin glyph and offers Unpin. */
  readonly pinned?: boolean;
  /** Preformatted against the parent minute tick so this memoized row's
      countdown keeps moving. */
  readonly snoozeWakeLabelText?: string;
  /** Preformatted against the parent clock (row order timestamp: settle stamp
      on settled rows, latest activity otherwise). Blank while a status label
      or the wake countdown owns that slot. Precomputed per row — not via the
      list's extraData — so the minute tick re-renders only rows whose
      displayed text moved. */
  readonly timeLabel: string;
  /** Parent minute tick carried on the row's list item, present only when the
      row's menu offers snooze presets, so those menus refresh while mounted
      without invalidating every other row. */
  readonly snoozePresetMinute: string;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  /** Shared project accent (server settings, merged across environments).
      Rendered as a flat tint so a row is recognizable by project at a
      glance, exactly as in the web sidebar. */
  readonly projectAccentColor?: string | null;
  /** Keep the environment's provider array stable across unrelated list updates. */
  readonly providers: ReadonlyArray<ThreadListProvider> | undefined;
  readonly providerInstance: ThreadRowProviderInstance | null;
  /** Which machine hosts the thread. Null when only one environment is
      connected — repeating the same label on every row is noise. Mirrors
      the web sidebar's remote-environment cloud icon, but as text since
      phones have no hover tooltips. */
  readonly environmentLabel: string | null;
  /** Drawn after the label so the machine reads at a glance; ignored while
      the label is null. */
  readonly environmentMachine?: EnvironmentMachineKind;
  /** Hosting surface. "screen" (default) renders the compact Home idiom:
      flat edge-to-edge rows on the screen background with inset hairlines.
      "sidebar" renders the iPad split-view idiom: rounded rows blending
      into the drawer surface, selection filled with the accent color —
      matching the sidebar rows. */
  readonly pane?: "screen" | "sidebar";
  /** Keeps row hairlines inside a section; section headers draw their own rule. */
  readonly showTrailingDivider?: boolean;
  /** Highlights the thread open in the detail pane (iPad split view). The
      compact Home list never sets it — phones navigate away on select. */
  readonly selected?: boolean;
  /** Override for narrow panes (iPad sidebar); defaults to window width. */
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (
    thread: EnvironmentThreadShell,
    snoozedUntil: string | null,
    options?: { readonly untilDone?: boolean },
  ) => void;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => void;
  /** Forks the conversation and opens the copy. Offered only where
      {@link canForkConversation} allows it. */
  readonly onForkThread: (thread: EnvironmentThreadShell) => void;
  readonly onSetThreadAutoSettle: (thread: EnvironmentThreadShell, enabled: boolean) => void;
  /** False on environments whose server predates thread.settle/unsettle:
      swipe + menu fall back to Archive instead of failing on use. */
  readonly settlementSupported: boolean;
  /** False on servers that predate thread.snooze/unsnooze. */
  readonly snoozeSupported: boolean;
  /** Fork: false on servers that predate "Until it's done" (untilDone). */
  readonly snoozeUntilDoneSupported?: boolean;
  /** False on servers that predate thread.pin/unpin. */
  readonly pinningSupported: boolean;
  /** False on servers that predate thread.auto-settle.set. */
  readonly autoSettleOptOutSupported: boolean;
  /** False on servers that predate thread title regeneration. */
  readonly titleRegenerationSupported: boolean;
  /** Server supports reordering this card's section. */
  readonly reorderSupported?: boolean;
  readonly onMoveThread?: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => void;
  /** Position flags for the card's section so the menu disables the move that
      would fall off the end of the list. */
  readonly canMoveUp?: boolean;
  readonly canMoveDown?: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  /** List key checked against the Home swipe row activation. */
  readonly activationKey?: string;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  readonly simultaneousSwipeGesture?: ComponentProps<typeof ThreadSwipeable>["simultaneousWith"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const {
    thread,
    variant,
    onSelectThread,
    onDeleteThread,
    onRenameThread,
    onRegenerateThreadTitle,
    onNewThreadOnBranch,
    onSettleThread,
    onSnoozeThread,
    onUnsnoozeThread,
    onUnsettleThread,
    onArchiveThread,
    onPinThread,
    onUnpinThread,
    onForkThread,
    onSetThreadAutoSettle,
    onMoveThread,
  } = props;
  const snoozedRow = props.snoozed === true;
  const pinnedRow = props.pinned === true;
  const dormant = useSwipeRowDormant(props.activationKey);

  const { providerDrivers, providerIconUrl } = useMemo(() => {
    const provider = props.providers?.find(
      (candidate) =>
        candidate.instanceId ===
        (thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId),
    );
    return {
      providerDrivers: resolveThreadListV2ProviderDrivers(thread, props.providers),
      providerIconUrl: provider?.iconUrl,
    };
  }, [thread, props.providers]);

  const providerInstance = props.providerInstance;
  const pr = useThreadPr(thread);

  const theme = useUniwindTheme();
  const selectedForegroundColor = theme["--color-thread-selected-foreground"];
  const pinTintColor = theme["--color-foreground-muted"];
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  const rowAppearance = getThreadListV2RowAppearance(theme, sidebarPane, selected);

  const accentColor = props.projectAccentColor ?? null;
  const status = resolveThreadListV2Status(thread);
  // "Done" marks a completion the user has not opened yet — same emerald
  // label as the web sidebar, sourced from the server-side visited watermark
  // so checking a thread on any device clears it everywhere.
  const isUnread = status === "ready" && threadHasUnseenCompletion(thread);
  const workingLabel = STATUS_LABEL_BY_STATUS[status];
  const statusLabel =
    // A native /goal keeps the agent going across turns until it is met.
    (status === "working" && workingLabel !== undefined && thread.goal?.status === "active"
      ? { ...workingLabel, label: "Goal" }
      : workingLabel) ?? (isUnread ? DONE_STATUS_LABEL : undefined);
  const recede = shouldRecedeThreadRow({ status, selected });
  // The timestamp is precomputed on the list item (same stamps the settled
  // tail sorts by) so a minute tick only re-renders rows that draw it.
  const timeLabel = props.timeLabel;
  // Fork: a scheduled (deferred) archive stays visible at a glance in both
  // row variants until it runs or is cancelled from the row menu. The row's
  // accessibilityLabel collapses its subtree, so it is announced there.
  const archivePending = hasPendingArchive(thread);
  const rowAccessibilityLabel = [
    thread.title,
    props.hasQueuedMessages && "messages queued to send",
    archivePending && "archives when done",
  ]
    .filter(Boolean)
    .join(", ");
  const archivePendingIcon = archivePending ? (
    <SymbolView
      name="archivebox"
      size={11}
      tintColorClassName="accent-warning-foreground"
      type="monochrome"
    />
  ) : null;
  // One archive behavior on every surface: a busy thread archives when done
  // and a pending archive can be cancelled from the same item.
  const archiveToggle = resolveArchiveToggleAction(thread);
  // Set while this thread's recording is playing or paused mid-way, so
  // pausing from the list keeps a way back in. A finished recording clears
  // it. Re-renders only when the state flips, never on the progress tick.
  const listeningState = useThreadListeningState(thread.environmentId, thread.id);
  const toggleListeningAudio = useCallback(() => toggleLoadedListeningTrack(), []);
  const listeningActionLabel = listeningState === "playing" ? "Pause audio" : "Play audio";
  // The row Pressable's accessibilityLabel collapses its subtree, so the
  // nested speaker Pressable is invisible to VoiceOver/TalkBack; a custom
  // accessibility action on the row exposes the same toggle.
  const listeningAccessibilityActions = useMemo(
    () =>
      listeningState === null
        ? undefined
        : [{ name: "toggleListening", label: listeningActionLabel }],
    [listeningActionLabel, listeningState],
  );
  const onListeningAccessibilityAction = useCallback(
    (event: { readonly nativeEvent: { readonly actionName: string } }) => {
      if (event.nativeEvent.actionName === "toggleListening") toggleLoadedListeningTrack();
    },
    [],
  );
  // The speaker doubles as the transport control: with the loaded track's
  // message row off screen, tapping here pauses — and resumes, so pausing
  // from the list is never a one-way door.
  const listeningIndicator =
    listeningState !== null ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={listeningActionLabel}
        hitSlop={16}
        onPress={toggleListeningAudio}
      >
        <SymbolView
          name={listeningState === "playing" ? "speaker.wave.2.fill" : "speaker.fill"}
          size={12}
          style={listeningState === "paused" ? { opacity: 0.55 } : undefined}
          tintColor={selected ? selectedForegroundColor : pinTintColor}
          type="monochrome"
        />
      </Pressable>
    ) : null;

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleRename = useCallback(() => onRenameThread(thread), [onRenameThread, thread]);
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const handleSettle = useCallback(() => onSettleThread(thread), [onSettleThread, thread]);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  // A recycled cell reassigns this mounted row to a different thread without
  // remounting it, and the render closure stops running while list equality
  // says the item is unchanged — so any row-local UI state must be dismissed
  // when the identity under it changes. Without this, a custom snooze sheet
  // opened for one thread survives the thread's removal/reorder and its
  // submit snoozes whichever thread the cell was reassigned to. (ThreadSwipeable
  // enforces the same contract on the swipe layer with its resetKey.)
  const rowIdentity = `${thread.environmentId}:${thread.id}`;
  const [boundIdentity, setBoundIdentity] = useState(rowIdentity);
  if (boundIdentity !== rowIdentity) {
    setBoundIdentity(rowIdentity);
    setCustomSnoozeOpen(false);
  }
  const handleSnooze = useCallback(
    (snoozedUntil: string) => onSnoozeThread(thread, snoozedUntil),
    [onSnoozeThread, thread],
  );
  const handleUnsnooze = useCallback(() => onUnsnoozeThread(thread), [onUnsnoozeThread, thread]);
  const handleUnsettle = useCallback(() => onUnsettleThread(thread), [onUnsettleThread, thread]);
  const handlePin = useCallback(() => onPinThread(thread), [onPinThread, thread]);
  const handleUnpin = useCallback(() => onUnpinThread(thread), [onUnpinThread, thread]);
  const handleSetAutoSettle = useCallback(
    (enabled: boolean) => onSetThreadAutoSettle(thread, enabled),
    [onSetThreadAutoSettle, thread],
  );
  const handleMoveUp = useCallback(() => onMoveThread?.(thread, "up"), [onMoveThread, thread]);
  const handleMoveDown = useCallback(() => onMoveThread?.(thread, "down"), [onMoveThread, thread]);
  // The toggle itself resolves in onArchiveThread, which queues it offline.
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);
  const archiveMenuItem = useMemo<MenuAction>(
    () => ({
      ...MENU_ACTION_BY_ID.archive,
      title:
        archiveToggle === "cancel"
          ? "Cancel pending archive"
          : archiveToggle === "schedule"
            ? "Archive when done"
            : "Archive",
    }),
    [archiveToggle],
  );
  /** Replaces the static archive entry of a base menu list with the toggle-aware one. */
  const withArchiveToggle = useCallback(
    (actions: ReadonlyArray<MenuAction>) =>
      actions.map((action) => (action.id === "archive" ? archiveMenuItem : action)),
    [archiveMenuItem],
  );
  const handleFork = useCallback(() => onForkThread(thread), [onForkThread, thread]);
  const forkable = canForkConversation(thread, {
    canForkImportedSession: canForkImportedSessionWith(thread.providerInstanceId, props.providers),
  });

  // Swipe: the v2 primary action is the lifecycle transition. Un-settling a
  // settled row keeps it active until new activity clears the user override.
  const canUnsettle = variant === "slim";
  const [snoozeGateTick, bumpSnoozeGateTick] = useState(0);
  const snoozeGateExpiryMs = props.snoozeSupported
    ? resolveThreadListV2SnoozeGateExpiryMs(thread, { now: new Date().toISOString() })
    : null;
  useEffect(() => {
    if (snoozeGateExpiryMs === null) return;
    const delayMs = Math.min(Math.max(0, snoozeGateExpiryMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeGateTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
  }, [snoozeGateExpiryMs, snoozeGateTick]);
  const swipeActions = resolveThreadListV2SwipeActions({
    variant,
    settlementSupported: props.settlementSupported,
    snoozeSupported: props.snoozeSupported,
    snoozable: canSnooze(thread, { now: new Date().toISOString() }),
    snoozed: snoozedRow,
    pinnable: props.pinningSupported,
    pinned: pinnedRow,
    forkable,
  });
  const snoozePresets = useMemo(
    () => (swipeActions.secondary === "snooze" ? resolveSnoozePresets(new Date()) : ([] as const)),
    [props.snoozePresetMinute, swipeActions.secondary],
  );
  // Fork: "Until it's done" leads while the thread is working; it has no
  // clock, so it stays outside the timed preset resolution.
  const untilDoneOffered =
    swipeActions.secondary === "snooze" &&
    props.snoozeUntilDoneSupported === true &&
    canSnoozeUntilDone(thread);
  const snoozePresetActions = useMemo<MenuAction[]>(
    () => [
      ...(untilDoneOffered
        ? [
            {
              id: `snooze:${SNOOZE_UNTIL_DONE_PRESET.id}`,
              title: SNOOZE_UNTIL_DONE_PRESET.label,
              subtitle: SNOOZE_UNTIL_DONE_PRESET.whenLabel,
            },
          ]
        : []),
      ...snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
      { id: "snooze:custom", title: "Custom…" },
    ],
    [snoozePresets, untilDoneOffered],
  );
  // Pinned cards keep the full lifecycle menu; only the pin item flips to
  // Unpin. (Settling a pinned thread clears the pin server-side; snoozing
  // hides the card until wake with the pin intact.)
  const arrangementMenuItems = useMemo<MenuAction[]>(
    () => [
      ...(props.reorderSupported === true
        ? [
            { id: "arrange", title: "Arrange threads…", image: "line.3.horizontal" },
            {
              id: "move-up",
              title: "Move up",
              image: "arrow.up",
              attributes: { disabled: props.canMoveUp !== true },
            } satisfies MenuAction,
            {
              id: "move-down",
              title: "Move down",
              image: "arrow.down",
              attributes: { disabled: props.canMoveDown !== true },
            } satisfies MenuAction,
          ]
        : []),
      ...(props.pinningSupported
        ? [
            thread.pinnedAt != null
              ? { id: "unpin", title: "Unpin", image: "pin.slash" }
              : { id: "pin", title: "Pin", image: "pin" },
          ]
        : []),
    ],
    [
      props.canMoveDown,
      props.canMoveUp,
      props.reorderSupported,
      props.pinningSupported,
      thread.pinnedAt,
      variant,
    ],
  );
  // Menu twin for the swipe-right Fork action, so the gesture keeps a
  // long-press (and VoiceOver) equivalent wherever it is offered.
  const forkMenuItem = useMemo<MenuAction[]>(
    () =>
      forkable ? [{ id: "fork", title: "Fork conversation", image: "arrow.triangle.branch" }] : [],
    [forkable],
  );
  // A submenu with the current option checked, matching web. This is a
  // per-thread setting, not a lifecycle verb.
  const autoSettleMenuItems = useMemo<MenuAction[]>(
    () =>
      props.autoSettleOptOutSupported
        ? [
            {
              id: "auto-settle",
              title: "Auto-settle behavior",
              image: "timer",
              subactions: [
                {
                  id: "auto-settle:enabled",
                  title: "Enabled",
                  state: thread.autoSettleDisabledAt == null ? "on" : "off",
                },
                {
                  id: "auto-settle:disabled",
                  title: "Disabled",
                  state: thread.autoSettleDisabledAt == null ? "off" : "on",
                },
              ],
            } satisfies MenuAction,
          ]
        : [],
    [props.autoSettleOptOutSupported, thread.autoSettleDisabledAt],
  );
  const titleMenuItems = useMemo<MenuAction[]>(
    () => [
      { id: "rename", title: "Rename", image: "square.and.pencil" },
      ...buildThreadTitleRegenerationMenuItems({
        supported: props.titleRegenerationSupported,
        isRegenerating: thread.titleRegeneration != null,
      }),
    ],
    [props.titleRegenerationSupported, thread.titleRegeneration],
  );
  const snoozableCardMenuActions = useMemo<MenuAction[]>(
    () => [
      { id: "settle", title: "Settle", image: "checkmark" },
      {
        id: "snooze",
        title: "Snooze",
        image: "clock",
        subactions: snoozePresetActions,
      },
      archiveMenuItem,
      ...arrangementMenuItems,
      ...forkMenuItem,
      ...titleMenuItems,
      ...autoSettleMenuItems,
      MENU_ACTION_BY_ID.delete,
    ],
    [
      archiveMenuItem,
      arrangementMenuItems,
      autoSettleMenuItems,
      forkMenuItem,
      snoozePresetActions,
      titleMenuItems,
    ],
  );
  const cardMenuActions = useMemo<MenuAction[]>(
    () => [
      ...withArchiveToggle(CARD_MENU_ACTIONS.slice(0, -1)),
      ...arrangementMenuItems,
      ...forkMenuItem,
      ...titleMenuItems,
      ...autoSettleMenuItems,
      CARD_MENU_ACTIONS.at(-1)!,
    ],
    [arrangementMenuItems, autoSettleMenuItems, forkMenuItem, titleMenuItems, withArchiveToggle],
  );
  // Settled and snoozed rows keep the setting too, matching web where every
  // row shares one menu builder.
  const slimMenuActions = useMemo<MenuAction[]>(
    () => [
      ...withArchiveToggle(SLIM_MENU_ACTIONS.slice(0, -1)),
      ...arrangementMenuItems.filter(
        (action) => action.id !== "move-up" && action.id !== "move-down",
      ),
      ...forkMenuItem,
      ...titleMenuItems,
      ...autoSettleMenuItems,
      SLIM_MENU_ACTIONS.at(-1)!,
    ],
    [arrangementMenuItems, autoSettleMenuItems, forkMenuItem, titleMenuItems, withArchiveToggle],
  );
  const snoozedMenuActions = useMemo<MenuAction[]>(
    () => [
      ...withArchiveToggle(SNOOZED_MENU_ACTIONS.slice(0, -1)),
      ...titleMenuItems,
      ...autoSettleMenuItems,
      SNOOZED_MENU_ACTIONS.at(-1)!,
    ],
    [autoSettleMenuItems, titleMenuItems, withArchiveToggle],
  );
  const legacyMenuActions = useMemo<MenuAction[]>(
    () => [
      ...withArchiveToggle(LEGACY_MENU_ACTIONS.slice(0, -1)),
      ...arrangementMenuItems,
      ...titleMenuItems,
      LEGACY_MENU_ACTIONS.at(-1)!,
    ],
    [arrangementMenuItems, titleMenuItems, withArchiveToggle],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "new-thread-on-branch") onNewThreadOnBranch(thread);
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "unsnooze") handleUnsnooze();
      if (nativeEvent.event === "pin") handlePin();
      if (nativeEvent.event === "unpin") handleUnpin();
      if (nativeEvent.event === "auto-settle:enabled") handleSetAutoSettle(true);
      if (nativeEvent.event === "auto-settle:disabled") handleSetAutoSettle(false);
      if (nativeEvent.event === "arrange") appAtomRegistry.set(threadArrangementOpenAtom, true);
      if (nativeEvent.event === "move-up") handleMoveUp();
      if (nativeEvent.event === "move-down") handleMoveDown();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "fork") handleFork();
      if (nativeEvent.event === "rename") handleRename();
      if (nativeEvent.event === "regenerate-title") handleRegenerateTitle();
      if (nativeEvent.event === "copy-thread-id") {
        copyTextWithHaptic(thread.id, { target: "thread-id" });
      }
      if (nativeEvent.event === "delete") handleDelete();
      if (nativeEvent.event === "snooze:custom") {
        setCustomSnoozeOpen(true);
        return;
      }
      // The server still rejects it if the work ended meanwhile.
      if (nativeEvent.event === `snooze:${SNOOZE_UNTIL_DONE_PRESET.id}`) {
        onSnoozeThread(thread, null, { untilDone: true });
        return;
      }
      const snoozeSelection = resolveThreadListV2SnoozeMenuSelection({
        event: nativeEvent.event,
        displayedPresets: snoozePresets,
        now: new Date(),
      });
      if (snoozeSelection._tag === "selected") {
        handleSnooze(snoozeSelection.preset.snoozedUntil);
      } else if (snoozeSelection._tag === "expired") {
        Alert.alert("Could not snooze thread", "That snooze time has passed. Choose another time.");
      }
    },
    [
      onNewThreadOnBranch,
      thread,
      handleArchive,
      handleDelete,
      handleFork,
      handleRegenerateTitle,
      handleRename,
      handleMoveDown,
      handleMoveUp,
      handlePin,
      handleSettle,
      handleSnooze,
      handleSetAutoSettle,
      handleUnpin,
      handleUnsettle,
      handleUnsnooze,
      onSnoozeThread,
      setCustomSnoozeOpen,
      snoozePresets,
    ],
  );
  const primaryAction = useMemo(() => {
    // Pre-settlement server: archive is the swipe action, as in v1. (Slim
    // rows cannot occur here — unsupported environments never classify as
    // settled.)
    if (swipeActions.primary === "archive") {
      return {
        accessibilityLabel: `Archive ${thread.title}`,
        icon: "archivebox" as const,
        label: "Archive",
        onPress: handleArchive,
      };
    }
    if (swipeActions.primary === "unsnooze") {
      return {
        accessibilityLabel: `Wake ${thread.title} now`,
        icon: "clock" as const,
        label: "Wake",
        onPress: handleUnsnooze,
      };
    }
    return swipeActions.primary === "unsettle"
      ? {
          accessibilityLabel: `Un-settle ${thread.title}`,
          icon: "arrow.uturn.backward" as const,
          label: "Un-settle",
          onPress: handleUnsettle,
        }
      : {
          accessibilityLabel: `Settle ${thread.title}`,
          icon: "checkmark" as const,
          label: "Settle",
          onPress: handleSettle,
        };
  }, [
    handleArchive,
    handleSettle,
    handleUnsettle,
    handleUnsnooze,
    swipeActions.primary,
    thread.title,
  ]);
  const secondaryAction = useMemo(
    () =>
      swipeActions.secondary === "snooze"
        ? {
            accessibilityLabel: `Choose when to snooze ${thread.title}`,
            icon: "clock" as const,
            label: "Snooze",
            menu: {
              actions: snoozePresetActions,
              onPressAction: handleMenuAction,
              title: "Snooze until",
            },
            onPress: () => undefined,
          }
        : null,
    [handleMenuAction, snoozePresetActions, swipeActions.secondary, thread.title],
  );
  // Leading panel, ordered from the screen edge inward. Archive (through the
  // row's archive toggle) stays last so it remains what a full swipe right
  // commits. Tones keep each action distinct: pin is warning, fork is
  // secondary, archive is the panel's primary default.
  const leftActions = swipeActions.left.map((action) => {
    if (action === "pin" || action === "unpin") {
      const label = action === "pin" ? "Pin" : "Unpin";
      return {
        accessibilityLabel: `${label} ${thread.title}`,
        tone: "warning" as const,
        icon: action === "pin" ? ("pin" as const) : ("pin.slash" as const),
        label,
        onPress: action === "pin" ? handlePin : handleUnpin,
      };
    }
    if (action === "fork") {
      return {
        accessibilityLabel: `Fork ${thread.title}`,
        tone: "secondary" as const,
        icon: "arrow.triangle.branch" as const,
        label: "Fork",
        onPress: handleFork,
      };
    }
    return {
      accessibilityLabel:
        archiveToggle === "cancel"
          ? `Cancel pending archive of ${thread.title}`
          : archiveToggle === "schedule"
            ? `Archive ${thread.title} when done`
            : `Archive ${thread.title}`,
      icon: "archivebox" as const,
      label: archiveToggle === "cancel" ? "Keep" : "Archive",
      onPress: handleArchive,
    };
  });
  // What a full swipe right commits: the last leading action, following the
  // archive toggle (a pending archive is cancelled, a busy thread deferred).
  const lastLeftAction = swipeActions.left.at(-1);
  const fullSwipeHint =
    lastLeftAction === "fork"
      ? "forks the thread"
      : archiveToggle === "cancel"
        ? "cancels the pending archive"
        : archiveToggle === "schedule"
          ? "archives when the thread is done"
          : "archives";
  // Without operate access the row only opens the thread: no swipe actions.
  const swipeAccessibilityHint = !canOperateThread
    ? "Opens the thread"
    : [
        secondaryAction === null
          ? `Opens the thread. Swipe left to ${primaryAction.label.toLowerCase()}.`
          : `Opens the thread. Swipe left for ${primaryAction.label.toLowerCase()} and snooze actions.`,
        ...(leftActions.length === 0
          ? []
          : leftActions.length === 1
            ? [`Swipe right to ${leftActions[0]!.label.toLowerCase()}.`]
            : [
                `Swipe right for ${leftActions.map((action) => action.label.toLowerCase()).join(", ")}; a full swipe ${fullSwipeHint}.`,
              ]),
      ].join(" ");

  // Sidebar rows use navigation foregrounds on their active and idle surfaces.
  const cardContent = (
    <>
      <View className="flex-row items-center gap-1.5">
        {props.project ? (
          <ProjectFavicon
            environmentId={thread.environmentId}
            faviconPath={props.project.faviconPath}
            projectIcon={props.project.projectIcon}
            size={15}
            projectTitle={props.projectTitle ?? props.project.title}
            workspaceRoot={props.project.workspaceRoot}
          />
        ) : null}
        <Text
          className={cn(
            "flex-1 text-sm font-t3-medium",
            selected
              ? selectedThreadRowColors.mutedForegroundClassName
              : rowAppearance.mutedForegroundClassName,
          )}
          numberOfLines={1}
        >
          {props.projectTitle ?? props.project?.title ?? ""}
        </Text>
        {listeningIndicator}
        {archivePendingIcon}
        {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
        {pinnedRow ? (
          <SymbolView
            name="pin"
            size={11}
            tintColorClassName={rowAppearance.mutedIconTintClassName}
            type="monochrome"
          />
        ) : null}
        {statusLabel ? (
          <View className="flex-row items-center gap-1">
            <SymbolView
              name={statusLabel.icon}
              size={13}
              tintColorClassName={
                selected ? selectedThreadRowColors.iconTintClassName : statusLabel.iconTintClassName
              }
              type="monochrome"
              weight="semibold"
            />
            <Text
              className={cn(
                "text-xs font-t3-bold tabular-nums",
                selected ? selectedThreadRowColors.foregroundClassName : statusLabel.className,
              )}
            >
              {statusLabel.label}
              {/* Fork: Working rows show their elapsed time. */}
              {status === "working" && timeLabel !== "" ? ` ${timeLabel}` : null}
            </Text>
          </View>
        ) : (
          <Text
            className={cn(
              "text-xs tabular-nums",
              selected
                ? selectedThreadRowColors.foregroundClassName
                : rowAppearance.tertiaryForegroundClassName,
            )}
          >
            {timeLabel}
          </Text>
        )}
      </View>
      <Text
        className={cn(
          "mt-1 text-base",
          // Background work recedes to regular weight, matching web.
          !recede && "font-t3-medium",
          selected
            ? selectedThreadRowColors.foregroundClassName
            : rowAppearance.foregroundClassName,
        )}
        numberOfLines={2}
      >
        {thread.title}
      </Text>
      {props.searchMatch ? (
        <View className="mt-1">
          <ThreadSearchMatchExcerpt
            sidebar={sidebarPane}
            match={props.searchMatch}
            query={props.searchQuery ?? ""}
            selected={selected}
          />
        </View>
      ) : null}
      <View className="mt-1 flex-row items-center gap-2">
        {(status === "failed" || status === "limited") && thread.runtime?.lastError ? (
          <Text
            className={cn(
              "flex-1 text-xs",
              selected
                ? selectedThreadRowColors.mutedForegroundClassName
                : status === "limited"
                  ? "text-warning-foreground"
                  : "text-danger-foreground",
            )}
            numberOfLines={1}
          >
            {thread.runtime.lastError}
          </Text>
        ) : thread.branch || props.environmentLabel ? (
          /* "branch · machine" share one truncating line. The machine sits
             last so a tight fit cuts the repetitive label, not the branch —
             and machine-only fills the row for non-git projects. The glyph
             hugs the label (it cannot live inside the Text without breaking
             truncation), and the wrapper takes the slack so the trailers
             stay pinned right. */
          <View className="min-w-0 flex-1 flex-row items-center gap-1">
            <Text
              className={cn(
                "shrink text-xs",
                selected
                  ? selectedThreadRowColors.mutedForegroundClassName
                  : rowAppearance.mutedForegroundClassName,
              )}
              numberOfLines={1}
            >
              {thread.branch ? (
                <Text
                  className={cn(
                    "text-xs",
                    selected
                      ? selectedThreadRowColors.mutedForegroundClassName
                      : rowAppearance.mutedForegroundClassName,
                  )}
                  style={{ fontFamily: MONO_FONT }}
                >
                  {thread.branch}
                </Text>
              ) : null}
              {thread.branch && props.environmentLabel ? "  ·  " : null}
              {props.environmentLabel ? (
                <Text
                  className={cn(
                    "text-xs",
                    selected
                      ? selectedThreadRowColors.mutedForegroundClassName
                      : rowAppearance.tertiaryForegroundClassName,
                  )}
                >
                  {props.environmentLabel}
                </Text>
              ) : null}
            </Text>
            {props.environmentLabel && props.environmentMachine ? (
              <EnvironmentMachineSymbol
                kind={props.environmentMachine}
                size={11}
                tintColorClassName={
                  selected
                    ? selectedThreadRowColors.mutedIconTintClassName
                    : rowAppearance.tertiaryIconTintClassName
                }
              />
            ) : null}
          </View>
        ) : (
          <View className="flex-1" />
        )}
        {pr ? (
          <View className="flex-row items-center gap-1" accessibilityLabel={pr.accessibilityLabel}>
            <SymbolView
              name={pr.kind === "stack" ? "square.3.layers.3d" : "arrow.triangle.pull"}
              size={12}
              tintColorClassName={
                pr.state === null || pr.isDraft
                  ? rowAppearance.mutedIconTintClassName
                  : pr.state === "open"
                    ? "accent-adaptive-emerald-600-400"
                    : pr.state === "closed"
                      ? "accent-adaptive-rose-600-400"
                      : "accent-adaptive-violet-600-400"
              }
            />
            <Text
              accessibilityLabel={pr.accessibilityLabel}
              className={cn("text-xs", pr.textClassName)}
              style={{ fontFamily: MONO_FONT }}
            >
              {pr.label}
            </Text>
          </View>
        ) : null}
        {providerInstance ? (
          // Earlier owners peek out behind the current provider so a
          // handed-off thread shows where it has been. The current owner
          // keeps its account badge so same-driver instances stay distinct.
          <View className="flex-row items-center">
            {providerDrivers.slice(0, -1).map((driver, index) => (
              <View key={`${driver}:${index}`} className="-mr-1 opacity-30">
                <ProviderIcon provider={driver} size={12} />
              </View>
            ))}
            <ProviderInstanceIcon
              iconUrl={providerIconUrl}
              provider={providerInstance.driverKind}
              size={14}
              displayName={providerInstance.displayName}
              accentColor={providerInstance.accentColor}
              showBadge={providerInstance.showBadge}
              surfaceColor={rowAppearance.providerIconSurfaceColor}
            />
          </View>
        ) : null}
      </View>
    </>
  );

  // Snoozed rows keep their pin underneath; the glyph doubles as Unpin.
  const slimPinIndicator = !pinnedRow ? null : props.pinningSupported ? (
    <Pressable
      accessibilityLabel={`Unpin ${thread.title}`}
      accessibilityRole="button"
      hitSlop={8}
      onPress={(event) => {
        event.stopPropagation();
        handleUnpin();
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
    >
      <SymbolView
        name="pin"
        size={12}
        tintColor={selected ? selectedForegroundColor : pinTintColor}
        type="monochrome"
      />
    </Pressable>
  ) : (
    <SymbolView
      name="pin"
      size={12}
      tintColor={selected ? selectedForegroundColor : pinTintColor}
      type="monochrome"
    />
  );

  // Background work fades as a whole, status label included, so it takes
  // less attention than rows that need a human (input, approval, done).
  const fadedCardContent = recede ? (
    <View style={{ opacity: 0.55 }}>{cardContent}</View>
  ) : (
    cardContent
  );

  const rowContent = (close: () => void) =>
    variant === "card" ? (
      <RowPressable
        accessibilityActions={listeningAccessibilityActions}
        key={`${thread.environmentId}:${thread.id}`}
        interactionClassName={rowAppearance.interactionClassName}
        interactionOpacity={rowAppearance.interactionOpacity}
        className={rowAppearance.className}
        accessibilityHint={swipeAccessibilityHint}
        accessibilityLabel={rowAccessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onAccessibilityAction={onListeningAccessibilityAction}
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={rowAppearance.cardStyle}
      >
        {sidebarPane ? (
          <>
            {selected ? null : (
              <AccentTintOverlay accentColor={accentColor} borderRadius={SIDEBAR_V2_ROW_RADIUS} />
            )}
            {fadedCardContent}
          </>
        ) : (
          /* Flat native list rows: no tonal containers — colored status
             labels and text hierarchy carry state, an inset hairline
             separates rows. The opaque screen background stays so swipe
             actions reveal behind the row. */
          <View>
            <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>
              <AccentTintOverlay accentColor={accentColor} />
              {fadedCardContent}
            </View>
            {THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider !== false ? (
              <View className="ml-5 h-px bg-border-subtle" />
            ) : null}
          </View>
        )}
      </RowPressable>
    ) : (
      <RowPressable
        accessibilityActions={listeningAccessibilityActions}
        key={`${thread.environmentId}:${thread.id}`}
        interactionClassName={rowAppearance.interactionClassName}
        interactionOpacity={rowAppearance.interactionOpacity}
        accessibilityHint={swipeAccessibilityHint}
        accessibilityLabel={rowAccessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        className={rowAppearance.className}
        onAccessibilityAction={onListeningAccessibilityAction}
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={rowAppearance.style}
      >
        {/* Settled history recedes: dimmed favicon + muted title, and the
            project tint halves with it so the tail stays quiet. */}
        <View
          className={cn(
            "min-h-[44px] flex-row items-center gap-2.5 py-2",
            sidebarPane ? "px-3" : "px-5",
          )}
        >
          {selected ? null : (
            <AccentTintOverlay
              accentColor={accentColor}
              receded
              borderRadius={sidebarPane ? SIDEBAR_V2_ROW_RADIUS : undefined}
            />
          )}
          {props.project ? (
            <View className="opacity-40">
              <ProjectFavicon
                environmentId={thread.environmentId}
                faviconPath={props.project.faviconPath}
                projectIcon={props.project.projectIcon}
                size={15}
                projectTitle={props.projectTitle ?? props.project.title}
                workspaceRoot={props.project.workspaceRoot}
              />
            </View>
          ) : null}
          <View className="min-w-0 flex-1">
            <Text
              className={cn(
                "text-base",
                selected
                  ? selectedThreadRowColors.foregroundClassName
                  : rowAppearance.mutedForegroundClassName,
              )}
              numberOfLines={1}
            >
              {thread.title}
            </Text>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt
                sidebar={sidebarPane}
                match={props.searchMatch}
                query={props.searchQuery ?? ""}
                selected={selected}
              />
            ) : null}
          </View>
          {listeningIndicator}
          {slimPinIndicator}
          {archivePendingIcon}
          {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
          <Text
            className={cn(
              "text-sm tabular-nums",
              selected
                ? selectedThreadRowColors.mutedForegroundClassName
                : snoozedRow
                  ? rowAppearance.mutedForegroundClassName
                  : rowAppearance.tertiaryForegroundClassName,
            )}
            style={{ fontFamily: MONO_FONT }}
          >
            {snoozedRow && props.snoozeWakeLabelText !== undefined
              ? props.snoozeWakeLabelText
              : timeLabel}
          </Text>
        </View>
      </RowPressable>
    );

  if (!canOperateThread) return rowContent(() => {});

  return (
    <View collapsable={false}>
      {customSnoozeOpen && (
        <CustomSnoozeSheet onClose={() => setCustomSnoozeOpen(false)} onSnooze={handleSnooze} />
      )}
      <ThreadSwipeable
        dormant={dormant}
        threadKey={`${thread.environmentId}:${thread.id}`}
        backgroundColor={rowAppearance.swipeBackgroundColor}
        compactActions={variant === "slim"}
        containerStyle={rowAppearance.swipeContainerStyle}
        enableTrackpadSwipe
        // Full swipe commits the advertised lifecycle action (Settle /
        // Un-settle), never the secondary snooze action.
        fullSwipeAction="primary"
        fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
        leftActions={leftActions}
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={primaryAction}
        secondaryAction={secondaryAction}
        resetKey={`${thread.environmentId}:${thread.id}:${variant}:${snoozedRow}:${thread.settledAt}:${thread.unsettledAt}:${thread.snoozedUntil}:${leftActions.length}`}
        simultaneousWith={props.simultaneousSwipeGesture}
        threadTitle={thread.title}
      >
        {(close) => (
          <ControlPillMenu
            actions={[
              ...(thread.branch
                ? [
                    {
                      id: "new-thread-on-branch",
                      title: getThreadListV2NewBranchMenuTitle(thread.branch),
                      image: "square.and.pencil",
                    },
                  ]
                : []),
              { id: "copy-thread-id", title: "Copy thread ID", image: "doc.on.doc" },
              ...(snoozedRow
                ? snoozedMenuActions
                : !props.settlementSupported
                  ? legacyMenuActions
                  : canUnsettle
                    ? slimMenuActions
                    : swipeActions.secondary === "snooze"
                      ? snoozableCardMenuActions
                      : cardMenuActions),
            ]}
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            {rowContent(close)}
          </ControlPillMenu>
        )}
      </ThreadSwipeable>
    </View>
  );
});
