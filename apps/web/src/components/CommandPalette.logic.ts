import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import {
  resolveThreadReferenceCopyTarget,
  type ThreadReferenceCopyTarget,
} from "@t3tools/shared/threadReference";
import type { CommandPaletteLinkedThreads } from "../commandPaletteBus";
import {
  type EnvironmentId,
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
import { parseSnoozeQuery } from "./CommandPalette.snooze";
import { snoozeWakeDescription, type SnoozePreset } from "./Sidebar.snooze";
import { sortThreads } from "../lib/threadSort";
import { normalizeSearchText } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { type Project, type SidebarThreadSummary } from "../types";

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

/** A PR's relations include archived threads that normal palette search omits. */
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

/**
 * The global search overlay hosts three mutually exclusive surfaces: the
 * command palette (⌘K), the project file picker (⌘P), and project content
 * search (⇧⌘F). One reducer owns open/mode state so the surfaces can never
 * stack and re-triggering a mode's shortcut toggles it closed.
 */
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
  | { readonly _tag: "ClearOpenIntent" };

export function reduceCommandPaletteUiState(
  state: CommandPaletteUiState,
  action: CommandPaletteUiAction,
): CommandPaletteUiState {
  switch (action._tag) {
    case "SetOpen":
      return action.open
        ? { open: true, mode: "command", openIntent: state.openIntent }
        : { ...state, open: false, openIntent: null };
    case "ToggleMode":
      return state.open && state.mode === action.mode
        ? { ...state, open: false, openIntent: null }
        : { open: true, mode: action.mode, openIntent: null };
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
  /** Sorts after every other match in its group; see `SettingsSearchItem.secondary`. */
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

// A project as the palette shows it. `displayName` is the grouped label (for
// example "owner/repo" when projects are merged across machines). Keep `title`
// as the real project title: the automatic project icon is derived from it, and
// every other surface uses the real title, so overriding it desyncs the icon.
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
}): CommandPaletteActionItem[] {
  return input.projects.map((project) => {
    const projectAccentColor = input.projectAccentColor?.(project) ?? null;
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

/**
 * Per-thread actions the palette offers for the open thread, mirroring the
 * per-thread context menu. Ids are shared between the item builder and the
 * dispatcher so labels and handlers cannot drift apart.
 */
export type CommandPaletteThreadActionId = "settle" | "unsettle" | "pin" | "unpin" | "fork";

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

export const MOVE_TO_GROUP_NONE_VALUE = "group:none";
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
  readonly currentGroupId: string | null;
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

/**
 * Snooze view rows: presets, "Custom…", and, when the query parses as a time
 * ("45m", "2pm", "fri 9am"), a synthesized row on top. That row's value
 * embeds the wake time so highlight state survives re-renders on each key.
 */
export function buildSnoozeThreadViewItems(input: {
  readonly query: string;
  readonly now: Date;
  readonly presets: ReadonlyArray<SnoozePreset>;
  readonly timestampFormat: Parameters<typeof snoozeWakeDescription>[2];
  readonly icon: ReactNode;
  readonly customIcon: ReactNode;
  /** Trailing wake-time column, rendered by the caller (this module is JSX-free). */
  readonly renderWhen: (whenLabel: string) => ReactNode;
  readonly snooze: (preset: Pick<SnoozePreset, "snoozedUntil" | "untilDone">) => Promise<void>;
  readonly custom: () => Promise<void>;
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
  | "modelSelection"
  | "projectId"
  | "session"
  | "title"
  | "worktreePath"
> & {
  pullRequests?: SidebarThreadSummary["pullRequests"];
  updatedAt: string;
  latestUserMessageAt?: string | null;
};

export function buildThreadActionItems<TThread extends BuildThreadActionItemsThread>(input: {
  threads: ReadonlyArray<TThread>;
  /** Scoped `environmentId:threadId` key — bare thread ids collide across environments. */
  activeThreadKey?: string;
  /** Keyed by scoped `environmentId:projectId` — bare project ids collide across environments. */
  projectTitleByKey: ReadonlyMap<string, string>;
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
    const threadKey = `${thread.environmentId}:${thread.id}`;
    const projectTitle = input.projectTitleByKey.get(`${thread.environmentId}:${thread.projectId}`);
    const descriptionParts: string[] = [];

    if (projectTitle) {
      descriptionParts.push(projectTitle);
    }
    if (thread.branch) {
      descriptionParts.push(`#${thread.branch}`);
    }
    if (threadKey === input.activeThreadKey) {
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
        value: `thread:${threadKey}`,
        searchTerms: [
          thread.title,
          ...threadPullRequestSearchTerms(thread),
          projectTitle ?? ``,
          thread.branch ?? ``,
          contentMatch?.snippet ?? ``,
          // Last so pasted IDs never outrank title matches for shared substrings.
          thread.id,
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

function rankSearchFieldMatch(
  field: string,
  normalizedQuery: string,
  queryTokens: ReadonlyArray<string>,
): number {
  const normalizedField = normalizeSearchText(field);
  if (
    normalizedField.length === 0 ||
    !queryTokens.every((token) => normalizedField.includes(token))
  ) {
    return Number.NEGATIVE_INFINITY;
  }
  if (normalizedField === normalizedQuery) {
    return 3;
  }
  if (normalizedField.startsWith(normalizedQuery)) {
    return 2;
  }
  if (normalizedField.includes(normalizedQuery)) {
    return 1;
  }
  return 0;
}

function rankCommandPaletteItemMatch(
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
  normalizedQuery: string,
  queryTokens: ReadonlyArray<string>,
): number {
  const terms = item.searchTerms.filter((term) => term.length > 0);
  if (terms.length === 0) {
    return 0;
  }

  for (const [index, field] of terms.entries()) {
    const fieldRank = rankSearchFieldMatch(field, normalizedQuery, queryTokens);
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
  settingsSearchItems?: ReadonlyArray<CommandPaletteActionItem>;
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
  const queryTokens = normalizedQuery.split(" ");

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
    if (input.settingsSearchItems && input.settingsSearchItems.length > 0) {
      searchableGroups.push({
        value: "settings-search",
        label: "Settings",
        items: input.settingsSearchItems,
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
      if (!queryTokens.every((token) => haystack.includes(token))) {
        return Result.failVoid;
      }

      return Result.succeed({
        item,
        index,
        rank: rankCommandPaletteItemMatch(item, normalizedQuery, queryTokens),
      });
    })
      .toSorted(
        (left, right) =>
          Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
          right.rank - left.rank ||
          left.index - right.index,
      )
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
