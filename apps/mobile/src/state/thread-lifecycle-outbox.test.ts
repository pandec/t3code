import { describe, expect, it } from "@effect/vitest";
import { EnvironmentNotRegisteredError } from "@t3tools/client-runtime/connection";
import {
  CommandId,
  EnvironmentId,
  OrchestrationDispatchCommandError,
  type OrchestrationV2DispatchCommandResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/reactivity";

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
  createThreadLifecycleDispatchFence,
  decodeThreadLifecycleIntent,
  deriveThreadLifecyclePresentation,
  encodeThreadLifecycleIntent,
  mergePendingArchivedThreads,
  resolveThreadLifecycleOutboxAction,
  threadLifecycleActionUsesOutbox,
  threadLifecycleIntentKey,
  threadLifecycleIntentRevision,
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
    dispatchedAction: null,
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
  operateGrant: "granted",
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

  it("waits for the connection's grant and drops intents it cannot dispatch", () => {
    for (const thread of [idle, pendingArchive, undefined]) {
      for (const desiredArchived of [true, false]) {
        const base = { ...live, thread, desiredArchived, requiresDispatch: true };
        expect(resolveThreadLifecycleOutboxAction({ ...base, operateGrant: "loading" })).toBe(
          "wait",
        );
        // Queued messages wait on the same grant, so denial must not wait behind them.
        for (const hasQueuedMessages of [false, true]) {
          expect(
            resolveThreadLifecycleOutboxAction({
              ...base,
              hasQueuedMessages,
              operateGrant: "denied",
            }),
          ).toBe("remove");
        }
      }
    }
  });

  it("leaves an unverified grant to the server instead of stalling", () => {
    const base = {
      ...live,
      thread: idle,
      desiredArchived: true,
      operateGrant: "unverified",
    } as const;
    expect(resolveThreadLifecycleOutboxAction(base)).toBe("archive");
    expect(resolveThreadLifecycleOutboxAction({ ...base, hasQueuedMessages: true })).toBe("wait");
  });

  it("drops archives the server already holds", () => {
    const base = { ...live, desiredArchived: true };
    // Archived and deleted threads leave the live shell.
    expect(resolveThreadLifecycleOutboxAction({ ...base, thread: undefined })).toBe("remove");
    expect(resolveThreadLifecycleOutboxAction({ ...base, thread: pendingArchive })).toBe("remove");
  });

  it("re-sends an archive whose earlier reversal the shell does not show yet", () => {
    const base = { ...live, desiredArchived: true, requiresDispatch: true };
    // The unarchive landed; the shell still omits the thread.
    expect(resolveThreadLifecycleOutboxAction({ ...base, thread: undefined })).toBe("archive");
    // The cancel landed; the shell still shows the request pending.
    expect(resolveThreadLifecycleOutboxAction({ ...base, thread: pendingArchive })).toBe("archive");
  });

  it("reverses a sent archive by unarchiving or cancelling the deferred request", () => {
    const base = { ...live, desiredArchived: false };
    expect(resolveThreadLifecycleOutboxAction({ ...base, thread: undefined })).toBe("unarchive");
    expect(
      resolveThreadLifecycleOutboxAction({
        ...base,
        thread: pendingArchive,
        requiresDispatch: true,
      }),
    ).toBe("cancel-archive");
    // A pending archive none of our revisions sent (e.g. "Archive when done") stays.
    expect(resolveThreadLifecycleOutboxAction({ ...base, thread: pendingArchive })).toBe("remove");
    // Undo before the archive was ever sent: nothing to do.
    expect(resolveThreadLifecycleOutboxAction({ ...base, thread: idle })).toBe("remove");
    // The archive may have landed without the shell showing it yet.
    expect(
      resolveThreadLifecycleOutboxAction({ ...base, thread: idle, requiresDispatch: true }),
    ).toBe("unarchive");
  });

  it("routes archive through a pending intent even while connected", () => {
    const route = (action: string, environmentConnected: boolean, hasIntent: boolean) =>
      threadLifecycleActionUsesOutbox({ action, environmentConnected, hasIntent });
    expect(route("archive", false, false)).toBe(true);
    expect(route("archive", true, false)).toBe(false);
    expect(route("archive", true, true)).toBe(true);
    expect(route("unarchive", true, true)).toBe(true);
    expect(route("unarchive", true, false)).toBe(false);
    // Offline, every archive control queues, even without an earlier intent.
    for (const action of ["unarchive", "schedule-archive", "cancel-archive"]) {
      expect(route(action, false, false)).toBe(true);
      expect(route(action, true, false)).toBe(false);
    }
    expect(route("delete", false, true)).toBe(false);

    // The revised pending Undo now archives instead of unarchiving.
    const undo = intent({
      desiredArchived: false,
      requiresDispatch: true,
      dispatchAttempted: true,
    });
    const revised = intent({
      requiresDispatch: threadLifecycleRevisionRequiresDispatch(undo),
      commandId: CommandId.make("command-rearchive"),
    });
    expect(resolveThreadLifecycleOutboxAction({ ...live, ...revised, thread: idle })).toBe(
      "archive",
    );
  });

  it("delivers an offline unarchive of a server-archived thread", () => {
    const revision = threadLifecycleIntentRevision("unarchive", undefined);
    expect(revision).toEqual({ desiredArchived: false, requiresDispatch: false });
    // Live shells omit archived threads.
    expect(resolveThreadLifecycleOutboxAction({ ...live, ...revision, thread: undefined })).toBe(
      "unarchive",
    );
  });

  it("delivers an offline archive of a busy thread as a deferred archive", () => {
    const revision = threadLifecycleIntentRevision("schedule-archive", undefined);
    expect(revision).toEqual({ desiredArchived: true, requiresDispatch: false });
    // "archive" is dispatched as archive-when-done, so the work finishes first.
    expect(resolveThreadLifecycleOutboxAction({ ...live, ...revision, thread: idle })).toBe(
      "archive",
    );
  });

  it("delivers an offline cancel of a server-held deferred archive", () => {
    const revision = threadLifecycleIntentRevision("cancel-archive", undefined);
    expect(revision).toEqual({ desiredArchived: false, requiresDispatch: true });
    const resolve = (thread: typeof idle | typeof pendingArchive | undefined) =>
      resolveThreadLifecycleOutboxAction({ ...live, ...revision, thread });
    expect(resolve(pendingArchive)).toBe("cancel-archive");
    // The deferred archive ran while offline: keep the thread out of the archive.
    expect(resolve(undefined)).toBe("unarchive");
  });

  it("requires a reversal dispatch only after the prior revision may have been sent", () => {
    expect(threadLifecycleRevisionRequiresDispatch(undefined)).toBe(false);
    expect(threadLifecycleRevisionRequiresDispatch(intent())).toBe(false);
    expect(threadLifecycleRevisionRequiresDispatch(intent({ dispatchAttempted: true }))).toBe(true);
    expect(
      threadLifecycleRevisionRequiresDispatch(
        intent({ requiresDispatch: true, dispatchAttempted: false }),
      ),
    ).toBe(true);
  });

  it("keeps a sent archive's reversal obligation across unsent revisions", () => {
    // Archive sent, then Undo, Archive, Undo before its outcome is observed.
    const revise = (previous: ThreadLifecycleIntent, desiredArchived: boolean) =>
      intent({
        desiredArchived,
        requiresDispatch: threadLifecycleRevisionRequiresDispatch(previous),
      });
    const sent = intent({ dispatchAttempted: true, dispatchedAction: "archive" });
    const finalUndo = revise(revise(revise(sent, false), true), false);
    expect(finalUndo.requiresDispatch).toBe(true);
    const resolve = (thread: typeof idle | typeof pendingArchive) =>
      resolveThreadLifecycleOutboxAction({ ...live, ...finalUndo, thread });
    expect(resolve(pendingArchive)).toBe("cancel-archive");
    expect(resolve(idle)).toBe("unarchive");
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
    expect(presentation.pendingUnarchivedThreadKeys).toEqual(
      new Set([threadLifecycleIntentKey(environmentId, unarchivedId)]),
    );
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
      { pendingArchivedThreads: [pending], pendingUnarchivedThreadKeys: new Set() },
      1,
      threadLifecycleIntentKey(environmentId, serverOnly.id),
    );
    expect(merged.threads.map((thread) => thread.id)).toEqual([pending.id, serverOnly.id]);
    expect(merged.totalCount).toBe(5);
  });

  it("shows a cancelled deferred archive and an offline unarchive at once", () => {
    const busy = makeThreadShellFixture({
      environmentId,
      id: threadId,
      archiveRequest: pendingArchive.archiveRequest,
    });
    const archivedId = ThreadId.make("thread-archived");
    const archived = makeThreadShellFixture({
      environmentId,
      id: archivedId,
      archivedAt: "2026-08-20T09:00:00.000Z",
    });
    const presentation = deriveThreadLifecyclePresentation([busy], {
      [key]: intent({ desiredArchived: false, requiresDispatch: true }),
      [threadLifecycleIntentKey(environmentId, archivedId)]: intent({
        threadId: archivedId,
        desiredArchived: false,
        thread: archived.source,
      }),
    });
    expect(presentation.activeThreads).toMatchObject([
      { id: threadId, archiveRequest: null },
      { id: archivedId, archivedAt: null },
    ]);
    // The unarchived thread leaves the server shelf.
    const merged = mergePendingArchivedThreads(
      { threads: [archived], totalCount: 3 },
      presentation,
      5,
    );
    expect(merged).toEqual({ threads: [], totalCount: 2 });
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
  function harness(initialActions: ReadonlyArray<ThreadLifecycleOutboxAction>) {
    const registry = AtomRegistry.make();
    const manager = createThreadLifecycleOutboxManager({ registry, storage: memoryStorage() });
    const dispatched: Array<{
      readonly action: ThreadLifecycleDispatchAction;
      readonly intent: ThreadLifecycleIntent;
    }> = [];
    const settled: ThreadLifecycleIntent[] = [];
    let actions = initialActions;
    let readCount = 0;
    let threadActive = false;
    let nextCommandId = 0;
    let result:
      | AsyncResult.Success<OrchestrationV2DispatchCommandResult, unknown>
      | AsyncResult.Failure<OrchestrationV2DispatchCommandResult, unknown> = AsyncResult.success({
      sequence: 1,
    });
    return {
      registry,
      manager,
      dispatched,
      settled,
      setResult: (next: typeof result) => {
        result = next;
      },
      setActions: (next: ReadonlyArray<ThreadLifecycleOutboxAction>) => {
        actions = next;
        readCount = 0;
      },
      setThreadActive: (next: boolean) => {
        threadActive = next;
      },
      current: () => registry.get(manager.intentsByThreadKeyAtom)[key],
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
        threadActive: () => threadActive,
        newCommandId: () => CommandId.make(`command-rotated-${++nextCommandId}`),
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

  const rejected = (message: string) =>
    AsyncResult.failure<OrchestrationV2DispatchCommandResult, OrchestrationDispatchCommandError>(
      Cause.fail(new OrchestrationDispatchCommandError({ message })),
    );

  it("retries an archive rejected while the thread has queued work, under a fresh id", async () => {
    const test = harness(["archive"]);
    const queued = intent();
    await test.manager.enqueue(queued);
    test.setResult(rejected("Queued messages are waiting to run."));
    test.setThreadActive(true);

    expect(await deliverThreadLifecycleIntent(queued, test.deps)).toBe(false);
    const retained = test.current();
    expect(retained).toMatchObject({ desiredArchived: true, dispatchedAction: null });
    expect(retained?.commandId).not.toBe(queued.commandId);
    expect(test.settled).toEqual([]);

    // Once the thread is no longer active, a rejection makes the intent moot.
    test.setThreadActive(false);
    test.setActions(["archive"]);
    expect(await deliverThreadLifecycleIntent(retained!, test.deps)).toBe(true);
    expect(test.current()).toBeUndefined();
  });

  it("unarchives under a fresh id when a cancel is rejected because the archive landed", async () => {
    const test = harness(["cancel-archive"]);
    const undo = intent({ desiredArchived: false, requiresDispatch: true });
    await test.manager.enqueue(undo);
    test.setResult(rejected("No archive is pending."));

    expect(await deliverThreadLifecycleIntent(undo, test.deps)).toBe(false);
    const rotated = test.current();
    expect(rotated?.desiredArchived).toBe(false);
    expect(rotated?.commandId).not.toBe(undo.commandId);

    // The shell now shows the thread archived.
    test.setActions(["unarchive"]);
    test.setResult(AsyncResult.success({ sequence: 1 }));
    expect(await deliverThreadLifecycleIntent(rotated!, test.deps)).toBe(true);
    expect(test.dispatched.map(({ action, intent }) => [action, intent.commandId])).toEqual([
      ["cancel-archive", undo.commandId],
      ["unarchive", rotated?.commandId],
    ]);
    expect(test.current()).toBeUndefined();
  });

  it("rotates the id before sending a different action after an unobserved cancel", async () => {
    const test = harness(["cancel-archive"]);
    const undo = intent({ desiredArchived: false, requiresDispatch: true });
    await test.manager.enqueue(undo);
    test.setResult(
      AsyncResult.failure(Cause.fail(new EnvironmentNotRegisteredError({ environmentId }))),
    );
    expect(await deliverThreadLifecycleIntent(undo, test.deps)).toBe(false);
    const attempted = test.current();
    expect(attempted).toMatchObject({
      commandId: undo.commandId,
      dispatchedAction: "cancel-archive",
    });

    // Reconnected: the archive landed meanwhile, so the action is now unarchive.
    test.setActions(["unarchive"]);
    test.setResult(AsyncResult.success({ sequence: 1 }));
    expect(await deliverThreadLifecycleIntent(attempted!, test.deps)).toBe(false);
    expect(test.dispatched).toHaveLength(1);
    const rotated = test.current();
    expect(rotated?.commandId).not.toBe(undo.commandId);

    expect(await deliverThreadLifecycleIntent(rotated!, test.deps)).toBe(true);
    expect(test.dispatched.at(-1)).toMatchObject({
      action: "unarchive",
      intent: { commandId: rotated?.commandId },
    });
    expect(test.current()).toBeUndefined();
  });

  it("drops a superseded Undo when the user archives again", async () => {
    const test = harness(["unarchive"]);
    const undo = intent({
      desiredArchived: false,
      requiresDispatch: true,
      dispatchAttempted: true,
    });
    await test.manager.enqueue(undo);
    const rearchive = intent({
      requiresDispatch: threadLifecycleRevisionRequiresDispatch(undo),
      commandId: CommandId.make("command-rearchive"),
    });
    await test.manager.enqueue(rearchive);

    expect(await deliverThreadLifecycleIntent(undo, test.deps)).toBe(true);
    expect(test.dispatched).toEqual([]);
    expect(test.current()).toBe(rearchive);
  });

  it("holds an Undo until the shell shows the archive it sent", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadLifecycleOutboxManager({ registry, storage: memoryStorage() });
    const fence = createThreadLifecycleDispatchFence();
    let shell: { sequence: number; thread: typeof idle | typeof pendingArchive } = {
      sequence: 1,
      thread: idle,
    };
    const dispatched: Array<{ action: ThreadLifecycleDispatchAction; commandId: CommandId }> = [];
    let dispatchStarted = deferred<void>();
    let response = deferred<AsyncResult.Success<OrchestrationV2DispatchCommandResult, unknown>>();
    const current = () => registry.get(manager.intentsByThreadKeyAtom)[key];
    const deps = {
      manager,
      loadMessageOutbox: async () => true,
      readAction: (candidate: ThreadLifecycleIntent): ThreadLifecycleOutboxAction =>
        fence.holds(environmentId, shell.sequence)
          ? "wait"
          : resolveThreadLifecycleOutboxAction({ ...live, ...candidate, thread: shell.thread }),
      dispatch: (action: ThreadLifecycleDispatchAction, candidate: ThreadLifecycleIntent) => {
        dispatched.push({ action, commandId: candidate.commandId });
        dispatchStarted.resolve();
        return response.promise;
      },
      onSettled: (_candidate: ThreadLifecycleIntent, sequence: number | null) => {
        if (sequence !== null) fence.record(environmentId, sequence);
      },
      threadActive: () => true,
      newCommandId: () => CommandId.make("command-rotated"),
    };

    const archive = intent();
    await manager.enqueue(archive);
    const archiveDelivery = deliverThreadLifecycleIntent(archive, deps);
    await dispatchStarted.promise;
    // Undo while the archive's response is in flight.
    const undo = intent({
      desiredArchived: false,
      requiresDispatch: threadLifecycleRevisionRequiresDispatch(current()),
      commandId: CommandId.make("command-undo"),
    });
    await manager.enqueue(undo);
    response.resolve(AsyncResult.success({ sequence: 7 }));
    expect(await archiveDelivery).toBe(true);
    expect(current()).toBe(undo);

    // The shell has not applied the deferred archive yet: nothing is sent.
    expect(await deliverThreadLifecycleIntent(undo, deps)).toBe(true);
    expect(dispatched).toHaveLength(1);

    shell = { sequence: 7, thread: pendingArchive };
    dispatchStarted = deferred<void>();
    response = deferred();
    const undoDelivery = deliverThreadLifecycleIntent(current()!, deps);
    await dispatchStarted.promise;
    expect(dispatched.at(-1)).toEqual({ action: "cancel-archive", commandId: undo.commandId });
    expect(current()?.commandId).toBe(undo.commandId);
    response.resolve(AsyncResult.success({ sequence: 8 }));
    expect(await undoDelivery).toBe(true);
    expect(current()).toBeUndefined();
  });
});

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}
