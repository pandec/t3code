import {
  resolveThreadReferenceCopyTarget,
  type ThreadReferenceCopyTarget,
} from "@t3tools/client-runtime/thread-reference";
import {
  foldSearchQuery,
  PALETTE_SECONDARY_LIMIT,
  PALETTE_THREAD_LIMIT,
  rankSearchGroups,
  scoreSearchTerms,
  scoreThreadSearch,
  type SearchMatchHint,
  type SearchRange,
  type ThreadSearchSubject,
} from "@t3tools/shared/paletteSearch";
import { threadSearchSubject } from "@t3tools/client-runtime/state/thread-search";
import type { CommandPaletteLinkedThreads } from "../commandPaletteBus";
import {
  addProjectRemoteSourceLabel,
  addProjectRemoteSourcePathHint,
  buildAddProjectRemoteSourceReadiness,
  type AddProjectRemoteSource,
  type AddProjectRemoteSourceReadiness,
} from "@t3tools/client-runtime/operations/projects";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type FilesystemBrowseEntry,
  type KeybindingCommand,
  type ScopedThreadRef,
  type SourceControlDiscoveryResult,
  type SourceControlRepositoryInfo,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { filterFilesystemBrowseEntries } from "@t3tools/client-runtime/state/filesystem";
import type {
  SavedPrompt,
  SidebarProjectAccentColor,
  TimestampFormat,
} from "@t3tools/contracts/settings";
import { type ReactNode } from "react";
import { parseSnoozeQuery } from "./CommandPalette.snooze";
import { type SnoozePreset } from "./Sidebar.snooze";
import {
  formatRelativeTimeLabel,
  formatShortTimestamp,
  parseTimestampDate,
} from "../timestampFormat";
import { type Project, type SidebarThreadSummary, type Thread } from "../types";
import { isSidebarSubagentThread } from "./Sidebar.logic";

export const RECENT_THREAD_LIMIT = 12;
export const ITEM_ICON_CLASS = "size-4 text-icon-muted";
export const ADDON_ICON_CLASS = "size-4";

export function buildThreadCopyActionItems(input: {
  threadId: string | null;
  reference: ThreadReferenceCopyTarget | null;
  icon: ReactNode;
  copy: (target: ThreadReferenceCopyTarget | null) => Promise<void>;
}): CommandPaletteActionItem[] {
  const items: CommandPaletteActionItem[] = [];
  if (input.threadId !== null) {
    const target = resolveThreadReferenceCopyTarget({ threadId: input.threadId });
    items.push({
      kind: "action",
      value: "action:copy-thread-id",
      searchTerms: ["copy", "thread id"],
      title: "Copy thread ID",
      description: input.threadId,
      icon: input.icon,
      shortcutCommand: "thread.copyId",
      run: () => input.copy(target),
    });
  }
  const reference = input.reference;
  if (reference?.kind === "pull-request") {
    items.push({
      kind: "action",
      value: "action:copy-thread-reference",
      searchTerms: ["copy", "pull request", "pr link", "reference"],
      title: "Copy PR link",
      description: reference.value,
      icon: input.icon,
      shortcutCommand: "thread.copyReference",
      run: () => input.copy(reference),
    });
  }
  return items;
}

export function buildLinkedThreadActionItems(
  input: CommandPaletteLinkedThreads & {
    query: string;
    icon: ReactNode;
    runThread: (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) => Promise<void>;
  },
): CommandPaletteActionItem[] {
  return input.threads.map((thread) => ({
    kind: "action",
    value: `thread:${input.environmentId}:${thread.id}`,
    title: thread.title || "Untitled thread",
    description: thread.archivedAt === null ? "Linked thread" : "Archived thread",
    searchTerms: [input.query, thread.title],
    icon: input.icon,
    run: () => input.runThread({ environmentId: input.environmentId, id: thread.id }),
  }));
}

export function browseInputEndPaddingClass(input: {
  readonly willCreateProjectPath: boolean;
  readonly hasHighlightedBrowseItem: boolean;
}): string {
  if (input.willCreateProjectPath) {
    return "*:data-[slot=autocomplete-input]:pe-38!";
  }
  if (input.hasHighlightedBrowseItem) {
    return "*:data-[slot=autocomplete-input]:pe-30!";
  }
  return "*:data-[slot=autocomplete-input]:pe-24!";
}

export type SearchOverlayMode = "command" | "files" | "content";

export type CommandPaletteOpenIntent =
  | {
      readonly kind:
        | "add-project"
        | "new-thread-in"
        | "change-theme"
        | "open-in-split"
        | "rename-thread"
        | "snooze-thread";
    }
  | {
      readonly kind: "search";
      readonly query: string;
      readonly linkedThreads?: CommandPaletteLinkedThreads;
    };

export interface CommandPaletteUiState {
  readonly open: boolean;
  readonly mode: SearchOverlayMode;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly parentSearch?: CommandPaletteReturnContext;
  readonly restoredSearch?: CommandPaletteReturnContext;
}

export type CommandPaletteUiAction =
  | { readonly _tag: "SetOpen"; readonly open: boolean }
  | { readonly _tag: "ToggleMode"; readonly mode: SearchOverlayMode }
  | {
      readonly _tag: "OpenSearch";
      readonly query: string;
      readonly linkedThreads?: CommandPaletteLinkedThreads;
    }
  | { readonly _tag: "OpenAddProject" }
  | { readonly _tag: "OpenNewThreadIn" }
  | { readonly _tag: "OpenChangeTheme" }
  | { readonly _tag: "OpenInSplit" }
  | { readonly _tag: "OpenRenameThread" }
  | { readonly _tag: "OpenSnoozeThread" }
  | { readonly _tag: "ClearOpenIntent" }
  | {
      readonly _tag: "OpenChildSearch";
      readonly mode: "files" | "content";
      readonly context: CommandPaletteReturnContext;
    }
  | { readonly _tag: "BackToCommand" };

export function reduceCommandPaletteUiState(
  state: CommandPaletteUiState,
  action: CommandPaletteUiAction,
): CommandPaletteUiState {
  switch (action._tag) {
    case "SetOpen":
      return action.open
        ? { open: true, mode: "command", openIntent: state.openIntent }
        : { open: false, mode: state.mode, openIntent: null };
    case "ToggleMode":
      return state.open && state.mode === action.mode
        ? { open: false, mode: state.mode, openIntent: null }
        : { open: true, mode: action.mode, openIntent: null };
    case "OpenChildSearch":
      return { open: true, mode: action.mode, openIntent: null, parentSearch: action.context };
    case "BackToCommand":
      return state.open && state.mode !== "command"
        ? {
            open: true,
            mode: "command",
            openIntent: null,
            ...(state.parentSearch ? { restoredSearch: state.parentSearch } : {}),
          }
        : state;
    case "OpenSearch":
      return {
        open: true,
        mode: "command",
        openIntent: {
          kind: "search",
          query: action.query,
          ...(action.linkedThreads ? { linkedThreads: action.linkedThreads } : {}),
        },
      };
    case "OpenAddProject":
      return { open: true, mode: "command", openIntent: { kind: "add-project" } };
    case "OpenNewThreadIn":
      return { open: true, mode: "command", openIntent: { kind: "new-thread-in" } };
    case "OpenChangeTheme":
      return { open: true, mode: "command", openIntent: { kind: "change-theme" } };
    case "OpenInSplit":
      return { open: true, mode: "command", openIntent: { kind: "open-in-split" } };
    case "OpenRenameThread":
      return { open: true, mode: "command", openIntent: { kind: "rename-thread" } };
    case "OpenSnoozeThread":
      return { open: true, mode: "command", openIntent: { kind: "snooze-thread" } };
    case "ClearOpenIntent":
      return state.openIntent ? { ...state, openIntent: null } : state;
  }
}

export interface CommandPaletteThreadContentMatch {
  readonly source: "user" | "assistant";
  readonly snippet: string;
  readonly query: string;
}

export interface CommandPaletteItem {
  readonly kind: "action" | "submenu";
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: ReactNode;
  /** The title as plain text, for searching, when `title` is styled. */
  readonly searchTitle?: string;
  readonly description?: ReactNode;
  readonly threadContentMatch?: CommandPaletteThreadContentMatch;
  readonly timestamp?: string;
  /** Thread rows rank by this, with use history, instead of by `searchTerms`. */
  readonly threadSearch?: ThreadSearchSubject;
  /** Shown in place of the description when the match is not in the title. */
  readonly matchHint?: SearchMatchHint;
  readonly icon: ReactNode;
  /** Optional project accent washed over this result row. */
  readonly projectAccentColor?: SidebarProjectAccentColor;
  readonly disabled?: boolean;
  readonly titleLeadingContent?: ReactNode;
  readonly titleTrailingContent?: ReactNode;
  readonly shortcutCommand?: KeybindingCommand;
  readonly secondary?: boolean;
}

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly kind: "action";
  readonly keepOpen?: boolean;
  readonly run: () => Promise<void>;
}

export interface CommandPaletteSubmenuItem extends CommandPaletteItem {
  readonly kind: "submenu";
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
}

export interface CommandPaletteView {
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

// Child search unmounts the palette; retain search data without its view closures.
export interface CommandPaletteReturnContext {
  readonly query: string;
  readonly linkedThreadSearch: Extract<CommandPaletteOpenIntent, { kind: "search" }> | null;
}

export interface CommandPaletteSearchState {
  readonly query: string;
  readonly views: ReadonlyArray<{
    readonly view: CommandPaletteView;
    readonly parentQuery: string;
  }>;
}

export function createCommandPaletteSearchState(query = ""): CommandPaletteSearchState {
  return { query, views: [] };
}

export function reduceCommandPaletteSearchState(
  state: CommandPaletteSearchState,
  action:
    | { readonly type: "query"; readonly query: string }
    | { readonly type: "push"; readonly view: CommandPaletteView }
    | { readonly type: "back" }
    | { readonly type: "reset"; readonly query?: string },
): CommandPaletteSearchState {
  switch (action.type) {
    case "query":
      return { ...state, query: action.query };
    case "push":
      return {
        query: action.view.initialQuery ?? "",
        views: [...state.views, { view: action.view, parentQuery: state.query }],
      };
    case "back": {
      const parent = state.views.at(-1);
      return parent ? { query: parent.parentQuery, views: state.views.slice(0, -1) } : state;
    }
    case "reset":
      return createCommandPaletteSearchState(action.query);
  }
}

export type CommandPaletteRow =
  | {
      readonly kind: "label";
      readonly key: string;
      readonly label: string;
      readonly first: boolean;
    }
  | {
      readonly kind: "item";
      readonly key: string;
      readonly item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
      readonly itemIndex: number | null;
    };

export function buildCommandPaletteRows(groups: ReadonlyArray<CommandPaletteGroup>) {
  const rows: CommandPaletteRow[] = [];
  const itemValues: string[] = [];
  const rowIndexByItemIndex: number[] = [];
  for (const group of groups) {
    if (group.label) {
      rows.push({
        kind: "label",
        key: `group:${group.value}`,
        label: group.label,
        first: rows.length === 0,
      });
    }
    for (const item of group.items) {
      const itemIndex = item.disabled ? null : itemValues.length;
      if (itemIndex !== null) {
        itemValues.push(item.value);
        rowIndexByItemIndex.push(rows.length);
      }
      rows.push({ kind: "item", key: `${group.value}:${item.value}`, item, itemIndex });
    }
  }
  return { rows, itemValues, rowIndexByItemIndex };
}

export function findHighlightedCommandPaletteItem(
  groups: ReadonlyArray<CommandPaletteGroup>,
  highlightedItemValue: string | null,
): CommandPaletteActionItem | CommandPaletteSubmenuItem | null {
  if (highlightedItemValue === null) return null;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.value === highlightedItemValue && !item.disabled) return item;
    }
  }
  return null;
}

export function enumerateCommandPaletteItems(
  items: ReadonlyArray<CommandPaletteActionItem>,
): CommandPaletteActionItem[] {
  return items.map((item, index) => {
    const shortcutCommand = THREAD_JUMP_KEYBINDING_COMMANDS[index];
    if (shortcutCommand) return { ...item, shortcutCommand };

    const { shortcutCommand: _shortcutCommand, ...itemWithoutShortcut } = item;
    return itemWithoutShortcut;
  });
}

export type CommandPaletteMode = "root" | "root-browse" | "submenu" | "submenu-browse";

export type CommandPaletteProject = Project & { readonly displayName: string };

export function buildCommandPaletteProjectMetadata(input: {
  readonly projects: ReadonlyArray<Pick<Project, "environmentId" | "title" | "workspaceRoot">>;
  readonly locationByEnvironmentId: ReadonlyMap<EnvironmentId, { readonly label: string }>;
}) {
  const searchTerms: string[] = [];
  const environmentLabels = new Set<string>();

  for (const project of input.projects) {
    const label = input.locationByEnvironmentId.get(project.environmentId)?.label ?? "Remote";
    searchTerms.push(project.title, project.workspaceRoot, label);
    environmentLabels.add(label);
  }

  return { searchTerms, environmentLabels: [...environmentLabels] };
}

export function buildProjectActionItems(input: {
  projects: ReadonlyArray<CommandPaletteProject>;
  valuePrefix: string;
  icon: (project: CommandPaletteProject) => ReactNode;
  runProject: (project: CommandPaletteProject) => Promise<void>;
  searchTerms?: (project: CommandPaletteProject) => ReadonlyArray<string>;
  renderDescription?: (project: CommandPaletteProject) => ReactNode;
  projectAccentColor?: (project: CommandPaletteProject) => SidebarProjectAccentColor | null;
  shortcutCommand?: KeybindingCommand;
  /** Reason a project cannot be picked; it replaces the description and disables the row. */
  disabledReason?: (project: CommandPaletteProject) => string | null;
}): CommandPaletteActionItem[] {
  return input.projects.map((project) => {
    const projectAccentColor = input.projectAccentColor?.(project) ?? null;
    const disabledReason = input.disabledReason?.(project) ?? null;
    return {
      kind: "action",
      value: `${input.valuePrefix}:${project.environmentId}:${project.id}`,
      searchTerms: [
        project.displayName,
        project.title,
        project.workspaceRoot,
        ...(input.searchTerms?.(project) ?? []),
      ],
      title: project.displayName,
      description: input.renderDescription?.(project) ?? project.workspaceRoot,
      icon: input.icon(project),
      ...(projectAccentColor !== null ? { projectAccentColor } : {}),
      ...(disabledReason !== null ? { disabled: true, description: disabledReason } : {}),
      ...(input.shortcutCommand !== undefined ? { shortcutCommand: input.shortcutCommand } : {}),
      run: async () => {
        await input.runProject(project);
      },
    };
  });
}

export const SAVED_PROMPTS_GROUP_VALUE = "saved-prompts";

export function savedPromptItemValue(prompt: SavedPrompt): string {
  return `saved-prompt:${prompt.id}`;
}

/** Prompt selection inserts; the palette handles primary-modifier+Enter to copy. */
export function buildSavedPromptsSubmenu(input: {
  prompts: ReadonlyArray<SavedPrompt>;
  promptPreview: (prompt: SavedPrompt) => string;
  itemIcon: ReactNode;
  addonIcon: ReactNode;
  insertPrompt: (prompt: SavedPrompt) => void;
}): CommandPaletteSubmenuItem | null {
  if (input.prompts.length === 0) {
    return null;
  }
  return {
    kind: "submenu",
    value: "action:prompts",
    searchTerms: ["prompts", "insert prompt", "copy prompt", "saved prompt", "snippet", "template"],
    title: "Prompts...",
    icon: input.itemIcon,
    addonIcon: input.addonIcon,
    groups: [
      {
        value: SAVED_PROMPTS_GROUP_VALUE,
        label: "Prompts",
        items: input.prompts.map((prompt) => ({
          kind: "action",
          value: savedPromptItemValue(prompt),
          searchTerms: [prompt.title, prompt.content],
          title: prompt.title,
          description: input.promptPreview(prompt),
          icon: input.itemIcon,
          keepOpen: true,
          run: async () => {
            input.insertPrompt(prompt);
          },
        })),
      },
    ],
  };
}

export function buildArchiveCurrentThreadAction(input: {
  threadRef: ScopedThreadRef | null;
  /** See `resolveArchiveToggleAction`; omitted means archive now. */
  archiveAction?: "archive" | "schedule" | "cancel";
  icon: ReactNode;
  runThread: (threadRef: ScopedThreadRef) => Promise<void>;
}): CommandPaletteActionItem | null {
  if (!input.threadRef) {
    return null;
  }
  const threadRef = input.threadRef;
  return {
    kind: "action",
    value: "action:archive-current-thread",
    searchTerms: ["archive", "close", "done", "finish", "current thread", "when done", "cancel"],
    title:
      input.archiveAction === "cancel"
        ? "Cancel pending archive"
        : input.archiveAction === "schedule"
          ? "Archive current thread when done"
          : "Archive current thread",
    icon: input.icon,
    shortcutCommand: "thread.archive",
    run: async () => {
      await input.runThread(threadRef);
    },
  };
}

/**
 * Per-thread actions the palette offers for the open thread, mirroring the
 * per-thread context menu. Ids are shared between the item builder and the
 * dispatcher so labels and handlers cannot drift apart.
 */
export type CommandPaletteThreadActionId =
  | "settle"
  | "unsettle"
  | "pin"
  | "unpin"
  | "mark-active"
  | "unmark-active"
  | "fork";

interface CommandPaletteThreadActionSpec {
  readonly id: CommandPaletteThreadActionId;
  readonly title: string;
  readonly searchTerms: ReadonlyArray<string>;
}

const THREAD_ACTION_SPECS = {
  settle: {
    id: "settle",
    title: "Settle current thread",
    searchTerms: ["settle", "done", "park", "current thread"],
  },
  unsettle: {
    id: "unsettle",
    title: "Un-settle current thread",
    searchTerms: ["unsettle", "un-settle", "reactivate", "keep active", "current thread"],
  },
  pin: {
    id: "pin",
    title: "Pin current thread",
    searchTerms: ["pin", "keep on top", "current thread"],
  },
  unpin: {
    id: "unpin",
    title: "Unpin current thread",
    searchTerms: ["unpin", "remove pin", "current thread"],
  },
  "mark-active": {
    id: "mark-active",
    title: "Mark current thread as active",
    searchTerms: ["mark active", "active", "zap", "focus", "current thread"],
  },
  "unmark-active": {
    id: "unmark-active",
    title: "Unmark current thread as active",
    searchTerms: ["unmark active", "active", "zap", "current thread"],
  },
  fork: {
    id: "fork",
    title: "Fork current thread",
    searchTerms: ["fork", "fork conversation", "branch", "duplicate", "current thread"],
  },
} as const satisfies Record<CommandPaletteThreadActionId, CommandPaletteThreadActionSpec>;

export function buildCurrentThreadActionItems(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly isPinned: boolean;
  readonly isActiveMarked?: boolean;
  readonly isSettled: boolean;
  /** Client-side twin of the server's settle invariants (no live/queued work). */
  readonly canSettleNow: boolean;
  readonly canFork: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly pinning: boolean;
    readonly activeMark?: boolean;
  };
  readonly icon: (id: CommandPaletteThreadActionId) => ReactNode;
  readonly run: (id: CommandPaletteThreadActionId, threadRef: ScopedThreadRef) => Promise<void>;
}): CommandPaletteActionItem[] {
  const threadRef = input.threadRef;
  if (!threadRef) {
    return [];
  }

  // One verb per lifecycle pair, resolved from the same state the sidebar row
  // and chat header menus resolve theirs from, so the three surfaces cannot
  // disagree about what the open thread is.
  const ids: CommandPaletteThreadActionId[] = [];
  if (input.supports.pinning) {
    ids.push(input.isPinned ? "unpin" : "pin");
  }
  if (input.supports.activeMark) {
    ids.push(input.isActiveMarked ? "unmark-active" : "mark-active");
  }
  if (input.supports.settlement) {
    ids.push(input.isSettled ? "unsettle" : "settle");
  }
  if (input.canFork) {
    ids.push("fork");
  }

  return ids.map((id) => {
    const spec: CommandPaletteThreadActionSpec = THREAD_ACTION_SPECS[id];
    return {
      kind: "action",
      value: `action:thread:${id}`,
      searchTerms: [...spec.searchTerms],
      title: spec.title,
      icon: input.icon(id),
      ...(id === "settle" && !input.canSettleNow
        ? { disabled: true, description: "Thread has running or pending work" }
        : {}),
      run: async () => {
        await input.run(id, threadRef);
      },
    };
  });
}

const MOVE_TO_GROUP_NONE_VALUE = "group:none";
export const RENAME_THREAD_VIEW_VALUE = "rename-thread";
export const SNOOZE_THREAD_VIEW_VALUE = "snooze-thread";

/** Keep shortcut intents pending until their thread and required capabilities arrive. */
export function resolveThreadUtilityOpenTarget(input: {
  readonly kind: "rename-thread" | "snooze-thread";
  readonly items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  readonly hasThreadTarget: boolean;
  readonly threadLoaded: boolean;
  readonly capabilitiesLoaded: boolean;
}): CommandPaletteActionItem | CommandPaletteSubmenuItem | "wait" | null {
  if (!input.hasThreadTarget) return null;
  if (!input.threadLoaded || (input.kind === "snooze-thread" && !input.capabilitiesLoaded)) {
    return "wait";
  }
  const command = input.kind === "rename-thread" ? "thread.rename" : "thread.snooze";
  return input.items.find((item) => item.shortcutCommand === command && !item.disabled) ?? null;
}

/** "Move thread to group…" submenu rows. The current group reads as such and
 * is disabled, so the list doubles as a "which group is this in" answer. */
export function buildMoveToGroupItems(input: {
  readonly groups: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** Group the moved threads share; undefined when they differ, so every row stays enabled. */
  readonly currentGroupId: string | null | undefined;
  readonly icon: ReactNode;
  readonly move: (groupId: string | null) => Promise<void>;
}): CommandPaletteActionItem[] {
  const entries: Array<{ id: string | null; name: string }> = [
    { id: null, name: "No group" },
    ...input.groups,
  ];
  return entries.map((entry) => {
    const current = entry.id === input.currentGroupId;
    return {
      kind: "action",
      value: entry.id === null ? MOVE_TO_GROUP_NONE_VALUE : `group:${entry.id}`,
      searchTerms: [entry.name],
      title: entry.name,
      icon: input.icon,
      ...(current ? { disabled: true, description: "Current group" } : {}),
      run: async () => {
        await input.move(entry.id);
      },
    };
  });
}

/**
 * The rename view is the palette input itself: the query is the draft title
 * and the single row commits it. Blank or unchanged drafts disable the row
 * rather than hide it so the view never goes empty while typing.
 */
export function buildRenameThreadViewItems(input: {
  readonly draft: string;
  readonly currentTitle: string;
  readonly canRegenerateTitle: boolean;
  readonly isRegeneratingTitle: boolean;
  readonly renameIcon: ReactNode;
  readonly regenerateIcon: ReactNode;
  readonly rename: (title: string) => Promise<void>;
  readonly regenerate: () => Promise<void>;
}): CommandPaletteActionItem[] {
  const title = input.draft.trim();
  const unchanged = title === input.currentTitle.trim();
  const items: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "rename-thread:commit",
      searchTerms: [],
      title: title.length === 0 ? "Rename to…" : `Rename to “${title}”`,
      icon: input.renameIcon,
      ...(title.length === 0
        ? { disabled: true, description: "Type a new title" }
        : unchanged
          ? { disabled: true, description: "Title is unchanged" }
          : {}),
      run: async () => {
        await input.rename(title);
      },
    },
  ];
  if (input.canRegenerateTitle) {
    items.push({
      kind: "action",
      value: "rename-thread:regenerate",
      searchTerms: [],
      title: "Regenerate title",
      icon: input.regenerateIcon,
      ...(input.isRegeneratingTitle
        ? { disabled: true, description: "Regenerating…" }
        : { description: "Let the agent pick a title from the conversation" }),
      run: input.regenerate,
    });
  }
  return items;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Wake time for a parsed snooze query, worded relative to today. */
function snoozeWakeDescription(
  snoozedUntil: string,
  now: Date,
  timestampFormat: TimestampFormat,
): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "";
  const time = formatShortTimestamp(wake.toISOString(), timestampFormat);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.floor((wake.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `tomorrow ${time}`;
  const weekday = wake.toLocaleDateString(undefined, { weekday: "short" });
  if (dayDelta < 7) return `${weekday} ${time}`;
  const date = wake.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date}, ${time}`;
}

/**
 * Snooze view rows: presets, "Custom…", and, when the query parses as a time
 * ("45m", "2pm", "fri 9am"), a synthesized row on top. That row's value
 * embeds the wake time so highlight state survives re-renders on each key.
 */
export function buildSnoozeThreadViewItems(input: {
  readonly query: string;
  readonly now: Date;
  readonly presets: ReadonlyArray<SnoozePreset>;
  readonly timestampFormat: TimestampFormat;
  readonly icon: ReactNode;
  readonly customIcon: ReactNode;
  /** Trailing wake-time column, rendered by the caller (this module is JSX-free). */
  readonly renderWhen: (whenLabel: string) => ReactNode;
  readonly snooze: (preset: Pick<SnoozePreset, "snoozedUntil" | "untilDone">) => Promise<void>;
  readonly custom: () => Promise<void>;
  /** Fork: shortcut hint for the "Until it's done" row. */
  readonly untilDoneShortcutCommand?: KeybindingCommand;
}): CommandPaletteActionItem[] {
  const items: CommandPaletteActionItem[] = [];
  const parsed = parseSnoozeQuery(input.query, input.now);
  if (parsed) {
    const wake = snoozeWakeDescription(parsed.snoozedUntil, input.now, input.timestampFormat);
    items.push({
      kind: "action",
      value: `snooze:parsed:${parsed.snoozedUntil}`,
      // Match whatever produced the parse so the filter keeps the row.
      searchTerms: [input.query],
      title: parsed.durationLabel ? `Snooze for ${parsed.durationLabel}` : `Snooze until ${wake}`,
      ...(parsed.durationLabel ? { description: `Wakes ${wake}` } : {}),
      icon: input.icon,
      run: async () => {
        await input.snooze({ snoozedUntil: parsed.snoozedUntil });
      },
    });
  }
  for (const preset of input.presets) {
    items.push({
      kind: "action",
      value: `snooze:${preset.id}`,
      searchTerms: [preset.label, preset.whenLabel],
      title: preset.label,
      icon: input.icon,
      titleTrailingContent: input.renderWhen(preset.whenLabel),
      ...(preset.untilDone === true && input.untilDoneShortcutCommand
        ? { shortcutCommand: input.untilDoneShortcutCommand }
        : {}),
      run: async () => {
        await input.snooze(preset);
      },
    });
  }
  items.push({
    kind: "action",
    value: "snooze:custom",
    searchTerms: ["custom", "pick", "date", "time"],
    title: "Custom…",
    description: "Pick a date and time",
    icon: input.customIcon,
    run: input.custom,
  });
  return items;
}

export function buildArchivedThreadsActionItems(input: {
  /** Logical group key of the open thread's project, when there is one. */
  readonly projectFilterKey: string | null;
  readonly projectTitle: string | null;
  readonly icon: ReactNode;
  readonly openArchived: (projectFilterKey: string | null) => Promise<void>;
}): CommandPaletteActionItem[] {
  const items: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "action:archived-threads",
      searchTerms: ["open archived threads", "archived", "archive", "history", "settings"],
      title: "Open archived threads",
      icon: input.icon,
      run: async () => {
        await input.openArchived(null);
      },
    },
  ];

  if (input.projectFilterKey !== null && input.projectTitle !== null) {
    const projectFilterKey = input.projectFilterKey;
    items.push({
      kind: "action",
      value: "action:archived-threads-in-project",
      searchTerms: [
        "open archived threads",
        "archived",
        "archive",
        "project",
        "current project",
        input.projectTitle,
      ],
      title: `Open archived threads in ${input.projectTitle}`,
      icon: input.icon,
      run: async () => {
        await input.openArchived(projectFilterKey);
      },
    });
  }

  return items;
}

export type BuildThreadActionItemsThread = Pick<
  SidebarThreadSummary,
  | "archivedAt"
  | "branch"
  | "createdAt"
  | "environmentId"
  | "id"
  | "lineage"
  | "modelSelection"
  | "projectId"
  | "runtime"
  | "title"
  | "worktreePath"
> &
  Partial<
    Pick<
      SidebarThreadSummary,
      "pullRequests" | "linkedPullRequest" | "branchPullRequest" | "opens" | "latestUserMessageAt"
    >
  > & {
    updatedAt: string;
  };

export function buildThreadActionItems<TThread extends BuildThreadActionItemsThread>(input: {
  threads: ReadonlyArray<TThread>;
  activeThread?: Pick<Thread, "environmentId" | "id">;
  projectByKey: ReadonlyMap<string, Pick<Project, "title">>;
  icon: ReactNode;
  renderLeadingContent?: (thread: TThread) => ReactNode;
  renderTrailingContent?: (thread: TThread) => ReactNode;
  renderDescription?: (thread: TThread, meta: { projectTitle: string | undefined }) => ReactNode;
  projectAccentColor?: (thread: TThread) => SidebarProjectAccentColor | null;
  runThread: (thread: TThread) => Promise<void>;
  /** Makes the environment searchable; pass it only with two or more environments. */
  environmentLabelOf?: (thread: TThread) => string | null;
}): CommandPaletteActionItem[] {
  // Callers order these: recents by last use, search results by rank.
  const visibleThreads = input.threads.filter(
    (thread) => thread.archivedAt === null && !isSidebarSubagentThread(thread),
  );

  return visibleThreads.map((thread) => {
    const projectTitle = input.projectByKey.get(
      `${thread.environmentId}:${thread.projectId}`,
    )?.title;
    const descriptionParts: string[] = [];

    if (projectTitle) {
      descriptionParts.push(projectTitle);
    }
    if (thread.branch) {
      descriptionParts.push(`#${thread.branch}`);
    }
    const isCurrent =
      thread.id === input.activeThread?.id &&
      thread.environmentId === input.activeThread.environmentId;
    if (isCurrent) {
      descriptionParts.push("Current thread");
    }

    const leadingContent = input.renderLeadingContent?.(thread);
    const trailingContent = input.renderTrailingContent?.(thread);
    const projectAccentColor = input.projectAccentColor?.(thread) ?? null;
    const description = input.renderDescription
      ? input.renderDescription(thread, { projectTitle })
      : descriptionParts.join(` · `);

    return Object.assign(
      {
        kind: "action" as const,
        value: `thread:${thread.environmentId}:${thread.id}`,
        searchTerms: [thread.title],
        threadSearch: threadSearchSubject(
          {
            ...thread,
            latestUserMessageAt: thread.latestUserMessageAt ?? null,
            opens: thread.opens ?? null,
          },
          projectTitle,
          input.environmentLabelOf?.(thread),
        ),
        title: thread.title,
        description,
        timestamp: formatRelativeTimeLabel(
          thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
        ),
        icon: input.icon,
      },
      leadingContent ? { titleLeadingContent: leadingContent } : {},
      trailingContent ? { titleTrailingContent: trailingContent } : {},
      projectAccentColor !== null ? { projectAccentColor } : {},
      // Last in its group: picking the thread already open does nothing.
      isCurrent ? { secondary: true } : {},
      {
        run: async () => {
          await input.runThread(thread);
        },
      },
    );
  });
}

type PaletteItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

function rankPaletteItem(
  item: PaletteItem,
  normalizedQuery: string,
  now: number,
  options: { readonly typos: boolean },
): {
  readonly score: number;
  readonly quality: number;
  readonly groupQuality?: number;
  readonly strong: boolean;
  readonly ranges: ReadonlyArray<SearchRange>;
  readonly explain?: () => SearchMatchHint | undefined;
  readonly pickedAt?: number;
  readonly pickedExactly?: boolean;
} | null {
  const match = scorePaletteItem(item, normalizedQuery, now, options);
  // A row listed last in its group (a keybinding setting, the open thread)
  // does not decide where the group sits.
  return match && item.secondary ? { ...match, groupQuality: 0 } : match;
}

function scorePaletteItem(
  item: PaletteItem,
  normalizedQuery: string,
  now: number,
  options: { readonly typos: boolean },
) {
  if (item.threadSearch) return scoreThreadSearch(normalizedQuery, item.threadSearch, now, options);
  // The title names the item; search terms are keywords. Ranges index the
  // first term, so they only highlight a title that is that term.
  const name = typeof item.title === "string" ? item.title : item.searchTitle;
  const terms =
    name !== undefined && name !== item.searchTerms[0]
      ? [name, ...item.searchTerms]
      : item.searchTerms;
  const match = scoreSearchTerms(normalizedQuery, terms, options);
  return match && (item.title === terms[0] ? match : { ...match, ranges: [] });
}

/**
 * Equal match classes put commands before threads, so "new" runs "New thread".
 * Server message matches stay in a final group so late results cannot move earlier rows.
 */
export function filterCommandPaletteGroups(input: {
  activeGroups: ReadonlyArray<CommandPaletteGroup>;
  query: string;
  isInSubmenu: boolean;
  /** Submenu options join the root search, and a submenu with no match falls back to it. */
  allOptions?: {
    readonly rootGroups: ReadonlyArray<CommandPaletteGroup>;
    readonly nestedItems: ReadonlyArray<CommandPaletteActionItem>;
  };
  projectSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  settingsSearchItems?: ReadonlyArray<CommandPaletteActionItem>;
  threadSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  /** Threads whose messages match, best first; threads already listed are skipped. */
  threadMessageItems?: ReadonlyArray<CommandPaletteActionItem>;
  now?: number;
}): CommandPaletteGroup[] {
  if (input.allOptions && input.isInSubmenu) {
    const { allOptions, ...submenuInput } = input;
    const scoped = filterCommandPaletteGroups(submenuInput);
    if (scoped.length > 0 || input.query.trim().length === 0) return scoped;
    return filterCommandPaletteGroups({
      ...input,
      activeGroups: allOptions.rootGroups,
      isInSubmenu: false,
    });
  }

  const isActionsFilter = input.query.startsWith(">");
  const searchQuery = isActionsFilter ? input.query.slice(1) : input.query;
  const normalizedQuery = foldSearchQuery(searchQuery);

  if (normalizedQuery.length === 0) {
    if (isActionsFilter) {
      return input.activeGroups.filter((group) => group.value === "actions");
    }
    return [...input.activeGroups];
  }

  let baseGroups = [...input.activeGroups];
  if (isActionsFilter) {
    baseGroups = baseGroups.filter((group) => group.value === "actions");
  } else if (!input.isInSubmenu) {
    baseGroups = baseGroups.filter((group) => group.value !== "recent-threads");
  }

  const searchableGroups = [...baseGroups];
  const searchesEverything = !input.isInSubmenu && !isActionsFilter;
  // On equal match classes, groups keep this order: threads, what people search
  // for most, right after commands.
  if (searchesEverything) {
    if (input.allOptions && input.allOptions.nestedItems.length > 0) {
      searchableGroups.push({
        value: "nested-search",
        label: "Suggestions",
        items: input.allOptions.nestedItems,
      });
    }
    if (input.threadSearchItems.length > 0) {
      searchableGroups.push({
        value: "threads-search",
        label: "Threads",
        items: input.threadSearchItems,
      });
    }
    if (input.projectSearchItems.length > 0) {
      searchableGroups.push({
        value: "projects-search",
        label: "Projects",
        items: input.projectSearchItems,
      });
    }
    if (input.settingsSearchItems && input.settingsSearchItems.length > 0) {
      searchableGroups.push({
        value: "settings-search",
        label: "Settings",
        items: input.settingsSearchItems,
      });
    }
  }

  const now = input.now ?? Date.now();
  const ranked = rankSearchGroups(
    searchableGroups.map((group) => ({ group, items: group.items })),
    (item, options) => rankPaletteItem(item, normalizedQuery, now, options),
  );
  const threadsMatch = ranked.some(({ group }) => group.value === "threads-search");
  const groups = ranked.map(({ group, ranked }): CommandPaletteGroup => {
    // Secondary items stay below the rest; the sort is stable, so score order holds.
    const limit =
      group.value === "threads-search"
        ? PALETTE_THREAD_LIMIT
        : group.value === "nested-search" || (searchesEverything && threadsMatch)
          ? PALETTE_SECONDARY_LIMIT
          : ranked.length;
    // Hints are built only for the rows shown.
    const items = ranked
      .toSorted(
        (left, right) =>
          Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false),
      )
      .slice(0, limit)
      .map(({ item, match }) => {
        if (match.ranges.length > 0) return item;
        // Built only for the rows shown.
        const matchHint = match.explain?.();
        return matchHint ? { ...item, matchHint } : item;
      });
    return { value: group.value, label: group.label, items };
  });

  if (!searchesEverything) return groups;
  const listed = new Set(groups.flatMap((group) => group.items.map((item) => item.value)));
  // The items arrive cut to what the palette shows; see `nextShownOrder`.
  const messageItems = (input.threadMessageItems ?? []).filter((item) => !listed.has(item.value));
  return messageItems.length === 0
    ? groups
    : [...groups, { value: "threads-messages", label: "In messages", items: messageItems }];
}

/** Every option inside a submenu as one row, e.g. "New thread in t3code" or "Change theme: Dracula". */
export function buildNestedSearchItems(
  items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>,
  query: string,
): CommandPaletteActionItem[] {
  const nameOf = (item: CommandPaletteItem) =>
    typeof item.title === "string" ? item.title : item.searchTitle;
  const topLevelNames = new Set(items.map(nameOf));
  const foldedQuery = foldSearchQuery(query);
  return items.flatMap((parent) => {
    if (parent.kind !== "submenu" || typeof parent.title !== "string") return [];
    const stem = parent.title.replace(/(\.\.\.|…)$/u, "");
    // A query that only names the submenu ("new thread in") wants the submenu row itself.
    if (foldSearchQuery(stem).startsWith(foldedQuery)) return [];
    const prefix = stem === parent.title ? `${stem}: ` : `${stem.trimEnd()} `;
    return parent.groups.flatMap((group) =>
      group.items.flatMap((child) => {
        const name = nameOf(child);
        if (child.kind !== "action" || name === undefined) return [];
        const title = `${prefix}${name}`;
        if (topLevelNames.has(title)) return [];
        const { searchTitle: _searchTitle, ...rest } = child;
        // Only the combined title: child keywords like "theme" would list every theme.
        return [{ ...rest, title, searchTerms: [title] }];
      }),
    );
  });
}

export function buildBrowseGroups(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  browseQuery: string;
  canBrowseUp: boolean;
  upIcon: ReactNode;
  directoryIcon: ReactNode;
  browseUp: () => void | Promise<void>;
  browseTo: (name: string) => void | Promise<void>;
}): CommandPaletteGroup[] {
  const items: CommandPaletteActionItem[] = [];

  if (input.canBrowseUp) {
    items.push({
      kind: "action",
      value: "browse:up",
      searchTerms: [input.browseQuery, ".."],
      title: "..",
      icon: input.upIcon,
      keepOpen: true,
      run: async () => {
        await input.browseUp();
      },
    });
  }

  for (const entry of input.browseEntries) {
    items.push({
      kind: "action",
      value: `browse:${entry.fullPath}`,
      searchTerms: [input.browseQuery, entry.fullPath, entry.name],
      title: entry.name,
      icon: input.directoryIcon,
      keepOpen: true,
      run: async () => {
        await input.browseTo(entry.name);
      },
    });
  }

  return [{ value: "directories", label: "Directories", items }];
}

export function filterPinnedBrowseEntries(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  filterQuery: string;
  pinnedDirectoryName: string;
  caseSensitive: boolean;
}): ReturnType<typeof filterFilesystemBrowseEntries> {
  const namesMatch = (left: string, right: string) =>
    input.caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase();
  const visibleFilterQuery = namesMatch(input.filterQuery, input.pinnedDirectoryName)
    ? ""
    : input.filterQuery;
  const { visibleEntries } = filterFilesystemBrowseEntries(input.browseEntries, visibleFilterQuery);
  const exactEntry =
    input.filterQuery.length > 0
      ? (input.browseEntries.find((entry) => namesMatch(entry.name, input.filterQuery)) ?? null)
      : null;
  return { visibleEntries, exactEntry };
}

export function getCommandPaletteMode(input: {
  currentView: CommandPaletteView | null;
  isBrowsing: boolean;
}): CommandPaletteMode {
  if (input.currentView) {
    return input.isBrowsing ? "submenu-browse" : "submenu";
  }
  return input.isBrowsing ? "root-browse" : "root";
}

export function buildRootGroups(input: {
  actionItems: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  recentThreadItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const groups: CommandPaletteGroup[] = [];
  if (input.actionItems.length > 0) {
    groups.push({ value: "actions", label: "Actions", items: input.actionItems });
  }
  if (input.recentThreadItems.length > 0) {
    groups.push({
      value: "recent-threads",
      label: "Recent Threads",
      items: input.recentThreadItems,
    });
  }
  return groups;
}

export function getCommandPaletteInputPlaceholder(mode: CommandPaletteMode): string {
  switch (mode) {
    case "root":
      return "Search commands, projects, and threads...";
    case "root-browse":
      return "Enter project path (e.g. ~/projects/my-app)";
    case "submenu":
      return "Search...";
    case "submenu-browse":
      return "Enter path (e.g. ~/projects/my-app)";
  }
}

export function getEnvironmentBrowsePlatform(os: string | null | undefined): string {
  if (os === "windows") {
    return "Win32";
  }
  if (os === "darwin") {
    return "MacIntel";
  }
  if (os === "linux") {
    return "Linux";
  }
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

export interface AddProjectEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
  readonly isPrimary: boolean;
  readonly isConnected: boolean;
  readonly status: string;
}

export type AddProjectCloneFlow =
  | {
      readonly step: "repository";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
    }
  | {
      readonly step: "confirm";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: SourceControlRepositoryInfo | null;
      readonly remoteUrl: string;
    };

export function remoteProjectInputPlaceholder(flow: AddProjectCloneFlow | null): string | null {
  if (!flow) return null;
  if (flow.step === "confirm") return null;
  if (flow.source === "url") {
    return "Enter Git clone URL";
  }
  return `Enter ${addProjectRemoteSourceLabel(flow.source)} repository (${addProjectRemoteSourcePathHint(flow.source)})`;
}

export function buildPaletteRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const readiness = buildAddProjectRemoteSourceReadiness(discovery);
  return (source) => {
    const entry = readiness(source);
    return entry.hint === null
      ? entry
      : {
          ...entry,
          hint: entry.hint.replace(
            "Open source control settings",
            "Open Settings -> Source control",
          ),
        };
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "An error occurred.";
}

const OVERLAY_MODE_BY_COMMAND = {
  "commandPalette.toggle": "command",
  "filePicker.toggle": "files",
  "projectSearch.toggle": "content",
} as const satisfies Partial<Record<string, SearchOverlayMode>>;

export function overlayModeForCommand(command: string | null): SearchOverlayMode | null {
  if (command === null) return null;
  return command in OVERLAY_MODE_BY_COMMAND
    ? OVERLAY_MODE_BY_COMMAND[command as keyof typeof OVERLAY_MODE_BY_COMMAND]
    : null;
}
