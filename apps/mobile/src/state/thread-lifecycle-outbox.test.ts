import { describe, expect, it } from "@effect/vitest";
import { EnvironmentNotRegisteredError } from "@t3tools/client-runtime/connection";
import {
  CommandId,
  EnvironmentId,
  OrchestrationDispatchCommandError,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";

import { makeRawThreadShell, makeThreadShellFixture } from "../test-fixtures";
import {
  deliverThreadLifecycleIntent,
  type ThreadLifecycleDispatchAction,
} from "./thread-lifecycle-outbox-delivery";
import {
  createThreadLifecycleOutboxManager,
  type ThreadLifecycleOutboxStorage,
} from "./thread-lifecycle-outbox-manager";
import {
  decodeThreadLifecycleIntent,
  deriveThreadLifecyclePresentation,
  encodeThreadLifecycleIntent,
  mergePendingArchivedThreads,
  resolveThreadLifecycleOutboxAction,
  threadLifecycleIntentKey,
  threadLifecycleRevisionRequiresDispatch,
  type ThreadLifecycleIntent,
  type ThreadLifecycleOutboxAction,
} from "./thread-lifecycle-outbox-model";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const key = threadLifecycleIntentKey(environmentId, threadId);

function intent(overrides: Partial<ThreadLifecycleIntent> = {}): ThreadLifecycleIntent {
  return {
    environmentId,
    threadId,
    desiredArchived: true,
    requiresDispatch: false,
    dispatchAttempted: false,
    commandId: CommandId.make("command-archive"),
    createdAt: "2026-08-20T10:02:00.000Z",
    thread: makeRawThreadShell({ id: threadId, title: "Queued lifecycle thread" }),
    ...overrides,
  };
}

function memoryStorage(): ThreadLifecycleOutboxStorage & { failWrites: boolean } {
  const rows = new Map<string, unknown>();
  const storage = {
    failWrites: false,
    load: async () => [...rows.values()].map(decodeThreadLifecycleIntent),
    write: async (candidate: ThreadLifecycleIntent) => {
      if (storage.failWrites) throw new Error("disk full");
      rows.set(
        threadLifecycleIntentKey(candidate.environmentId, candidate.threadId),
        encodeThreadLifecycleIntent(candidate),
      );
    },
    remove: async (candidate: ThreadLifecycleIntent) => {
      rows.delete(threadLifecycleIntentKey(candidate.environmentId, candidate.threadId));
    },
  };
  return storage;
}

const live = {
  environmentConnected: true,
  shellStatus: "live",
  hasQueuedMessages: false,
  requiresDispatch: false,
} as const;
const idle = { archivedAt: null, archiveRequest: null };
const pendingArchive = {
  archivedAt: null,
  archiveRequest: {
    requestId: CommandId.make("request-1"),
    runId: null,
    worktreePath: null,
    requestedAt: "2026-08-20T10:03:00.000Z",
    status: "pending",
  },
} as const;

describe("thread lifecycle outbox model", () => {
  it("round-trips intents with their v2 shell snapshot", () => {
    const queued = intent();
    const decoded = decodeThreadLifecycleIntent(encodeThreadLifecycleIntent(queued));
    expect(decoded).toMatchObject({
      ...queued,
      thread: { id: threadId, title: queued.thread?.title },
    });
    expect(decodeThreadLifecycleIntent(encodeThreadLifecycleIntent(decoded))).toEqual(decoded);
  });

  it("keeps pre-v2 rows deliverable without their v1 shell snapshot", () => {
    const decoded = decodeThreadLifecycleIntent({
      schemaVersion: 1,
      environmentId,
      threadId,
      desiredArchived: true,
      requiresDispatch: false,
      commandId: "command-legacy",
      createdAt: "2026-08-20T10:02:00.000Z",
      baselineArchivedAt: null,
      thread: { id: threadId, session: null, latestTurn: null },
    });
    expect(decoded).toMatchObject({
      desiredArchived: true,
      dispatchAttempted: false,
      thread: null,
    });
  });

  it("waits for a connected live environment and same-thread messages", () => {
    const base = { ...live, thread: idle, desiredArchived: true };
    expect(resolveThreadLifecycleOutboxAction({ ...base, environmentConnected: false })).toBe(
      "wait",
    );
    expect(resolveThreadLifecycleOutboxAction({ ...base, shellStatus: "cached" })).toBe("wait");
    expect(resolveThreadLifecycleOutboxAction({ ...base, hasQueuedMessages: true })).toBe("wait");
    expect(resolveThreadLifecycleOutboxAction(base)).toBe("archive");
  });

  it("drops archives the server already holds", () => {
    const base = { ...live, desiredArchived: true };
    // Archived and deleted threads leave the live shell.
    expect(resolveThreadLifecycleOutboxAction({ ...base, thread: undefined })).toBe("remove");
    expect(resolveThreadLifecycleOutboxAction({ ...base, thread: pendingArchive })).toBe("remove");
  });

  it("reverses a sent archive by unarchiving or cancelling the deferred request", () => {
    const base = { ...live, desiredArchived: false };
    expect(resolveThreadLifecycleOutboxAction({ ...base, thread: undefined })).toBe("unarchive");
    expect(resolveThreadLifecycleOutboxAction({ ...base, thread: pendingArchive })).toBe(
      "cancel-archive",
    );
    // Undo before the archive was ever sent: nothing to do.
    expect(resolveThreadLifecycleOutboxAction({ ...base, thread: idle })).toBe("remove");
    // The archive may have landed without the shell showing it yet.
    expect(
      resolveThreadLifecycleOutboxAction({ ...base, thread: idle, requiresDispatch: true }),
    ).toBe("unarchive");
  });

  it("requires a reversal dispatch only after the prior revision may have been sent", () => {
    expect(threadLifecycleRevisionRequiresDispatch(undefined)).toBe(false);
    expect(threadLifecycleRevisionRequiresDispatch(intent())).toBe(false);
    expect(threadLifecycleRevisionRequiresDispatch(intent({ dispatchAttempted: true }))).toBe(true);
  });

  it("moves pending archives to the shelf and pending unarchives back to the list", () => {
    const active = makeThreadShellFixture({ environmentId, id: threadId, title: "Live title" });
    const other = makeThreadShellFixture({ environmentId, id: ThreadId.make("thread-2") });
    const unarchivedId = ThreadId.make("thread-3");
    const unarchiveIntent = intent({
      threadId: unarchivedId,
      desiredArchived: false,
      commandId: CommandId.make("command-unarchive"),
      thread: makeRawThreadShell({
        id: unarchivedId,
        archivedAt: makeRawThreadShell().createdAt,
      }),
    });
    const presentation = deriveThreadLifecyclePresentation([active, other], {
      [key]: intent(),
      [threadLifecycleIntentKey(environmentId, unarchivedId)]: unarchiveIntent,
    });

    expect(presentation.activeThreads.map((thread) => thread.id)).toEqual([other.id, unarchivedId]);
    expect(presentation.activeThreads[1]?.archivedAt).toBeNull();
    expect(presentation.pendingArchivedThreadKeys).toEqual(new Set([key]));
    // The canonical shell wins over the enqueue-time snapshot.
    expect(presentation.pendingArchivedThreads).toMatchObject([
      { id: threadId, title: "Live title", archivedAt: "2026-08-20T10:02:00.000Z" },
    ]);
  });

  it("merges pending archives above the server shelf without double counting", () => {
    const pending = makeThreadShellFixture({ environmentId, id: threadId });
    const serverOnly = makeThreadShellFixture({ environmentId, id: ThreadId.make("thread-2") });
    const merged = mergePendingArchivedThreads(
      { threads: [pending, serverOnly], totalCount: 5 },
      [pending],
      1,
      threadLifecycleIntentKey(environmentId, serverOnly.id),
    );
    expect(merged.threads.map((thread) => thread.id)).toEqual([pending.id, serverOnly.id]);
    expect(merged.totalCount).toBe(5);
  });
});

describe("thread lifecycle outbox manager", () => {
  it("reloads persisted intents in a new manager", async () => {
    const storage = memoryStorage();
    const queued = intent();
    await createThreadLifecycleOutboxManager({
      registry: AtomRegistry.make(),
      storage,
    }).enqueue(queued);

    const registry = AtomRegistry.make();
    const manager = createThreadLifecycleOutboxManager({ registry, storage });
    await manager.load();
    expect(registry.get(manager.intentsByThreadKeyAtom)).toEqual({
      [key]: decodeThreadLifecycleIntent(encodeThreadLifecycleIntent(queued)),
    });
  });

  it("rolls the optimistic revision back when persistence fails", async () => {
    const storage = memoryStorage();
    const registry = AtomRegistry.make();
    const manager = createThreadLifecycleOutboxManager({ registry, storage });
    const archived = intent();
    await manager.enqueue(archived);

    storage.failWrites = true;
    const undo = manager.enqueue(
      intent({ desiredArchived: false, commandId: CommandId.make("command-undo") }),
    );
    expect(registry.get(manager.intentsByThreadKeyAtom)[key]?.desiredArchived).toBe(false);
    await expect(undo).rejects.toThrow();
    expect(registry.get(manager.intentsByThreadKeyAtom)[key]).toBe(archived);
  });
});

describe("thread lifecycle delivery", () => {
  function harness(actions: ReadonlyArray<ThreadLifecycleOutboxAction>) {
    const registry = AtomRegistry.make();
    const manager = createThreadLifecycleOutboxManager({ registry, storage: memoryStorage() });
    const dispatched: Array<{
      readonly action: ThreadLifecycleDispatchAction;
      readonly intent: ThreadLifecycleIntent;
    }> = [];
    const settled: ThreadLifecycleIntent[] = [];
    let readCount = 0;
    let result: AsyncResult.Success<unknown, unknown> | AsyncResult.Failure<unknown, unknown> =
      AsyncResult.success(undefined);
    return {
      registry,
      manager,
      dispatched,
      settled,
      setResult: (next: typeof result) => {
        result = next;
      },
      deps: {
        manager,
        loadMessageOutbox: async () => true,
        readAction: () => actions[Math.min(readCount++, actions.length - 1)] ?? "wait",
        dispatch: async (
          action: ThreadLifecycleDispatchAction,
          candidate: ThreadLifecycleIntent,
        ) => {
          dispatched.push({ action, intent: candidate });
          return result;
        },
        onSettled: (candidate: ThreadLifecycleIntent) => {
          settled.push(candidate);
        },
      },
    };
  }

  it("persists the attempt, dispatches with the intent's command id, and removes it", async () => {
    const test = harness(["archive"]);
    const queued = intent();
    await test.manager.enqueue(queued);

    expect(await deliverThreadLifecycleIntent(queued, test.deps)).toBe(true);
    expect(test.dispatched).toMatchObject([
      { action: "archive", intent: { commandId: queued.commandId, dispatchAttempted: true } },
    ]);
    expect(test.settled).toHaveLength(1);
    expect(test.registry.get(test.manager.intentsByThreadKeyAtom)).toEqual({});
  });

  it("keeps the intent for retry on transport failures", async () => {
    const test = harness(["archive"]);
    const queued = intent();
    await test.manager.enqueue(queued);
    test.setResult(
      AsyncResult.failure(Cause.fail(new EnvironmentNotRegisteredError({ environmentId }))),
    );

    expect(await deliverThreadLifecycleIntent(queued, test.deps)).toBe(false);
    // A later Undo must now be sent, since this archive may have reached the server.
    expect(test.registry.get(test.manager.intentsByThreadKeyAtom)[key]?.dispatchAttempted).toBe(
      true,
    );
  });

  it("drops an intent the server rejects", async () => {
    const test = harness(["unarchive"]);
    const queued = intent({ desiredArchived: false });
    await test.manager.enqueue(queued);
    test.setResult(
      AsyncResult.failure(
        Cause.fail(new OrchestrationDispatchCommandError({ message: "Thread is not archived." })),
      ),
    );

    expect(await deliverThreadLifecycleIntent(queued, test.deps)).toBe(true);
    expect(test.registry.get(test.manager.intentsByThreadKeyAtom)).toEqual({});
  });

  it("does not send a revision the user replaced before dispatch", async () => {
    const test = harness(["archive"]);
    const queued = intent();
    await test.manager.enqueue(queued);
    const undo = intent({ desiredArchived: false, commandId: CommandId.make("command-undo") });
    await test.manager.enqueue(undo);

    expect(await deliverThreadLifecycleIntent(queued, test.deps)).toBe(true);
    expect(test.dispatched).toEqual([]);
    expect(test.registry.get(test.manager.intentsByThreadKeyAtom)[key]).toBe(undo);
  });

  it("re-reads the action after persisting the attempt", async () => {
    // A same-thread message was queued while the attempt marker was written.
    const test = harness(["archive", "wait"]);
    const queued = intent();
    await test.manager.enqueue(queued);

    expect(await deliverThreadLifecycleIntent(queued, test.deps)).toBe(true);
    expect(test.dispatched).toEqual([]);
    expect(test.registry.get(test.manager.intentsByThreadKeyAtom)[key]?.dispatchAttempted).toBe(
      true,
    );
  });
});
