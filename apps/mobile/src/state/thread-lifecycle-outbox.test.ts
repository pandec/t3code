import { describe, expect, it } from "@effect/vitest";
import { createThreadLifecycleOutboxManager } from "@t3tools/client-runtime/state/thread-lifecycle-outbox-manager";
import {
  decodeThreadLifecycleIntent,
  encodeThreadLifecycleIntent,
  resolveThreadLifecycleOutboxAction,
  resolveThreadLifecycleOutboxFailureAction,
  threadLifecycleIntentKey,
  type ThreadLifecycleIntent,
} from "@t3tools/client-runtime/state/thread-lifecycle-outbox-model";
import type { ThreadLifecycleOutboxStorage } from "@t3tools/client-runtime/state/thread-lifecycle-outbox-storage";
import type { OrchestrationThreadShell } from "@t3tools/contracts";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  deriveThreadLifecyclePresentation,
  mergePendingArchivedThreads,
} from "./thread-lifecycle-outbox";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");

function thread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Queued lifecycle thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:01:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    settledOverride: null,
    settledAt: null,
    ...overrides,
  };
}

function intent(overrides: Partial<ThreadLifecycleIntent> = {}): ThreadLifecycleIntent {
  return {
    environmentId,
    threadId,
    desiredArchived: true,
    requiresDispatch: false,
    commandId: CommandId.make("command-archive"),
    createdAt: "2026-08-20T10:02:00.000Z",
    baselineArchivedAt: null,
    thread: thread(),
    ...overrides,
  };
}

function memoryStorage(): ThreadLifecycleOutboxStorage & {
  readonly rows: Map<string, unknown>;
} {
  const rows = new Map<string, unknown>();
  return {
    rows,
    load: async () => [...rows.values()].map(decodeThreadLifecycleIntent),
    write: async (candidate) => {
      rows.set(
        threadLifecycleIntentKey(candidate.environmentId, candidate.threadId),
        encodeThreadLifecycleIntent(candidate),
      );
    },
    remove: async (candidate) => {
      rows.delete(threadLifecycleIntentKey(candidate.environmentId, candidate.threadId));
    },
  };
}

describe("thread lifecycle outbox", () => {
  it("round-trips persisted intents and loads them in a new manager", async () => {
    const storage = memoryStorage();
    const firstRegistry = AtomRegistry.make();
    const queued = intent();
    const firstManager = createThreadLifecycleOutboxManager({
      registry: firstRegistry,
      storage,
    });

    await firstManager.enqueue(queued);
    expect(decodeThreadLifecycleIntent(encodeThreadLifecycleIntent(queued))).toEqual(queued);

    const secondRegistry = AtomRegistry.make();
    const secondManager = createThreadLifecycleOutboxManager({
      registry: secondRegistry,
      storage,
    });
    await secondManager.load();

    expect(secondRegistry.get(secondManager.intentsByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": queued,
    });
    firstRegistry.dispose();
    secondRegistry.dispose();
  });

  it("restores presentation state when persistence fails", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadLifecycleOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => Promise.reject(new Error("disk full")),
        remove: async () => undefined,
      },
    });

    await expect(manager.enqueue(intent())).rejects.toThrow();
    expect(registry.get(manager.intentsByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("retries transient delivery and fulfills lifecycle invariants", () => {
    expect(
      resolveThreadLifecycleOutboxFailureAction({
        error: { _tag: "ConnectionTransientError", detail: "socket closed" },
        desiredArchived: true,
        interrupted: false,
      }),
    ).toBe("retry");
    expect(
      resolveThreadLifecycleOutboxFailureAction({
        error: new Error("Thread is already archived"),
        desiredArchived: true,
        interrupted: false,
      }),
    ).toBe("fulfilled");
    expect(
      resolveThreadLifecycleOutboxFailureAction({
        error: new Error("Thread does not exist"),
        desiredArchived: false,
        interrupted: false,
      }),
    ).toBe("fulfilled");
    expect(
      resolveThreadLifecycleOutboxFailureAction({
        error: new Error("Permission denied"),
        desiredArchived: true,
        interrupted: false,
      }),
    ).toBe("discard");
  });

  it("waits behind same-thread messages and active turns", () => {
    const base = {
      environmentConnected: true,
      shellStatus: "live" as const,
      threadExists: true,
      threadArchived: false,
      desiredArchived: true,
      requiresDispatch: false,
      hasQueuedMessages: false,
      messageDispatching: false,
      hasActiveTurn: false,
    };

    expect(resolveThreadLifecycleOutboxAction({ ...base, hasQueuedMessages: true })).toBe("wait");
    expect(resolveThreadLifecycleOutboxAction({ ...base, messageDispatching: true })).toBe("wait");
    expect(resolveThreadLifecycleOutboxAction({ ...base, hasActiveTurn: true })).toBe("wait");
    expect(resolveThreadLifecycleOutboxAction(base)).toBe("archive");
  });

  it("keeps an Undo revision when stale archive dispatch cleanup arrives", async () => {
    const storage = memoryStorage();
    const registry = AtomRegistry.make();
    const manager = createThreadLifecycleOutboxManager({ registry, storage });
    const archive = intent();
    const undo = intent({
      desiredArchived: false,
      requiresDispatch: true,
      commandId: CommandId.make("command-unarchive"),
      createdAt: "2026-08-20T10:03:00.000Z",
    });

    await manager.enqueue(archive);
    await manager.enqueue(undo);

    expect(await manager.removeIfCurrent(archive)).toBe(false);
    expect(registry.get(manager.intentsByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": undo,
    });
    expect(storage.rows.size).toBe(1);
    registry.dispose();
  });

  it("drops intents for deleted threads and already-desired server state", () => {
    const base = {
      environmentConnected: true,
      shellStatus: "live" as const,
      desiredArchived: true,
      requiresDispatch: false,
      hasQueuedMessages: false,
      messageDispatching: false,
      hasActiveTurn: false,
    };

    expect(
      resolveThreadLifecycleOutboxAction({
        ...base,
        threadExists: false,
        threadArchived: false,
      }),
    ).toBe("remove");
    expect(
      resolveThreadLifecycleOutboxAction({
        ...base,
        threadExists: true,
        threadArchived: true,
      }),
    ).toBe("remove");
    expect(
      resolveThreadLifecycleOutboxAction({
        ...base,
        desiredArchived: false,
        requiresDispatch: true,
        threadExists: true,
        threadArchived: false,
      }),
    ).toBe("unarchive");
    expect(
      resolveThreadLifecycleOutboxAction({
        ...base,
        desiredArchived: false,
        requiresDispatch: true,
        threadExists: false,
        threadArchived: false,
      }),
    ).toBe("unarchive");
  });

  it("overlays pending archive and Undo without mutating canonical shells", () => {
    const canonical = { ...thread(), environmentId };
    const archive = intent();
    const archivedPresentation = deriveThreadLifecyclePresentation([canonical], {
      "environment-1:thread-1": archive,
    });

    expect(archivedPresentation.activeThreads).toEqual([]);
    expect(archivedPresentation.pendingArchivedThreads).toHaveLength(1);
    expect(canonical.archivedAt).toBeNull();
    expect(
      mergePendingArchivedThreads(
        { threads: [], totalCount: 0 },
        archivedPresentation.pendingArchivedThreads,
        5,
      ).totalCount,
    ).toBe(1);

    const undoPresentation = deriveThreadLifecyclePresentation([], {
      "environment-1:thread-1": intent({
        desiredArchived: false,
        commandId: CommandId.make("command-unarchive"),
      }),
    });
    expect(undoPresentation.activeThreads).toEqual([{ ...archive.thread, environmentId }]);
    expect(undoPresentation.pendingArchivedThreads).toEqual([]);
  });
});
