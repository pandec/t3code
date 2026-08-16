import {
  type FilesystemBrowseEntry,
  type KeybindingCommand,
  type ScopedThreadRef,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { filterFilesystemBrowseEntries } from "@t3tools/client-runtime/state/filesystem";
import type {
  SavedPrompt,
  SidebarProjectAccentColor,
  SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { type ReactNode } from "react";
import { sortThreads } from "../lib/threadSort";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { type Project, type SidebarThreadSummary, type Thread } from "../types";

export const RECENT_THREAD_LIMIT = 12;
export const ITEM_ICON_CLASS = "size-4 text-icon-muted";
export const ADDON_ICON_CLASS = "size-4";

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

/**
 * The global search overlay hosts three mutually exclusive surfaces: the
 * command palette (⌘K), the project file picker (⌘P), and project content
 * search (⇧⌘F). One reducer owns open/mode state so the surfaces can never
 * stack and re-triggering a mode's shortcut toggles it closed.
 */
export type SearchOverlayMode = "command" | "files" | "content";

export interface CommandPaletteOpenIntent {
  readonly kind: "add-project" | "new-thread-in";
}

export interface CommandPaletteUiState {
  readonly open: boolean;
  readonly mode: SearchOverlayMode;
  readonly openIntent: CommandPaletteOpenIntent | null;
}

export type CommandPaletteUiAction =
  | { readonly _tag: "SetOpen"; readonly open: boolean }
  | { readonly _tag: "ToggleMode"; readonly mode: SearchOverlayMode }
  | { readonly _tag: "OpenAddProject" }
  | { readonly _tag: "OpenNewThreadIn" }
  | { readonly _tag: "ClearOpenIntent" };

export function reduceCommandPaletteUiState(
  state: CommandPaletteUiState,
  action: CommandPaletteUiAction,
): CommandPaletteUiState {
  switch (action._tag) {
    case "SetOpen":
      return {
        open: action.open,
        mode: "command",
        openIntent: action.open ? state.openIntent : null,
      };
    case "ToggleMode":
      return state.open && state.mode === action.mode
        ? { open: false, mode: "command", openIntent: null }
        : { open: true, mode: action.mode, openIntent: null };
    case "OpenAddProject":
      return { open: true, mode: "command", openIntent: { kind: "add-project" } };
    case "OpenNewThreadIn":
      return { open: true, mode: "command", openIntent: { kind: "new-thread-in" } };
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
  readonly description?: ReactNode;
  readonly threadContentMatch?: CommandPaletteThreadContentMatch;
  readonly timestamp?: string;
  readonly icon: ReactNode;
  /** Optional project accent washed over this result row. */
  readonly projectAccentColor?: SidebarProjectAccentColor;
  readonly disabled?: boolean;
  /** Optional content rendered inline before the title text. */
  readonly titleLeadingContent?: ReactNode;
  /** Optional content rendered inline after the title text (before the timestamp). */
  readonly titleTrailingContent?: ReactNode;
  readonly shortcutCommand?: KeybindingCommand;
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

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildProjectActionItems(input: {
  projects: ReadonlyArray<Project>;
  valuePrefix: string;
  icon: (project: Project) => ReactNode;
  runProject: (project: Project) => Promise<void>;
  searchTerms?: (project: Project) => ReadonlyArray<string>;
  projectAccentColor?: (project: Project) => SidebarProjectAccentColor | null;
  shortcutCommand?: KeybindingCommand;
}): CommandPaletteActionItem[] {
  return input.projects.map((project) => {
    const projectAccentColor = input.projectAccentColor?.(project) ?? null;
    return {
      kind: "action",
      value: `${input.valuePrefix}:${project.environmentId}:${project.id}`,
      searchTerms: [project.title, project.workspaceRoot, ...(input.searchTerms?.(project) ?? [])],
      title: project.title,
      description: project.workspaceRoot,
      icon: input.icon(project),
      ...(projectAccentColor !== null ? { projectAccentColor } : {}),
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

/**
 * The ⌘K "Prompts..." submenu. Enter runs `copyPrompt` on the picked item;
 * the palette's keydown handler additionally offers primary-modifier+Enter
 * to insert the highlighted prompt into the composer. Note the submenu
 * snapshots its items when pushed — only the insert path re-resolves against
 * the live library, so a library change while the submenu is open can make
 * the two keys briefly disagree.
 */
export function buildSavedPromptsSubmenu(input: {
  prompts: ReadonlyArray<SavedPrompt>;
  promptPreview: (prompt: SavedPrompt) => string;
  itemIcon: ReactNode;
  addonIcon: ReactNode;
  copyPrompt: (prompt: SavedPrompt) => Promise<void>;
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
          run: async () => {
            await input.copyPrompt(prompt);
          },
        })),
      },
    ],
  };
}

export function buildArchiveCurrentThreadAction(input: {
  threadRef: ScopedThreadRef | null;
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
    searchTerms: ["archive", "close", "done", "finish", "current thread"],
    title: "Archive current thread",
    icon: input.icon,
    shortcutCommand: "thread.archive",
    run: async () => {
      await input.runThread(threadRef);
    },
  };
}

export function buildMoveCurrentThreadToTopAction(input: {
  threadRef: ScopedThreadRef | null;
  icon: ReactNode;
  runThread: (threadRef: ScopedThreadRef) => void | Promise<void>;
}): CommandPaletteActionItem | null {
  if (!input.threadRef) {
    return null;
  }
  const threadRef = input.threadRef;
  return {
    kind: "action",
    value: "action:move-current-thread-to-top",
    searchTerms: ["move", "top", "raise", "current thread"],
    title: "Move current thread to top",
    icon: input.icon,
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
  | "fork"
  | "copy-thread-id";

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
  fork: {
    id: "fork",
    title: "Fork current thread",
    searchTerms: ["fork", "fork conversation", "branch", "duplicate", "current thread"],
  },
  "copy-thread-id": {
    id: "copy-thread-id",
    title: "Copy current thread ID",
    searchTerms: ["copy thread id", "thread id", "identifier", "clipboard", "current thread"],
  },
} as const satisfies Record<CommandPaletteThreadActionId, CommandPaletteThreadActionSpec>;

export function buildCurrentThreadActionItems(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  /** Client-side twin of the server's settle invariants (no live/queued work). */
  readonly canSettleNow: boolean;
  readonly canFork: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly pinning: boolean;
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
  if (input.supports.settlement) {
    ids.push(input.isSettled ? "unsettle" : "settle");
  }
  if (input.canFork) {
    ids.push("fork");
  }
  ids.push("copy-thread-id");

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

export function buildArchivedThreadsActionItems(input: {
  /** Scoped project key of the open thread's project, when there is one. */
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
  | "modelSelection"
  | "projectId"
  | "session"
  | "title"
  | "worktreePath"
> & {
  updatedAt: string;
  latestUserMessageAt?: string | null;
};

export function buildThreadActionItems<TThread extends BuildThreadActionItemsThread>(input: {
  threads: ReadonlyArray<TThread>;
  activeThreadId?: Thread["id"];
  projectTitleById: ReadonlyMap<Project["id"], string>;
  sortOrder: SidebarThreadSortOrder;
  icon: ReactNode;
  /** Optional content rendered inline before the title text per-thread. */
  renderLeadingContent?: (thread: TThread) => ReactNode;
  /** Optional content rendered inline after the title text per-thread. */
  renderTrailingContent?: (thread: TThread) => ReactNode;
  /** Optional rich description (e.g. favicon + workspace icons). Falls back to text. */
  renderDescription?: (thread: TThread, meta: { projectTitle: string | undefined }) => ReactNode;
  getContentMatch?: (thread: TThread) => CommandPaletteThreadContentMatch | undefined;
  runThread: (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) => Promise<void>;
  limit?: number;
}): CommandPaletteActionItem[] {
  const sortedThreads = sortThreads(
    input.threads.filter((thread) => thread.archivedAt === null),
    input.sortOrder,
  );
  const visibleThreads =
    input.limit === undefined ? sortedThreads : sortedThreads.slice(0, input.limit);

  return visibleThreads.map((thread) => {
    const projectTitle = input.projectTitleById.get(thread.projectId);
    const descriptionParts: string[] = [];

    if (projectTitle) {
      descriptionParts.push(projectTitle);
    }
    if (thread.branch) {
      descriptionParts.push(`#${thread.branch}`);
    }
    if (thread.id === input.activeThreadId) {
      descriptionParts.push("Current thread");
    }

    const leadingContent = input.renderLeadingContent?.(thread);
    const trailingContent = input.renderTrailingContent?.(thread);
    const contentMatch = input.getContentMatch?.(thread);
    const description = input.renderDescription
      ? input.renderDescription(thread, { projectTitle })
      : descriptionParts.join(` · `);

    return Object.assign(
      {
        kind: "action" as const,
        value: `thread:${thread.id}`,
        searchTerms: [
          thread.title,
          projectTitle ?? ``,
          thread.branch ?? ``,
          contentMatch?.snippet ?? ``,
        ],
        title: thread.title,
        description,
        timestamp: formatRelativeTimeLabel(
          thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
        ),
        icon: input.icon,
      },
      leadingContent ? { titleLeadingContent: leadingContent } : {},
      trailingContent ? { titleTrailingContent: trailingContent } : {},
      contentMatch ? { threadContentMatch: contentMatch } : {},
      {
        run: async () => {
          await input.runThread(thread);
        },
      },
    );
  });
}

function rankSearchFieldMatch(field: string, normalizedQuery: string): number {
  const normalizedField = normalizeSearchText(field);
  if (normalizedField.length === 0 || !normalizedField.includes(normalizedQuery)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (normalizedField === normalizedQuery) {
    return 3;
  }
  if (normalizedField.startsWith(normalizedQuery)) {
    return 2;
  }
  return 1;
}

function rankCommandPaletteItemMatch(
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
  normalizedQuery: string,
): number {
  const terms = item.searchTerms.filter((term) => term.length > 0);
  if (terms.length === 0) {
    return 0;
  }

  for (const [index, field] of terms.entries()) {
    const fieldRank = rankSearchFieldMatch(field, normalizedQuery);
    if (fieldRank !== Number.NEGATIVE_INFINITY) {
      return 1_000 - index * 100 + fieldRank;
    }
  }

  return 0;
}

export function filterCommandPaletteGroups(input: {
  activeGroups: ReadonlyArray<CommandPaletteGroup>;
  query: string;
  isInSubmenu: boolean;
  projectSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  threadSearchItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const isActionsFilter = input.query.startsWith(">");
  const searchQuery = isActionsFilter ? input.query.slice(1) : input.query;
  const normalizedQuery = normalizeSearchText(searchQuery);

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
  if (!input.isInSubmenu && !isActionsFilter) {
    if (input.projectSearchItems.length > 0) {
      searchableGroups.push({
        value: "projects-search",
        label: "Projects",
        items: input.projectSearchItems,
      });
    }
    if (input.threadSearchItems.length > 0) {
      searchableGroups.push({
        value: "threads-search",
        label: "Threads",
        items: input.threadSearchItems,
      });
    }
  }

  return searchableGroups.flatMap((group) => {
    const items = Arr.filterMap(group.items, (item, index) => {
      const haystack = normalizeSearchText(item.searchTerms.join(" "));
      if (!haystack.includes(normalizedQuery)) {
        return Result.failVoid;
      }

      return Result.succeed({
        item,
        index,
        rank: rankCommandPaletteItemMatch(item, normalizedQuery),
      });
    })
      .toSorted((left, right) => right.rank - left.rank || left.index - right.index)
      .map((entry) => entry.item);

    if (items.length === 0) {
      return [];
    }

    return [{ value: group.value, label: group.label, items }];
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
