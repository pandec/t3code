import { describe, expect, it } from "@effect/vitest";
import {
  createThreadLifecycleOutboxManager,
  ThreadLifecycleOutboxManagerError,
} from "@t3tools/client-runtime/state/thread-lifecycle-outbox-manager";
import {
  decodeThreadLifecycleIntent,
  encodeThreadLifecycleIntent,
  resolveThreadLifecycleOutboxAction,
  resolveThreadLifecycleOutboxFailureAction,
  threadLifecycleIntentKey,
  threadLifecycleRevisionRequiresDispatch,
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
import { prepareThreadLifecycleDispatch } from "./thread-lifecycle-dispatch";
import { threadOutboxProjectionCaughtUp } from "./thread-outbox-projection";

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
    dispatchAttempted: false,
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

  it("reports lifecycle hydration failures and permits a retry", async () => {
    const registry = AtomRegistry.make();
    const loadCause = new Error("storage unavailable");
    let loadCalls = 0;
    const manager = createThreadLifecycleOutboxManager({
      registry,
      storage: {
        load: async () => {
          loadCalls += 1;
          if (loadCalls === 1) throw loadCause;
          return [];
        },
        write: async () => undefined,
        remove: async () => undefined,
      },
    });

    expect(registry.get(manager.loadStateAtom)).toEqual({ status: "idle" });
    await manager.load();
    expect(registry.get(manager.loadStateAtom)).toEqual({
      status: "failed",
      error: new ThreadLifecycleOutboxManagerError({
        operation: "load",
        environmentId: null,
        threadId: null,
        cause: loadCause,
      }),
    });
    await manager.load();
    expect(loadCalls).toBe(2);
    expect(registry.get(manager.loadStateAtom)).toEqual({ status: "ready" });
    registry.dispose();
  });

  it("decodes pre-dispatch-attempt rows with a safe default", () => {
    const queued = intent();
    const encoded = encodeThreadLifecycleIntent(queued) as Record<string, unknown>;
    const { dispatchAttempted: _, ...legacyRow } = encoded;

    expect(decodeThreadLifecycleIntent(legacyRow)).toEqual({
      ...queued,
      dispatchAttempted: false,
    });
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
        error: {
          message: "Lifecycle command failed",
          cause: { detail: "Socket is not connected" },
        },
        desiredArchived: true,
        interrupted: false,
      }),
    ).toBe("retry");
    expect(
      resolveThreadLifecycleOutboxFailureAction({
        error: new Error("Permission denied"),
        desiredArchived: true,
        interrupted: false,
      }),
    ).toBe("discard");
  });

  it("waits for message hydration, same-thread delivery, projection, and active work", () => {
    const base = {
      environmentConnected: true,
      shellStatus: "live" as const,
      messageOutboxReady: true,
      threadExists: true,
      threadArchived: false,
      desiredArchived: true,
      requiresDispatch: false,
      hasQueuedMessages: false,
      messageDispatching: false,
      messageProjectionPending: false,
      threadBusy: false,
    };

    expect(resolveThreadLifecycleOutboxAction({ ...base, messageOutboxReady: false })).toBe("wait");
    expect(resolveThreadLifecycleOutboxAction({ ...base, hasQueuedMessages: true })).toBe("wait");
    expect(resolveThreadLifecycleOutboxAction({ ...base, messageDispatching: true })).toBe("wait");
    expect(resolveThreadLifecycleOutboxAction({ ...base, messageProjectionPending: true })).toBe(
      "wait",
    );
    expect(resolveThreadLifecycleOutboxAction({ ...base, threadBusy: true })).toBe("wait");
    expect(resolveThreadLifecycleOutboxAction(base)).toBe("archive");
  });

  it("holds archived-thread absence until auto-unarchive projects", () => {
    const hold = {
      environmentId,
      threadId,
      previousTurnId: null,
      threadWasArchived: true,
      expiresAt: 60_000,
    };
    const stillArchived = { ...thread({ archivedAt: "2026-08-20T09:00:00.000Z" }), environmentId };
    const unarchived = { ...stillArchived, archivedAt: null };

    expect(threadOutboxProjectionCaughtUp(hold, undefined, "live", 0)).toBe(false);
    expect(threadOutboxProjectionCaughtUp(hold, stillArchived, "live", 0)).toBe(false);
    expect(threadOutboxProjectionCaughtUp(hold, unarchived, "live", 0)).toBe(false);
    expect(threadOutboxProjectionCaughtUp(hold, undefined, "live", 60_000)).toBe(true);
  });

  it("clears terminal projection holds and still treats starting as busy", () => {
    const hold = {
      environmentId,
      threadId,
      previousTurnId: null,
      threadWasArchived: false,
      expiresAt: 60_000,
    };
    const unchanged = { ...thread(), environmentId };
    const session = (status: "starting" | "error") => ({
      threadId,
      status,
      providerName: null,
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: status === "error" ? "Turn failed" : null,
      updatedAt: "2026-08-20T10:03:00.000Z",
    });
    const starting = { ...unchanged, session: session("starting") };
    const failed = { ...unchanged, session: session("error") };

    expect(threadOutboxProjectionCaughtUp(hold, unchanged, "live", 0)).toBe(false);
    expect(threadOutboxProjectionCaughtUp(hold, starting, "live", 0)).toBe(true);
    expect(threadOutboxProjectionCaughtUp(hold, failed, "live", 0)).toBe(true);
    expect(
      resolveThreadLifecycleOutboxAction({
        environmentConnected: true,
        shellStatus: "live",
        messageOutboxReady: true,
        threadExists: true,
        threadArchived: false,
        desiredArchived: true,
        requiresDispatch: false,
        hasQueuedMessages: false,
        messageDispatching: false,
        messageProjectionPending: false,
        threadBusy: true,
      }),
    ).toBe("wait");
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

  it("requires a compensating revision only after the prior command may have been sent", async () => {
    const storage = memoryStorage();
    const registry = AtomRegistry.make();
    const manager = createThreadLifecycleOutboxManager({ registry, storage });
    const archive = intent();

    expect(threadLifecycleRevisionRequiresDispatch(undefined)).toBe(false);
    expect(threadLifecycleRevisionRequiresDispatch(archive)).toBe(false);

    await manager.enqueue(archive);
    const attempted = await manager.markDispatchAttempted(archive);

    expect(attempted?.dispatchAttempted).toBe(true);
    expect(threadLifecycleRevisionRequiresDispatch(attempted ?? undefined)).toBe(true);
    expect([...storage.rows.values()].map(decodeThreadLifecycleIntent)).toEqual([attempted]);
    registry.dispose();
  });

  it("rechecks same-thread messages after persisting the dispatch attempt", async () => {
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let sameThreadMessageQueued = false;
    const archive = intent();
    const preparing = prepareThreadLifecycleDispatch({
      intent: archive,
      markDispatchAttempted: async (candidate) => {
        markWriteStarted();
        await writeBlocked;
        return { ...candidate, dispatchAttempted: true };
      },
      confirmCurrent: async () => true,
      readCurrentAction: (attempted) =>
        resolveThreadLifecycleOutboxAction({
          environmentConnected: true,
          shellStatus: "live",
          messageOutboxReady: true,
          threadExists: true,
          threadArchived: false,
          desiredArchived: attempted.desiredArchived,
          requiresDispatch: attempted.requiresDispatch,
          hasQueuedMessages: sameThreadMessageQueued,
          messageDispatching: false,
          messageProjectionPending: false,
          threadBusy: false,
        }),
    });

    await writeStarted;
    sameThreadMessageQueued = true;
    releaseWrite();

    await expect(preparing).resolves.toEqual({
      intent: { ...archive, dispatchAttempted: true },
      action: "wait",
    });
  });

  it("preserves an optimistic enqueue that overlaps environment clearing", async () => {
    const registry = AtomRegistry.make();
    const rows = new Map<string, unknown>();
    let releaseRemove!: () => void;
    let markRemoveStarted!: () => void;
    const removeBlocked = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    const removeStarted = new Promise<void>((resolve) => {
      markRemoveStarted = resolve;
    });
    const storage: ThreadLifecycleOutboxStorage = {
      load: async () => [...rows.values()].map(decodeThreadLifecycleIntent),
      write: async (candidate) => {
        rows.set(
          threadLifecycleIntentKey(candidate.environmentId, candidate.threadId),
          encodeThreadLifecycleIntent(candidate),
        );
      },
      remove: async (candidate) => {
        if (candidate.commandId === CommandId.make("command-archive")) {
          markRemoveStarted();
          await removeBlocked;
        }
        rows.delete(threadLifecycleIntentKey(candidate.environmentId, candidate.threadId));
      },
    };
    const manager = createThreadLifecycleOutboxManager({ registry, storage });
    const archive = intent();
    const replacement = intent({
      commandId: CommandId.make("command-replacement"),
      createdAt: "2026-08-20T10:04:00.000Z",
    });

    await manager.enqueue(archive);
    const clearing = manager.clearEnvironment(environmentId);
    await removeStarted;
    const enqueueing = manager.enqueue(replacement);

    expect(registry.get(manager.intentsByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": replacement,
    });
    releaseRemove();
    await Promise.all([clearing, enqueueing]);

    expect(registry.get(manager.intentsByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": replacement,
    });
    expect([...rows.values()].map(decodeThreadLifecycleIntent)).toEqual([replacement]);
    registry.dispose();
  });

  it("reconciles deleted and already-archived threads only after queued messages", () => {
    const base = {
      environmentConnected: true,
      shellStatus: "live" as const,
      messageOutboxReady: true,
      desiredArchived: true,
      requiresDispatch: false,
      hasQueuedMessages: false,
      messageDispatching: false,
      messageProjectionPending: false,
      threadBusy: false,
    };

    expect(
      resolveThreadLifecycleOutboxAction({
        ...base,
        threadExists: false,
        threadArchived: false,
        hasQueuedMessages: true,
      }),
    ).toBe("wait");
    expect(
      resolveThreadLifecycleOutboxAction({
        ...base,
        threadExists: true,
        threadArchived: true,
        hasQueuedMessages: true,
      }),
    ).toBe("wait");
    expect(
      resolveThreadLifecycleOutboxAction({
        ...base,
        threadExists: false,
        threadArchived: false,
        messageProjectionPending: true,
      }),
    ).toBe("wait");
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
        requiresDispatch: false,
        threadExists: false,
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
