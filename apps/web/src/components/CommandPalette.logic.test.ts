import { describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { SidebarProjectAccentColor } from "@t3tools/contracts/settings";
import type { Project, Thread } from "../types";
import {
  buildBrowseGroups,
  buildArchiveCurrentThreadAction,
  buildArchivedThreadsActionItems,
  buildCurrentThreadActionItems,
  buildMoveCurrentThreadToTopAction,
  buildProjectActionItems,
  buildThreadActionItems,
  enumerateCommandPaletteItems,
  filterPinnedBrowseEntries,
  filterCommandPaletteGroups,
  reduceCommandPaletteUiState,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

describe("buildArchiveCurrentThreadAction", () => {
  it("omits the action when no thread is open", () => {
    expect(
      buildArchiveCurrentThreadAction({
        threadRef: null,
        icon: null,
        runThread: vi.fn(),
      }),
    ).toBeNull();
  });

  it("builds an archive action for the open thread", async () => {
    const threadRef = scopeThreadRef(
      EnvironmentId.make("environment-local"),
      ThreadId.make("thread-current"),
    );
    const runThread = vi.fn(async () => undefined);
    const item = buildArchiveCurrentThreadAction({
      threadRef,
      icon: null,
      runThread,
    });

    expect(item).toMatchObject({
      kind: "action",
      value: "action:archive-current-thread",
      title: "Archive current thread",
      shortcutCommand: "thread.archive",
    });
    await item?.run();
    expect(runThread).toHaveBeenCalledWith(threadRef);
  });
});

describe("buildMoveCurrentThreadToTopAction", () => {
  it("omits the action when no thread is open", () => {
    expect(
      buildMoveCurrentThreadToTopAction({
        threadRef: null,
        icon: null,
        runThread: vi.fn(),
      }),
    ).toBeNull();
  });

  it("builds a move action for the open thread without a dedicated shortcut", async () => {
    const threadRef = scopeThreadRef(
      EnvironmentId.make("environment-local"),
      ThreadId.make("thread-current"),
    );
    const runThread = vi.fn();
    const item = buildMoveCurrentThreadToTopAction({
      threadRef,
      icon: null,
      runThread,
    });

    expect(item).toMatchObject({
      kind: "action",
      value: "action:move-current-thread-to-top",
      title: "Move current thread to top",
    });
    expect(item).not.toHaveProperty("shortcutCommand");
    await item?.run();
    expect(runThread).toHaveBeenCalledWith(threadRef);
  });
});

describe("buildCurrentThreadActionItems", () => {
  const threadRef = scopeThreadRef(
    EnvironmentId.make("environment-local"),
    ThreadId.make("thread-current"),
  );
  const baseInput = {
    threadRef,
    isPinned: false,
    isSettled: false,
    canSettleNow: true,
    canFork: true,
    supports: { settlement: true, pinning: true },
    icon: () => null,
    run: async () => undefined,
  };

  it("omits every action when no thread is open", () => {
    expect(buildCurrentThreadActionItems({ ...baseInput, threadRef: null })).toEqual([]);
  });

  it("lists one verb per lifecycle pair for an active pinnable thread", () => {
    expect(buildCurrentThreadActionItems(baseInput).map((item) => item.value)).toEqual([
      "action:thread:pin",
      "action:thread:settle",
      "action:thread:fork",
      "action:thread:copy-thread-id",
    ]);
  });

  it("swaps each lifecycle verb for its inverse on a pinned settled thread", () => {
    expect(
      buildCurrentThreadActionItems({ ...baseInput, isPinned: true, isSettled: true }).map(
        (item) => item.value,
      ),
    ).toEqual([
      "action:thread:unpin",
      "action:thread:unsettle",
      "action:thread:fork",
      "action:thread:copy-thread-id",
    ]);
  });

  it("drops capability-gated and unavailable actions", () => {
    expect(
      buildCurrentThreadActionItems({
        ...baseInput,
        canFork: false,
        supports: { settlement: false, pinning: false },
      }).map((item) => item.value),
    ).toEqual(["action:thread:copy-thread-id"]);
  });

  it("disables settle while the thread cannot be settled", () => {
    expect(
      buildCurrentThreadActionItems({ ...baseInput, canSettleNow: false }).find(
        (item) => item.value === "action:thread:settle",
      ),
    ).toMatchObject({ disabled: true });
  });

  it("never disables un-settle, which has no activity precondition", () => {
    expect(
      buildCurrentThreadActionItems({
        ...baseInput,
        isSettled: true,
        canSettleNow: false,
      }).find((item) => item.value === "action:thread:unsettle"),
    ).not.toHaveProperty("disabled");
  });

  it("dispatches the action id and the open thread ref", async () => {
    const run = vi.fn(async () => undefined);
    const items = buildCurrentThreadActionItems({ ...baseInput, run });
    await items.find((item) => item.value === "action:thread:fork")?.run();
    expect(run).toHaveBeenCalledWith("fork", threadRef);
  });
});

describe("buildArchivedThreadsActionItems", () => {
  it("offers only the unfiltered entry without a resolvable project", () => {
    expect(
      buildArchivedThreadsActionItems({
        projectFilterKey: null,
        projectTitle: "Ignored",
        icon: null,
        openArchived: vi.fn(),
      }).map((item) => item.value),
    ).toEqual(["action:archived-threads"]);
  });

  it("adds a project-scoped entry naming the current project", async () => {
    const openArchived = vi.fn(async () => undefined);
    const items = buildArchivedThreadsActionItems({
      projectFilterKey: "environment-local:project-a",
      projectTitle: "T3 Code",
      icon: null,
      openArchived,
    });

    expect(items.map((item) => item.value)).toEqual([
      "action:archived-threads",
      "action:archived-threads-in-project",
    ]);
    expect(items[1]).toMatchObject({ title: "Open archived threads in T3 Code" });

    await items[0]?.run();
    expect(openArchived).toHaveBeenCalledWith(null);
    await items[1]?.run();
    expect(openArchived).toHaveBeenCalledWith("environment-local:project-a");
  });
});

describe("reduceCommandPaletteUiState", () => {
  const closedState = { open: false, mode: "command", openIntent: null } as const;

  it("toggles each overlay mode open and closed", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(filesOpen).toEqual({ open: true, mode: "files", openIntent: null });

    const contentOpen = reduceCommandPaletteUiState(filesOpen, {
      _tag: "ToggleMode",
      mode: "content",
    });
    expect(contentOpen).toEqual({ open: true, mode: "content", openIntent: null });

    expect(
      reduceCommandPaletteUiState(contentOpen, { _tag: "ToggleMode", mode: "content" }),
    ).toEqual({ open: false, mode: "content", openIntent: null });
  });

  it("switches between open modes without closing", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "ToggleMode", mode: "command" })).toEqual(
      {
        open: true,
        mode: "command",
        openIntent: null,
      },
    );
  });

  it("routes open intents to command mode", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenAddProject" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "add-project" },
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenNewThreadIn" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "new-thread-in" },
    });
  });

  it("preserves the mode on close and resets it on open", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });

    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: false })).toEqual({
      open: false,
      mode: "files",
      openIntent: null,
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: true })).toEqual({
      open: true,
      mode: "command",
      openIntent: null,
    });
  });
});

describe("enumerateCommandPaletteItems", () => {
  it("assigns positional jump shortcuts to the first nine displayed items", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      kind: "action" as const,
      value: `project-${index + 1}`,
      searchTerms: [],
      title: `Project ${index + 1}`,
      icon: null,
      shortcutCommand: "chat.new" as const,
      run: async () => undefined,
    }));

    expect(enumerateCommandPaletteItems(items).map((item) => item.shortcutCommand)).toEqual([
      "thread.jump.1",
      "thread.jump.2",
      "thread.jump.3",
      "thread.jump.4",
      "thread.jump.5",
      "thread.jump.6",
      "thread.jump.7",
      "thread.jump.8",
      "thread.jump.9",
      undefined,
    ]);
  });
});

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    completedTurnAssistantMessageIds: [],
    proposedPlans: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    checkpoints: [],
    activities: [],
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    environmentId: LOCAL_ENVIRONMENT_ID,
    title: "Project",
    workspaceRoot: "/repos/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildProjectActionItems", () => {
  it("carries a resolved project accent onto the row", () => {
    const accent = SidebarProjectAccentColor.make("#0055aa");
    const items = buildProjectActionItems({
      projects: [makeProject()],
      valuePrefix: "new-thread-in",
      icon: () => null,
      projectAccentColor: () => accent,
      runProject: async (_project) => undefined,
    });

    expect(items[0]?.projectAccentColor).toBe(accent);
  });

  it("omits the accent when the project has none or tints are switched off", () => {
    const items = buildProjectActionItems({
      projects: [makeProject()],
      valuePrefix: "new-thread-in",
      icon: () => null,
      projectAccentColor: () => null,
      runProject: async (_project) => undefined,
    });

    expect(items[0]).not.toHaveProperty("projectAccentColor");
  });

  it("leaves rows accent-free when no resolver is supplied", () => {
    const items = buildProjectActionItems({
      projects: [makeProject()],
      valuePrefix: "project",
      icon: () => null,
      runProject: async (_project) => undefined,
    });

    expect(items[0]).not.toHaveProperty("projectAccentColor");
  });

  it("keeps the accent when positional jump shortcuts are assigned", () => {
    const accent = SidebarProjectAccentColor.make("#0055aa");
    const items = enumerateCommandPaletteItems(
      buildProjectActionItems({
        projects: [makeProject()],
        valuePrefix: "new-thread-in",
        icon: () => null,
        projectAccentColor: () => accent,
        runProject: async (_project) => undefined,
      }),
    );

    expect(items[0]?.shortcutCommand).toBe("thread.jump.1");
    expect(items[0]?.projectAccentColor).toBe(accent);
  });
});

describe("buildThreadActionItems", () => {
  it("orders threads by most recent activity and formats timestamps from updatedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00.000Z"));

    try {
      const items = buildThreadActionItems({
        threads: [
          makeThread({
            id: ThreadId.make("thread-older"),
            title: "Older thread",
            updatedAt: "2026-03-24T12:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.make("thread-newer"),
            title: "Newer thread",
            createdAt: "2026-03-20T00:00:00.000Z",
            updatedAt: "2026-03-20T00:00:00.000Z",
          }),
        ],
        projectTitleByKey: new Map([[`${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`, "Project"]]),
        sortOrder: "updated_at",
        icon: null,
        runThread: async (_thread) => undefined,
      });

      expect(items.map((item) => item.value)).toEqual([
        "thread:environment-local:thread-older",
        "thread:environment-local:thread-newer",
      ]);
      expect(items[0]?.timestamp).toBe("1d ago");
      expect(items[1]?.timestamp).toBe("5d ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ranks thread title matches ahead of contextual project-name matches", () => {
    const threadItems = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-context-match"),
          title: "Fix navbar spacing",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-title-match"),
          title: "Project kickoff notes",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
      ],
      projectTitleByKey: new Map([[`${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: threadItems,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("threads-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:environment-local:thread-title-match",
      "thread:environment-local:thread-context-match",
    ]);
  });

  it("preserves thread project-name matches when there is no stronger title match", () => {
    const group: CommandPaletteGroup = {
      value: "threads-search",
      label: "Threads",
      items: [
        {
          kind: "action",
          value: "thread:project-context-only",
          searchTerms: ["Fix navbar spacing", "Project"],
          title: "Fix navbar spacing",
          description: "Project",
          icon: null,
          run: async () => undefined,
        },
      ],
    };

    const groups = filterCommandPaletteGroups({
      activeGroups: [group],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["thread:project-context-only"]);
  });

  it("ranks an order-independent setting title match above a split context match", () => {
    const settingsSearchItems = [
      {
        kind: "action" as const,
        value: "setting:context-match",
        searchTerms: ["Pairing settings", "remote backend"],
        title: "Context match",
        icon: null,
        run: async () => undefined,
      },
      {
        kind: "action" as const,
        value: "setting:remote-pairing",
        searchTerms: ["Remote pairing", "connections"],
        title: "Remote pairing",
        icon: null,
        run: async () => undefined,
      },
    ];

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "pairing remote",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems,
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("settings-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "setting:remote-pairing",
      "setting:context-match",
    ]);
  });

  it("keeps accent-insensitive setting results", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "thè\u{1ab0}mes",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems: [
        {
          kind: "action",
          value: "setting:theme",
          searchTerms: ["Themes", "Appearance"],
          title: "Themes",
          icon: null,
          run: async () => undefined,
        },
      ],
      threadSearchItems: [],
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual(["setting:theme"]);
  });

  it("normalizes case independently of the host locale", () => {
    const toLocaleLowerCase = String.prototype.toLocaleLowerCase;
    const localeLowerCase = vi
      .spyOn(String.prototype, "toLocaleLowerCase")
      .mockImplementation(function (this: string) {
        return toLocaleLowerCase.call(this, "tr");
      });
    try {
      const groups = filterCommandPaletteGroups({
        activeGroups: [],
        query: "GIT",
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: [],
        settingsSearchItems: [
          {
            kind: "action",
            value: "setting:version-control",
            title: "Version control",
            searchTerms: ["git"],
            icon: null,
            run: async () => undefined,
          },
        ],
      });
      expect(groups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
        "setting:version-control",
      ]);
    } finally {
      localeLowerCase.mockRestore();
    }
  });

  it("keeps message excerpts searchable without replacing thread metadata", () => {
    const [item] = buildThreadActionItems({
      threads: [makeThread({ branch: "feat/search" })],
      projectTitleByKey: new Map([[`${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`, "T3 Code"]]),
      sortOrder: "updated_at",
      icon: null,
      getContentMatch: () => ({
        source: "assistant",
        snippet: "The relay reconnect is now bounded.",
        query: "reconnect",
      }),
      runThread: async (_thread) => undefined,
    });

    expect(item?.searchTerms).toContain("The relay reconnect is now bounded.");
    expect(item?.threadContentMatch).toEqual({
      source: "assistant",
      snippet: "The relay reconnect is now bounded.",
      query: "reconnect",
    });
    expect(item?.description).toBe("T3 Code · #feat/search");
  });

  it("prefers renderDescription when provided", () => {
    const [item] = buildThreadActionItems({
      threads: [makeThread({ branch: "feat/search", worktreePath: "/tmp/wt" })],
      projectTitleByKey: new Map([[`${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`, "T3 Code"]]),
      sortOrder: "updated_at",
      icon: null,
      renderDescription: (thread, { projectTitle }) =>
        `${projectTitle}:${thread.branch}:${thread.worktreePath ? "wt" : "local"}`,
      runThread: async (_thread) => undefined,
    });

    expect(item?.description).toBe("T3 Code:feat/search:wt");
  });

  it("filters archived threads out of thread search items", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          title: "Active thread",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          title: "Archived thread",
          archivedAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
      ],
      projectTitleByKey: new Map([[`${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    expect(items.map((item) => item.value)).toEqual(["thread:environment-local:thread-active"]);
  });

  it("keeps same-id threads from different environments distinct", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const items = buildThreadActionItems({
      threads: [
        makeThread({ title: "Local copy", updatedAt: "2026-03-20T00:00:00.000Z" }),
        makeThread({
          environmentId: remoteEnvironmentId,
          title: "Remote copy",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
      ],
      activeThreadKey: `${LOCAL_ENVIRONMENT_ID}:thread-1`,
      projectTitleByKey: new Map([
        [`${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`, "Local project"],
        [`${remoteEnvironmentId}:${PROJECT_ID}`, "Remote project"],
      ]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    expect(items.map((item) => item.value)).toEqual([
      "thread:environment-local:thread-1",
      "thread:environment-remote:thread-1",
    ]);
    expect(items[0]?.description).toBe("Local project · Current thread");
    expect(items[1]?.description).toBe("Remote project");
  });
});

describe("buildBrowseGroups", () => {
  it("waits for asynchronous browse navigation actions", async () => {
    let finishNavigation: (() => void) | undefined;
    const browseTo = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishNavigation = resolve;
        }),
    );
    const groups = buildBrowseGroups({
      browseEntries: [{ name: "Downloads", fullPath: "/Users/test/Downloads" }],
      browseQuery: "~/",
      canBrowseUp: false,
      upIcon: null,
      directoryIcon: null,
      browseUp: vi.fn(),
      browseTo,
    });
    const item = groups[0]?.items[0];
    if (!item || item.kind !== "action") {
      throw new Error("Expected a browse action");
    }

    let actionSettled = false;
    const action = item.run().then(() => {
      actionSettled = true;
    });
    await Promise.resolve();

    expect(browseTo).toHaveBeenCalledWith("Downloads");
    expect(actionSettled).toBe(false);

    finishNavigation?.();
    await action;
    expect(actionSettled).toBe(true);
  });
});

describe("filterPinnedBrowseEntries", () => {
  const entries = [
    { name: "repo", fullPath: "/projects/repo" },
    { name: "work", fullPath: "/projects/work" },
  ];

  it("shows sibling folders without losing an existing pinned destination", () => {
    expect(
      filterPinnedBrowseEntries({
        browseEntries: entries,
        filterQuery: "repo",
        pinnedDirectoryName: "repo",
        caseSensitive: true,
      }),
    ).toEqual({ visibleEntries: entries, exactEntry: entries[0] });
  });

  it("matches an existing pinned destination without Windows casing", () => {
    const windowsEntries = [
      { name: "Repo", fullPath: "C:\\projects\\Repo" },
      { name: "work", fullPath: "C:\\projects\\work" },
    ];
    expect(
      filterPinnedBrowseEntries({
        browseEntries: windowsEntries,
        filterQuery: "repo",
        pinnedDirectoryName: "repo",
        caseSensitive: false,
      }),
    ).toEqual({
      visibleEntries: windowsEntries,
      exactEntry: windowsEntries[0],
    });
  });
});
