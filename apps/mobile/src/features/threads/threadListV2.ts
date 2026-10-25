import type { ThreadGroup } from "@t3tools/contracts";
import { threadGroupId, threadGroupSections } from "@t3tools/shared/threadGroups";
import { backgroundWorkLiveness } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  canSnooze,
  effectiveSnoozed,
  resolveSnoozePresets,
  snoozeWakeLabel,
  snoozeWakeSortMs,
  UNTIL_DONE_SNOOZE_LABEL,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadProviderStack } from "@t3tools/client-runtime/state/models";
import {
  threadSearchMatchKey,
  threadSearchSubject,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";
import {
  createInboxReturnTracker,
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";
import {
  sortActiveThreadsByOrderKey,
  resolveSettledThreadTimestamp,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import type { ThreadMoveAvailability } from "./threadOrder";

import { relativeTime } from "../../lib/time";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

import {
  applyPendingThreadOrder,
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "./threadOrder";

export { snoozeWakeLabel };

export const threadListInboxReturns = createInboxReturnTracker();

export function resolveThreadListV2ProviderDrivers(
  thread: Pick<EnvironmentThreadShell, "providerInstanceHistory" | "modelSelection" | "runtime">,
  providers: ReadonlyArray<ThreadListProvider> | undefined,
): ReadonlyArray<string> {
  if (providers === undefined) return [];
  const stack = resolveThreadProviderStack(thread);
  const drivers = stack.flatMap((instanceId) => {
    const driver = providers.find((provider) => provider.instanceId === instanceId)?.driver;
    return driver === undefined ? [] : [driver];
  });
  const currentDriver = providers.find(
    (provider) => provider.instanceId === stack[stack.length - 1],
  )?.driver;
  return currentDriver === undefined ? [] : drivers;
}

/**
 * Thread List v2 status, ported from the web sidebar v2. Ready is the unlabeled resting state.
 * Runtime parks at idle while a post-settlement roster remains: live agents or workflows read as
 * working and watch loops alone (dev servers, monitors) as monitoring, never a false Done.
 */
export type ThreadListV2Status =
  | "approval"
  | "input"
  | "request"
  | "working"
  | "monitoring"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";
export type ThreadListV2MenuActionId = "archive" | "delete" | "settle" | "unsettle";

const CARD_MENU_ACTION_IDS: ReadonlyArray<ThreadListV2MenuActionId> = [
  "settle",
  "archive",
  "delete",
];
const SLIM_MENU_ACTION_IDS: ReadonlyArray<ThreadListV2MenuActionId> = [
  "unsettle",
  "archive",
  "delete",
];
const LEGACY_MENU_ACTION_IDS: ReadonlyArray<ThreadListV2MenuActionId> = ["archive", "delete"];

export function resolveThreadListV2MenuActionIds(input: {
  readonly settlementSupported: boolean;
  readonly variant: "card" | "slim";
}): ReadonlyArray<ThreadListV2MenuActionId> {
  if (!input.settlementSupported) return LEGACY_MENU_ACTION_IDS;
  return input.variant === "slim" ? SLIM_MENU_ACTION_IDS : CARD_MENU_ACTION_IDS;
}

export type ThreadListV2SwipeAction = "archive" | "settle" | "unsettle" | "snooze" | "unsnooze";

export function resolveThreadListV2SnoozeMenuSelection(input: {
  readonly event: string;
  readonly displayedPresets: ReadonlyArray<SnoozePreset>;
  readonly now: Date;
}):
  | { readonly _tag: "selected"; readonly preset: SnoozePreset }
  | { readonly _tag: "expired" }
  | { readonly _tag: "not-snooze" } {
  if (!input.event.startsWith("snooze:")) return { _tag: "not-snooze" };

  const currentPreset = resolveSnoozePresets(input.now).find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (currentPreset) return { _tag: "selected", preset: currentPreset };

  const displayedPreset = input.displayedPresets.find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (displayedPreset && Date.parse(displayedPreset.snoozedUntil) > input.now.getTime()) {
    return { _tag: "selected", preset: displayedPreset };
  }
  return { _tag: "expired" };
}

export type ThreadListV2LeftSwipeAction = "pin" | "unpin" | "fork" | "archive";

export function resolveThreadListV2SwipeActions(input: {
  readonly variant: "card" | "slim";
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozable: boolean;
  readonly snoozed?: boolean;
  /** Server supports pinning. Pinned rows offer Unpin in its place. */
  readonly pinnable?: boolean;
  readonly pinned?: boolean;
  /** Thread's provider and session state allow forking the conversation. */
  readonly forkable?: boolean;
}): {
  readonly primary: Exclude<ThreadListV2SwipeAction, "snooze">;
  readonly secondary: "snooze" | null;
  /** Swipe-right actions, ordered from the screen's leading edge inward. The
      last entry is what a full swipe commits, so archive always stays the
      default. Empty where archive already owns the swipe-left primary
      (pre-settlement servers). */
  readonly left: readonly ThreadListV2LeftSwipeAction[];
} {
  // The snoozed shelf keeps its single archive action: pinning or forking a
  // sleeping thread has no twin in its row menu and no meaning on the shelf.
  if (input.snoozed === true) {
    return { primary: "unsnooze", secondary: null, left: ["archive"] };
  }
  const primary = input.settlementSupported
    ? input.variant === "slim"
      ? "unsettle"
      : "settle"
    : "archive";
  return {
    primary,
    secondary: input.snoozeSupported && input.snoozable ? "snooze" : null,
    left:
      primary === "archive"
        ? []
        : [
            // Pin follows the row menu, which only offers it on card rows.
            ...(input.pinnable === true && input.variant === "card"
              ? [input.pinned === true ? ("unpin" as const) : ("pin" as const)]
              : []),
            ...(input.forkable === true ? (["fork"] as const) : []),
            "archive" as const,
          ],
  };
}

export const THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10;
export const THREAD_LIST_V2_SETTLED_PAGE_COUNT = 25;

export function threadHasUnseenCompletion(
  thread: Pick<EnvironmentThreadShell, "latestRun" | "lastVisitedAt">,
): boolean {
  const completedAt = thread.latestRun?.completedAt;
  if (!completedAt) return false;
  const completedAtMs = Date.parse(completedAt);
  if (Number.isNaN(completedAtMs)) return false;
  if (!thread.lastVisitedAt) return false;
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAtMs)) return true;
  return completedAtMs > lastVisitedAtMs;
}

export function resolveThreadListV2WokeAt(
  thread: EnvironmentThreadShell,
  options: { readonly now: string },
): string | null {
  // Older servers cannot persist an acknowledgement.
  if (thread.lastVisitedAt === undefined || thread.settledOverride === "settled") return null;
  const wokeAt = threadWokeAt(thread, options);
  const wokeAtMs = Date.parse(wokeAt ?? "");
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt ?? "");
  return !Number.isNaN(wokeAtMs) && (Number.isNaN(lastVisitedAtMs) || lastVisitedAtMs < wokeAtMs)
    ? wokeAt
    : null;
}

export function resolveThreadListV2Status(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "runtime"
    | "blockedOnThreadWait"
  > & {
    readonly pendingBackgroundTasks?: EnvironmentThreadShell["pendingBackgroundTasks"] | undefined;
  },
): ThreadListV2Status {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  const liveness = backgroundWorkLiveness(thread.pendingBackgroundTasks ?? []);
  if (thread.runtime?.status === "idle") {
    return liveness ?? "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  // Fork: a command left running (a test run, a dev server) does not park the
  // runtime at idle, but the row still reads as Monitoring until it exits.
  return liveness ?? "ready";
}

function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortThreadsForListV2<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
    readonly activeOrderKey?: string | null | undefined;
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  return sortActiveThreadsByOrderKey(threads);
}

export function getThreadListV2OrderedSection(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly section: "pinned" | "active";
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly now: string;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
}): EnvironmentThreadShell[] {
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const threads = input.threads.filter((thread) => {
    if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent")
      return false;
    if (
      (input.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
      thread.settledOverride === "settled" &&
      queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) !== true
    ) {
      return false;
    }
    if (
      (input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) &&
      effectiveSnoozed(thread, { now: input.now })
    ) {
      return false;
    }
    return (thread.pinnedAt != null) === (input.section === "pinned");
  });
  const ordered =
    input.section === "pinned"
      ? sortPinnedThreadsByOrderKey(threads)
      : sortActiveThreadsByOrderKey(threads);
  const pending =
    input.pendingOrder?.section === input.section
      ? reconcilePendingThreadOrder(input.pendingOrder, ordered)
      : null;
  return applyPendingThreadOrder(ordered, input.section, pending);
}

export interface ThreadListV2Item {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  readonly snoozed: boolean;
  readonly pinned: boolean;
  readonly wokeAt: string | null;
  readonly isLast: boolean;
}

export interface ThreadListV2Layout {
  readonly items: ThreadListV2Item[];
  readonly hiddenSettledCount: number;
  /** Pinned threads matching the current filters, including rows hidden by
      collapse. */
  readonly pinnedCount: number;
  /** Pinned is always the leading block, so it gets a visibility flag rather than a header
      index. The header steps aside (and the collapse stops applying) while a search is active:
      folding rows the search asked for would answer a different question. */
  readonly pinnedShelfHeaderVisible: boolean;
  readonly workingCount: number;
  readonly workingShelfHeaderIndex: number | null;
  readonly snoozedCount: number;
  readonly snoozedShelfHeaderIndex: number | null;
  readonly settledCount: number;
  readonly settledShelfHeaderIndex: number | null;
  /** Arm a timeout here to repartition at snooze expiry rather than the next minute tick. */
  readonly nextSnoozeWakeAt: string | null;
  /** Threads listed only because their messages match the search. */
  readonly contentOnlyThreadKeys: ReadonlySet<string>;
}

export interface ThreadListV2ThreadListItem {
  readonly type: "v2-thread";
  readonly key: string;
  readonly item: ThreadListV2Item;
  readonly snoozeWakeLabelText: string | undefined;
  readonly timeLabel: string;
  readonly snoozePresetMinute: string | undefined;
  readonly showTrailingDivider: boolean;
  /** Include queued state in item equality; outbox writes do not update thread shells. */
  readonly hasQueuedMessages: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

export interface ThreadListV2PendingListItem {
  readonly type: "v2-pending";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  /** First unsent row after the active block draws the divider. */
  readonly showPendingDivider: boolean;
  readonly showTrailingDivider: boolean;
}

/** Closes the pinned block, matching the web sidebar. The shelf header above
    carries the label, so the divider stays unlabeled. */
export interface ThreadListV2PinnedDividerListItem {
  readonly type: "v2-pinned-divider";
  readonly key: "v2-pinned-divider";
}

/** Opens the pinned block: collapsible like the other shelves, expanded by
    default. */
export interface ThreadListV2PinnedShelfListItem {
  readonly type: "v2-pinned-shelf";
  readonly key: "v2-pinned-shelf";
  readonly count: number;
  readonly expanded: boolean;
}

export interface ThreadListV2WorkingShelfListItem {
  readonly type: "v2-working-shelf";
  readonly key: "v2-working-shelf";
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export interface ThreadListV2SnoozedShelfListItem {
  readonly type: "v2-snoozed-shelf";
  readonly key: "v2-snoozed-shelf";
  readonly count: number;
  readonly expanded: boolean;
  /** Include disabled state in item equality; recycled cells ignore render-closure updates. */
  readonly disabled: boolean;
}

export interface ThreadListV2SettledShelfListItem {
  readonly type: "v2-settled-shelf";
  readonly key: "v2-settled-shelf";
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

/** Fork: a custom group's header, or the built-in Active header (`groupId`
    null). Every group folds the same way. */
export interface ThreadListV2CustomGroupListItem {
  readonly type: "v2-custom-group";
  readonly key: string;
  readonly groupId: string | null;
  readonly name: string;
  readonly count: number;
  readonly expanded: boolean;
}

export type ThreadListV2ListItem =
  | ThreadListV2ThreadListItem
  | ThreadListV2PendingListItem
  | ThreadListV2CustomGroupListItem
  | ThreadListV2PinnedShelfListItem
  | ThreadListV2PinnedDividerListItem
  | ThreadListV2WorkingShelfListItem
  | ThreadListV2SnoozedShelfListItem
  | ThreadListV2SettledShelfListItem;

export function isThreadListV2ListItem(value: {
  readonly type: string;
}): value is ThreadListV2ListItem {
  return (
    value.type === "v2-thread" ||
    value.type === "v2-pending" ||
    value.type === "v2-custom-group" ||
    value.type === "v2-pinned-shelf" ||
    value.type === "v2-pinned-divider" ||
    value.type === "v2-working-shelf" ||
    value.type === "v2-snoozed-shelf" ||
    value.type === "v2-settled-shelf"
  );
}

/** Compare rebuilt items by content so minute ticks and partition runs do not re-render every mounted row. */
export function threadListV2ListItemsAreEqual(
  previous: ThreadListV2ListItem,
  item: ThreadListV2ListItem,
): boolean {
  switch (item.type) {
    case "v2-thread":
      return (
        previous.type === "v2-thread" &&
        previous.key === item.key &&
        previous.item.thread === item.item.thread &&
        previous.item.variant === item.item.variant &&
        previous.item.snoozed === item.item.snoozed &&
        previous.item.pinned === item.item.pinned &&
        previous.item.wokeAt === item.item.wokeAt &&
        previous.snoozeWakeLabelText === item.snoozeWakeLabelText &&
        previous.timeLabel === item.timeLabel &&
        previous.snoozePresetMinute === item.snoozePresetMinute &&
        previous.showTrailingDivider === item.showTrailingDivider &&
        previous.hasQueuedMessages === item.hasQueuedMessages &&
        previous.canMoveUp === item.canMoveUp &&
        previous.canMoveDown === item.canMoveDown
      );
    case "v2-pending":
      return (
        previous.type === "v2-pending" &&
        previous.key === item.key &&
        previous.pendingTask === item.pendingTask &&
        previous.showPendingDivider === item.showPendingDivider &&
        previous.showTrailingDivider === item.showTrailingDivider
      );
    case "v2-pinned-shelf":
      return (
        previous.type === "v2-pinned-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded
      );
    case "v2-pinned-divider":
      return previous.type === "v2-pinned-divider";
    case "v2-custom-group":
      return (
        previous.type === "v2-custom-group" &&
        previous.groupId === item.groupId &&
        previous.name === item.name &&
        previous.count === item.count &&
        previous.expanded === item.expanded
      );
    case "v2-working-shelf":
      return (
        previous.type === "v2-working-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-snoozed-shelf":
      return (
        previous.type === "v2-snoozed-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-settled-shelf":
      return (
        previous.type === "v2-settled-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
  }
}

/** The timestamp a row renders when it shows no status label: the settle
    stamp on settled slim rows, otherwise the latest activity. Blank for
    status-labelled or woke cards and snoozed rows with a wake countdown —
    those never draw it, so their minute tick must not invalidate the cell. */
function resolveThreadListV2ItemTimeLabel(
  item: ThreadListV2Item,
  showSnoozeWakeLabel: boolean,
): string {
  const { thread, variant, snoozed } = item;
  if (showSnoozeWakeLabel) return "";
  if (
    variant === "card" &&
    (resolveThreadListV2Status(thread) !== "ready" ||
      item.wokeAt !== null ||
      threadHasUnseenCompletion(thread))
  )
    return "";
  const settledTimestamp =
    variant === "slim" && !snoozed ? resolveSettledThreadTimestamp(thread) : null;
  return relativeTime(
    settledTimestamp ?? thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
  );
}

/**
 * Builds the shared mobile order: pending creations and drafts, pinned, active (with custom
 * groups), working shelf (beta, off by default), snoozed, and settled shelves.
 */
export function buildThreadListV2ListItems(input: {
  readonly items: ReadonlyArray<ThreadListV2Item>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  /** Fork: visible custom groups, laid out on the side of Active chosen on
      web or desktop. */
  readonly customGroups?: ReadonlyArray<ThreadGroup>;
  readonly collapsedGroupIds?: ReadonlySet<string>;
  /** False folds the built-in Active group; absent or true keeps it open. */
  readonly activeShelfExpanded?: boolean;
  /** `environmentId:threadId` of the open thread, which a folded group keeps. */
  readonly selectedThreadKey?: string | null;
  readonly pinnedCount?: number;
  readonly pinnedShelfExpanded?: boolean;
  /** False hides the pinned shelf header (search active) while its rows
      still render. Absent = header whenever anything is
      pinned; callers building from a real layout should always pass the
      layout's flag, or a collapsed shelf leaks into those modes. */
  readonly pinnedShelfHeaderVisible?: boolean;
  readonly workingCount?: number;
  readonly workingShelfExpanded?: boolean;
  readonly workingShelfHeaderIndex?: number | null;
  readonly snoozedCount?: number;
  readonly snoozedShelfExpanded?: boolean;
  readonly snoozedShelfHeaderIndex?: number | null;
  readonly settledCount?: number;
  readonly settledShelfExpanded?: boolean;
  readonly settledShelfHeaderIndex?: number | null;
  readonly snoozeLabelNow?: string;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  readonly moveAvailability?: ReadonlyMap<string, ThreadMoveAvailability>;
  readonly shelfPreferencesLoading?: boolean;
  /** Search results arrive ranked across shelves; grouping them would undo the ranking. */
  readonly searching?: boolean;
}): ThreadListV2ListItem[] {
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const threadItems = input.items.map((item): ThreadListV2ListItem => {
    const snoozeWakeLabelText =
      item.snoozed && item.thread.snoozedUntil != null && input.snoozeLabelNow !== undefined
        ? snoozeWakeLabel(item.thread.snoozedUntil, { now: input.snoozeLabelNow })
        : item.snoozed && item.thread.snoozedUntil == null
          ? UNTIL_DONE_SNOOZE_LABEL
          : undefined;
    // Put the clock on items so recycler equality limits ticks to rows displaying snooze preset times.
    const snoozePresetMinute =
      !item.snoozed &&
      input.snoozeLabelNow !== undefined &&
      (input.snoozeEnvironmentIds?.has(item.thread.environmentId) ?? true) &&
      canSnooze(item.thread)
        ? input.snoozeLabelNow
        : undefined;
    const move =
      item.variant === "card"
        ? input.moveAvailability?.get(`${item.thread.environmentId}:${item.thread.id}`)
        : undefined;
    return {
      type: "v2-thread",
      key: `v2-thread:${item.thread.environmentId}:${item.thread.id}`,
      item,
      snoozeWakeLabelText,
      timeLabel: resolveThreadListV2ItemTimeLabel(item, snoozeWakeLabelText !== undefined),
      snoozePresetMinute,
      showTrailingDivider: false,
      hasQueuedMessages:
        queuedThreadKeys?.has(`${item.thread.environmentId}:${item.thread.id}`) === true,
      canMoveUp: move?.canMoveUp === true,
      canMoveDown: move?.canMoveDown === true,
    };
  });
  const pendingTasks = [
    ...input.pendingTasks.filter((task) => task.kind === "pending"),
    ...input.pendingTasks.filter((task) => task.kind === "draft"),
  ];
  const pendingItems = pendingTasks.map((pendingTask, index): ThreadListV2ListItem => ({
    type: "v2-pending",
    key: `v2-${pendingTask.key}`,
    pendingTask,
    showPendingDivider: index === 0,
    showTrailingDivider: false,
  }));
  const workingCount = input.workingCount ?? 0;
  const workingShelfHeaderIndex = input.workingShelfHeaderIndex ?? null;
  const snoozedCount = input.snoozedCount ?? 0;
  const snoozedShelfHeaderIndex = input.snoozedShelfHeaderIndex ?? null;
  const settledCount = input.settledCount ?? 0;
  const settledShelfHeaderIndex = input.settledShelfHeaderIndex ?? null;
  const snoozedEnd = settledShelfHeaderIndex ?? threadItems.length;
  const workingEnd = snoozedShelfHeaderIndex ?? snoozedEnd;
  const activeEnd = workingShelfHeaderIndex ?? workingEnd;
  // Unsent drafts and queued tasks lead, as on web; pinned rows follow under their collapsible
  // header and close with the web sidebar's rule. Collapsed, only the open thread renders; during
  // a search the layout hides the header and the rows render unconditionally.
  let pinnedEnd = 0;
  while (pinnedEnd < activeEnd) {
    const item = threadItems[pinnedEnd];
    if (item?.type !== "v2-thread" || !item.item.pinned) break;
    pinnedEnd += 1;
  }
  const pinnedCount = input.pinnedCount ?? pinnedEnd;
  const pinnedShelfHeaderVisible = input.pinnedShelfHeaderVisible ?? true;
  const result: ThreadListV2ListItem[] = [...pendingItems];
  if (input.searching === true) {
    return withTrailingDividers([...result, ...threadItems]);
  }
  if (pinnedShelfHeaderVisible && pinnedCount > 0) {
    result.push({
      type: "v2-pinned-shelf",
      key: "v2-pinned-shelf",
      count: pinnedCount,
      expanded: input.pinnedShelfExpanded !== false,
    });
  }
  result.push(...threadItems.slice(0, pinnedEnd));
  if (pinnedEnd > 0) {
    result.push({ type: "v2-pinned-divider", key: "v2-pinned-divider" });
  }
  const activeItems = threadItems.slice(pinnedEnd, activeEnd);
  const customGroups = input.customGroups ?? [];
  const isSelected = (row: ThreadListV2ListItem) =>
    row.type === "v2-thread" &&
    `${row.item.thread.environmentId}:${row.item.thread.id}` === input.selectedThreadKey;
  // Fork: groups sit on the side of Active chosen on web or desktop. Every
  // group, Active included, folds the same way: rows hide while collapsed,
  // except the open thread. Without custom groups the Active header appears
  // only when it has rows, so an empty list still reads as empty.
  for (const group of threadGroupSections(customGroups)) {
    const id = group?.id ?? null;
    const rows = activeItems.filter(
      (item) => item.type === "v2-thread" && threadGroupId(item.item.thread, customGroups) === id,
    );
    if (group === null && rows.length === 0 && customGroups.length === 0) continue;
    const expanded =
      group === null
        ? input.activeShelfExpanded !== false
        : input.collapsedGroupIds?.has(group.id) !== true;
    result.push({
      type: "v2-custom-group",
      key: group === null ? "v2-active-header" : `v2-custom-group:${group.id}`,
      groupId: id,
      name: group?.name ?? "Active",
      count: rows.length,
      expanded,
    });
    result.push(...(expanded ? rows : rows.filter(isSelected)));
  }
  const shelfDisabled = input.shelfPreferencesLoading === true;
  if (workingShelfHeaderIndex !== null && workingCount > 0) {
    result.push({
      type: "v2-working-shelf",
      key: "v2-working-shelf",
      count: workingCount,
      expanded: input.workingShelfExpanded === true,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(workingShelfHeaderIndex, workingEnd));
  }
  if (snoozedShelfHeaderIndex !== null && snoozedCount > 0) {
    result.push({
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: snoozedCount,
      expanded: input.snoozedShelfExpanded === true,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(snoozedShelfHeaderIndex, snoozedEnd));
  }
  if (settledShelfHeaderIndex !== null && settledCount > 0) {
    result.push({
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: settledCount,
      expanded: input.settledShelfExpanded !== false,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(settledShelfHeaderIndex));
  }
  return withTrailingDividers(result);
}

function withTrailingDividers(result: ReadonlyArray<ThreadListV2ListItem>): ThreadListV2ListItem[] {
  return result.map((entry, index) => {
    if (entry.type !== "v2-thread" && entry.type !== "v2-pending") return entry;
    const next = result[index + 1];
    const showTrailingDivider =
      next?.type === "v2-thread" || (next?.type === "v2-pending" && !next.showPendingDivider);
    return showTrailingDivider === entry.showTrailingDivider
      ? entry
      : { ...entry, showTrailingDivider };
  });
}

// Immutable shells and field-only sorting make element-identical inputs produce identical output.
let lastSettledInput: ReadonlyArray<EnvironmentThreadShell> = [];
let lastSettledOutput: ReadonlyArray<EnvironmentThreadShell> = [];

function sortSettledThreadsReusingLast(
  settled: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  if (settled.length === lastSettledInput.length) {
    let same = true;
    for (let index = 0; index < settled.length; index += 1) {
      if (settled[index] !== lastSettledInput[index]) {
        same = false;
        break;
      }
    }
    if (same) return lastSettledOutput;
  }
  lastSettledInput = settled;
  lastSettledOutput = sortSettledThreads(settled);
  return lastSettledOutput;
}

export function buildThreadListV2Items(input: {
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  readonly searchQuery: string;
  readonly matchedThreadKeys?: ReadonlySet<string>;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly settledLimit?: number;
  readonly now: string;
  readonly workingShelfEnabled?: boolean;
  readonly workingShelfExpanded?: boolean;
  readonly inboxReturnAt?: (thread: EnvironmentThreadShell) => number | undefined;
  readonly snoozedShelfExpanded?: boolean;
  readonly settledShelfExpanded?: boolean;
  /** Expands the pinned block into rows. Expanded is the default. */
  readonly pinnedShelfExpanded?: boolean;
  readonly selectedThreadKey?: string | null;
  readonly queuedThreadKeys?: ReadonlySet<string>;
}): ThreadListV2Layout {
  const now = input.now;
  const pending =
    input.pendingOrder == null
      ? null
      : reconcilePendingThreadOrder(
          input.pendingOrder,
          getThreadListV2OrderedSection({
            ...input,
            section: input.pendingOrder.section,
            pendingOrder: null,
          }),
        );
  const query = foldSearchQuery(input.searchQuery);
  const nowMs = Date.parse(now);
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;

  const workingShelfEnabled = input.workingShelfEnabled === true;
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  let nextSnoozeWakeAt: string | null = null;
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const listedThreads = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.lineage.relationshipToParent !== "subagent" &&
      (input.environmentId === null || thread.environmentId === input.environmentId) &&
      (projectKeys === null || projectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
  // The same matches as the command palette, typo fallback included. Only
  // listed threads are ranked: a hidden exact match must not turn typos off.
  const rankedMatches =
    query.length > 0
      ? rankSearchItems(listedThreads, (thread, options) =>
          scoreThreadSearch(query, threadSearchSubject(thread, null), nowMs, {
            ...options,
            picks: false,
          }),
        ).map(({ item }) => item)
      : null;
  const matchingThreads = rankedMatches === null ? null : new Set(rankedMatches);
  // Threads listed only because their messages match; only their rows show
  // the message and open at it.
  const contentOnlyThreadKeys = new Set<string>();
  for (const thread of listedThreads) {
    if (matchingThreads !== null && !matchingThreads.has(thread)) {
      const key = threadSearchMatchKey({
        environmentId: thread.environmentId,
        threadId: thread.id,
      });
      if (input.matchedThreadKeys?.has(key) !== true) continue;
      contentOnlyThreadKeys.add(key);
    }
    const supportsSettlement = input.settlementEnvironmentIds?.has(thread.environmentId) ?? true;
    const supportsSnooze = input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true;
    if (supportsSnooze && effectiveSnoozed(thread, { now })) {
      snoozed.push(thread);
      if (
        thread.snoozedUntil != null &&
        (nextSnoozeWakeAt === null ||
          parseTimestampMs(thread.snoozedUntil) < parseTimestampMs(nextSnoozeWakeAt))
      ) {
        nextSnoozeWakeAt = thread.snoozedUntil;
      }
      continue;
    }
    const hasQueuedMessages =
      queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) === true;
    if (supportsSettlement && thread.settledOverride === "settled" && !hasQueuedMessages) {
      settled.push(thread);
    } else if (thread.pinnedAt != null) {
      pinned.push(thread);
    } else if (workingShelfEnabled && isThreadWorking(thread)) {
      working.push(thread);
    } else {
      active.push(thread);
    }
  }

  if (rankedMatches !== null) {
    // Searching lists every match by rank across shelves, as the palette and
    // the web sidebar do, then threads listed for their messages in the
    // server's order. Each row keeps its shelf's look.
    const slim = new Set([...snoozed, ...settled]);
    const snoozedThreads = new Set(snoozed);
    const pinnedThreads = new Set(pinned);
    const threadByKey = new Map(
      listedThreads.map((thread) => [
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
        thread,
      ]),
    );
    const contentOnly = [...(input.matchedThreadKeys ?? [])].flatMap((key) => {
      const thread = contentOnlyThreadKeys.has(key) ? threadByKey.get(key) : undefined;
      return thread ? [thread] : [];
    });
    const results = [...rankedMatches, ...contentOnly];
    return {
      items: results.map((thread, index) => ({
        thread,
        variant: slim.has(thread) ? "slim" : "card",
        snoozed: snoozedThreads.has(thread),
        pinned: pinnedThreads.has(thread),
        wokeAt: slim.has(thread) ? null : resolveThreadListV2WokeAt(thread, { now }),
        isLast: index === results.length - 1,
      })),
      hiddenSettledCount: 0,
      pinnedCount: pinned.length,
      pinnedShelfHeaderVisible: false,
      workingCount: 0,
      workingShelfHeaderIndex: null,
      snoozedCount: 0,
      snoozedShelfHeaderIndex: null,
      settledCount: 0,
      settledShelfHeaderIndex: null,
      nextSnoozeWakeAt,
      contentOnlyThreadKeys,
    };
  }

  const orderedActive = workingShelfEnabled
    ? sortInboxThreadsByReturn(active, input.inboxReturnAt)
    : applyPendingThreadOrder(sortThreadsForListV2(active), "active", pending);
  const orderedWorking = sortWorkingThreadsBySend(working);
  const orderedSnoozed = [...snoozed].sort(
    (left, right) => snoozeWakeSortMs(left) - snoozeWakeSortMs(right),
  );
  const selectedThreadKey = input.selectedThreadKey ?? null;
  const visibleWorking =
    input.workingShelfExpanded === true
      ? orderedWorking
      : orderedWorking.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );
  const visibleSnoozed =
    input.snoozedShelfExpanded === true
      ? orderedSnoozed
      : orderedSnoozed.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );
  const orderedSettled = sortSettledThreadsReusingLast(settled);
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const limitedSettled =
    orderedSettled.length > settledLimit ? orderedSettled.slice(0, settledLimit) : orderedSettled;
  const selectedSettled =
    selectedThreadKey === null
      ? undefined
      : orderedSettled
          .slice(limitedSettled.length)
          .find((thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey);
  const pagedSettled =
    selectedSettled === undefined ? limitedSettled : [...limitedSettled, selectedSettled];
  const visibleSettled =
    input.settledShelfExpanded !== false
      ? pagedSettled
      : pagedSettled.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );

  const orderedPinned = applyPendingThreadOrder(
    sortPinnedThreadsByOrderKey(pinned),
    "pinned",
    pending,
  );
  // The collapse must never hide rows a search asked for, so the shelf only
  // folds (and only draws its header) outside a search.
  const pinnedShelfCollapsible = query.length === 0;
  const visiblePinned =
    !pinnedShelfCollapsible || input.pinnedShelfExpanded !== false
      ? orderedPinned
      : orderedPinned.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );

  const items: ThreadListV2Item[] = [];
  for (const thread of visiblePinned) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: true,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
      isLast: false,
    });
  }
  for (const thread of orderedActive) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: false,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
      isLast: false,
    });
  }
  const workingShelfHeaderIndex = orderedWorking.length > 0 ? items.length : null;
  for (const thread of visibleWorking) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: false,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
      isLast: false,
    });
  }
  const snoozedShelfHeaderIndex = orderedSnoozed.length > 0 ? items.length : null;
  for (const thread of visibleSnoozed) {
    items.push({
      thread,
      variant: "slim",
      snoozed: true,
      // The pin survives a snooze: the row shows its glyph and offers Unpin.
      pinned: thread.pinnedAt != null,
      wokeAt: null,
      isLast: false,
    });
  }
  const settledShelfHeaderIndex = orderedSettled.length > 0 ? items.length : null;
  for (const thread of visibleSettled) {
    items.push({
      thread,
      variant: "slim",
      snoozed: false,
      pinned: false,
      wokeAt: null,
      isLast: false,
    });
  }
  const last = items.at(-1);
  if (last) {
    items[items.length - 1] = { ...last, isLast: true };
  }
  return {
    items,
    hiddenSettledCount: orderedSettled.length - pagedSettled.length,
    pinnedCount: orderedPinned.length,
    pinnedShelfHeaderVisible: orderedPinned.length > 0 && pinnedShelfCollapsible,
    workingCount: orderedWorking.length,
    workingShelfHeaderIndex,
    snoozedCount: orderedSnoozed.length,
    snoozedShelfHeaderIndex,
    settledCount: orderedSettled.length,
    settledShelfHeaderIndex,
    nextSnoozeWakeAt,
    contentOnlyThreadKeys,
  };
}
