import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2PendingBackgroundTask,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadRuntimeSummary } from "./models.ts";
import {
  archiveDiscardedQueuedMessages,
  discardExceedsConfirmed,
  resolveArchiveToggleAction,
} from "./threadSettled.ts";

function runtime(status: ThreadRuntimeSummary["status"]): ThreadRuntimeSummary {
  return {
    status,
    activeRunId: status === "idle" ? null : RunId.make("run-1"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-10-04T10:00:00.000Z",
  };
}

const idle = {
  archivedAt: null,
  archiveRequest: null,
  runtime: runtime("idle"),
  pendingBackgroundTasks: [] as ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
};

describe("resolveArchiveToggleAction", () => {
  it("archives an idle thread now", () => {
    expect(resolveArchiveToggleAction(idle)).toBe("archive");
  });

  it("archives a busy thread when done", () => {
    expect(resolveArchiveToggleAction({ ...idle, runtime: runtime("running") })).toBe("schedule");
    expect(
      resolveArchiveToggleAction({
        ...idle,
        pendingBackgroundTasks: [{ kind: "subagent", taskId: "agent-1" }],
      }),
    ).toBe("schedule");
  });

  it("schedules while the final checkpoint is captured", () => {
    expect(resolveArchiveToggleAction({ ...idle, runtime: runtime("waiting") })).toBe("schedule");
    expect(resolveArchiveToggleAction({ ...idle, runtime: runtime("completed") })).toBe("archive");
  });

  it("does not wait on background commands such as dev servers", () => {
    expect(
      resolveArchiveToggleAction({
        ...idle,
        pendingBackgroundTasks: [{ kind: "command", taskId: "dev-server" }],
      }),
    ).toBe("archive");
  });

  it("cancels a pending archive", () => {
    expect(
      resolveArchiveToggleAction({
        ...idle,
        runtime: runtime("running"),
        archiveRequest: {
          requestId: CommandId.make("archive-1"),
          runId: RunId.make("run-1"),
          worktreePath: null,
          requestedAt: "2026-10-04T10:00:00.000Z",
          status: "pending",
        },
      }),
    ).toBe("cancel");
  });
});

describe("archiveDiscardedQueuedMessages", () => {
  const environmentId = EnvironmentId.make("env");
  const parent = { ...idle, environmentId, id: ThreadId.make("parent") };
  const sideChat = (queuedMessageCount: number, overrides: object = {}) => ({
    environmentId,
    lineage: {
      parentThreadId: parent.id,
      relationshipToParent: "fork" as const,
      rootThreadId: parent.id,
      sideChat: true,
    },
    archivedAt: null,
    queuedMessageCount,
    ...overrides,
  });

  it("counts queued messages, held ones included, only when archiving now", () => {
    // A Stop-held queue presents the interrupted run, so the runtime alone would hide it.
    const held = { ...parent, runtime: runtime("interrupted"), queuedMessageCount: 2 };
    expect(archiveDiscardedQueuedMessages(held)).toEqual({ total: 2, inSideChats: 0 });
    expect(archiveDiscardedQueuedMessages({ ...parent, queuedMessageCount: 0 }).total).toBe(0);
    expect(archiveDiscardedQueuedMessages(parent).total).toBe(0);
    // Archive-when-done on a working thread discards nothing of its own.
    expect(archiveDiscardedQueuedMessages({ ...held, runtime: runtime("running") }).total).toBe(0);
  });

  it("adds the queues of the side chats the archive takes, now or when done", () => {
    const threads = [
      sideChat(1),
      sideChat(2),
      sideChat(4, { archivedAt: "2026-10-04T10:00:00.000Z" }),
      sideChat(8, { environmentId: EnvironmentId.make("other") }),
      sideChat(16, { lineage: { ...sideChat(0).lineage, sideChat: undefined } }),
    ];
    const withQueue = { ...parent, queuedMessageCount: 1 };
    expect(archiveDiscardedQueuedMessages(withQueue, threads)).toEqual({
      total: 4,
      inSideChats: 3,
    });
    expect(
      archiveDiscardedQueuedMessages({ ...withQueue, runtime: runtime("running") }, threads),
    ).toEqual({ total: 3, inSideChats: 3 });
    const pendingArchive = {
      requestId: CommandId.make("archive-1"),
      runId: null,
      worktreePath: null,
      requestedAt: "2026-10-04T10:00:00.000Z",
      status: "pending" as const,
    };
    expect(
      archiveDiscardedQueuedMessages({ ...withQueue, archiveRequest: pendingArchive }, threads),
    ).toEqual({ total: 0, inSideChats: 0 });
  });

  it("asks again when either queue grew past what was confirmed", () => {
    const confirmed = { total: 3, inSideChats: 2 };
    expect(discardExceedsConfirmed({ total: 3, inSideChats: 2 }, confirmed)).toBe(false);
    expect(discardExceedsConfirmed({ total: 1, inSideChats: 0 }, confirmed)).toBe(false);
    expect(discardExceedsConfirmed({ total: 4, inSideChats: 3 }, confirmed)).toBe(true);
    // The same total moved from a side chat to the thread itself.
    expect(discardExceedsConfirmed({ total: 3, inSideChats: 1 }, confirmed)).toBe(true);
  });
});
