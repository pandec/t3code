import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadActions } from "./useThreadActions";
import { threadEnvironment } from "../state/threads";
import { toastManager } from "../components/ui/toast";
import { useThreadUndoNotice } from "./showThreadUndoNotice";

const commands = vi.hoisted(() => ({
  pin: vi.fn(),
  unpin: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  settle: vi.fn(),
  unsettle: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
  delete: vi.fn(),
}));
const router = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  state: { matches: [{ params: {} as Record<string, string> }] },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
const clientSettings = vi.hoisted(() => ({ confirmThreadArchive: false }));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: Record<string, unknown>) => unknown) =>
    select(clientSettings) ?? false,
}));
const dialogs = vi.hoisted(() => ({ confirm: vi.fn<(message: string) => Promise<boolean>>() }));
vi.mock("../localApi", async (original) => ({
  ...(await original<typeof import("../localApi")>()),
  readLocalApi: () => ({ dialogs }),
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
// The draft the reader is looking at when Undo runs; null means the route
// holds a draft they already typed into or sent, or no draft at all.
const emptyDraft = vi.hoisted(() => ({ ids: [] as (string | null)[] }));
vi.mock("../archiveUndo", () => ({
  readEmptyNewThreadDraftId: () => emptyDraft.ids.shift() ?? null,
}));
const threadShell = vi.hoisted(() => ({
  title: "Thread",
  pinOrderKey: "a0",
  pinnedAt: null as string | null,
  snoozedAt: null as string | null,
  snoozedUntil: null as string | null,
  snoozedUntilRunId: null as string | null,
  latestRun: null as { runId: string; status: string; completedAt: string | null } | null,
  pendingBackgroundTasks: [] as Array<{ taskId: string; kind: "subagent" }>,
  projectId: "project",
  environmentId: "undo-env",
  session: null,
}));
const shellLookup = vi.hoisted(() => ({ missing: false }));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsPinReorder: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readThreadShell: () => (shellLookup.missing ? null : threadShell),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    switch (command) {
      case threadEnvironment.pin:
        return commands.pin;
      case threadEnvironment.unpin:
        return commands.unpin;
      case threadEnvironment.archive:
        return commands.archive;
      case threadEnvironment.unarchive:
        return commands.unarchive;
      case threadEnvironment.settle:
        return commands.settle;
      case threadEnvironment.unsettle:
        return commands.unsettle;
      case threadEnvironment.snooze:
        return commands.snooze;
      case threadEnvironment.unsnooze:
        return commands.unsnooze;
      case threadEnvironment.delete:
        return commands.delete;
      default:
        return vi.fn();
    }
  },
}));

const target = {
  environmentId: EnvironmentId.make("undo-env"),
  threadId: ThreadId.make("thread"),
};
function currentUndo() {
  const notice = useThreadUndoNotice.getState().notice;
  expect(notice).not.toBeNull();
  return notice!.undo;
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const command of Object.values(commands)) {
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  }
  router.navigate.mockClear();
  router.state.matches[0]!.params = {};
  emptyDraft.ids = [];
  shellLookup.missing = false;
  threadShell.pinnedAt = null;
  threadShell.snoozedAt = null;
  threadShell.snoozedUntil = null;
  threadShell.snoozedUntilRunId = null;
  threadShell.latestRun = null;
  threadShell.pendingBackgroundTasks = [];
  clientSettings.confirmThreadArchive = false;
  dialogs.confirm.mockReset();
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("unpin Undo", () => {
  it("ignores an old notice across hook instances and still restores the latest unpin", async () => {
    const sidebar = useThreadActions();
    const header = useThreadActions();
    await sidebar.unpinThread(target);
    const staleUndo = currentUndo();
    await header.pinThread(target, { orderKey: "a1" });
    await header.unpinThread(target);
    const latestUndo = currentUndo();
    await staleUndo();
    expect(commands.pin).toHaveBeenCalledTimes(1);
    await latestUndo();
    expect(commands.pin).toHaveBeenCalledTimes(2);
    expect(commands.pin).toHaveBeenLastCalledWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    await latestUndo();
    expect(commands.pin).toHaveBeenCalledTimes(2);
  });
});

describe("attemptArchiveThread", () => {
  it("confirms and archives once when two surfaces archive the same thread together", async () => {
    clientSettings.confirmThreadArchive = true;
    let confirm: (confirmed: boolean) => void = () => {};
    dialogs.confirm.mockReturnValue(
      new Promise((resolve) => {
        confirm = resolve;
      }),
    );
    const sidebar = useThreadActions();
    const shortcut = useThreadActions();
    const first = sidebar.attemptArchiveThread(target);
    await shortcut.attemptArchiveThread(target);
    confirm(true);
    await first;
    expect(dialogs.confirm).toHaveBeenCalledOnce();
    expect(commands.archive).toHaveBeenCalledOnce();
    await sidebar.attemptArchiveThread(target);
    expect(commands.archive).toHaveBeenCalledTimes(2);
  });

  it("keeps the thread when the confirmation is declined", async () => {
    clientSettings.confirmThreadArchive = true;
    dialogs.confirm.mockResolvedValue(false);
    await useThreadActions().attemptArchiveThread(target);
    expect(commands.archive).not.toHaveBeenCalled();
  });
});

describe("archive Undo", () => {
  it("unarchives and returns to the thread when archiving left it", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    const actions = useThreadActions();
    await actions.archiveThread(target);
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Archived", count: 1 });
    expect(add).not.toHaveBeenCalled();
    emptyDraft.ids = ["draft-1", "draft-1"];
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    expect(router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: { environmentId: target.environmentId, threadId: target.threadId },
      }),
    );
  });

  it("keeps a draft the reader typed into after archiving left the thread", async () => {
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    await useThreadActions().archiveThread(target);
    emptyDraft.ids = [null];
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledOnce();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("stays put when the draft changed while the unarchive was in flight", async () => {
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    await useThreadActions().archiveThread(target);
    emptyDraft.ids = ["draft-1", "draft-2"];
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledOnce();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("expires the Undo when the archived thread is deleted", async () => {
    const actions = useThreadActions();
    await actions.archiveThread(target);
    const undo = currentUndo();
    shellLookup.missing = true;
    await actions.deleteThread(target);
    expect(useThreadUndoNotice.getState().notice).toBeNull();
    await undo();
    expect(commands.unarchive).not.toHaveBeenCalled();
  });

  it("stays put when the archived thread was not open", async () => {
    const actions = useThreadActions();
    await actions.archiveThread(target);
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledOnce();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("shows no Undo when the archive failed", async () => {
    commands.archive.mockResolvedValue({ _tag: "Failure", cause: new Error("nope") });
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().archiveThread(target);
    expect(add).not.toHaveBeenCalled();
  });
});

describe("settle and snooze Undo", () => {
  it("un-settles from the notice and expires the Undo after a manual un-settle", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const actions = useThreadActions();
    await actions.settleThread(target);
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Settled", count: 1 });
    expect(add).not.toHaveBeenCalled();
    const undo = currentUndo();
    await actions.unsettleThread(target);
    await undo();
    expect(commands.unsettle).toHaveBeenCalledOnce();
  });

  it("re-pins and re-snoozes a thread that settling had cleared", async () => {
    const snoozedUntil = "2030-01-01T09:00:00.000Z";
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = snoozedUntil;
    const actions = useThreadActions();
    await actions.settleThread(target);
    await currentUndo()();
    expect(commands.unsettle).toHaveBeenCalledOnce();
    expect(commands.pin).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    expect(commands.snooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil },
    });
  });

  it("restores an indefinite snooze that settling had cleared", async () => {
    threadShell.snoozedAt = "2026-01-01T00:00:00.000Z";
    const actions = useThreadActions();
    await actions.settleThread(target);
    await currentUndo()();
    expect(commands.snooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil: null },
    });
  });

  it("leaves an until-done snooze awake, since settling stopped its work", async () => {
    threadShell.snoozedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntilRunId = "run-1";
    threadShell.latestRun = {
      runId: "run-1",
      status: "completed",
      completedAt: "2025-12-31T23:55:00.000Z",
    };
    threadShell.pendingBackgroundTasks = [{ taskId: "task-1", kind: "subagent" }];
    const actions = useThreadActions();
    await actions.settleThread(target);
    await currentUndo()();
    expect(commands.unsettle).toHaveBeenCalledOnce();
    expect(commands.snooze).not.toHaveBeenCalled();
  });

  it("does not restore a snooze that had already woken", async () => {
    threadShell.snoozedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = "2026-01-01T01:00:00.000Z";
    const actions = useThreadActions();
    await actions.settleThread(target);
    await currentUndo()();
    expect(commands.unsettle).toHaveBeenCalledOnce();
    expect(commands.snooze).not.toHaveBeenCalled();
  });

  it("expires an older unpin Undo when the thread is settled", async () => {
    const actions = useThreadActions();
    await actions.unpinThread(target);
    const staleUnpinUndo = currentUndo();
    await actions.settleThread(target);
    await staleUnpinUndo();
    expect(commands.pin).not.toHaveBeenCalled();
  });

  it("wakes the thread from the snooze notice", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const actions = useThreadActions();
    await actions.snoozeThread(target, new Date(Date.now() + 60_000).toISOString());
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Snoozed", count: 1 });
    expect(add).not.toHaveBeenCalled();
    await currentUndo()();
    expect(commands.unsnooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  });
});
