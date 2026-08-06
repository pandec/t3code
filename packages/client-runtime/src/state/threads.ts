import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type MessageId,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadMessagePage,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase, type PreparedConnection } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { ThreadMessagePageLoader } from "./threadMessagesHttp.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import {
  coalesceThreadStreamItems,
  isStructuralThreadStreamItem,
  THREAD_EVENT_FOREGROUND_WINDOW_MS,
  ThreadEventCoalescing,
} from "./threadEventCoalescing.ts";
import {
  applyThreadDetailEvent,
  prependOlderThreadMessages,
  retainRecentThreadHistory,
} from "./threadReducer.ts";
import {
  DEFAULT_MESSAGE_OLDER_PAGE_SIZE,
  DEFAULT_MESSAGE_WINDOW_LIMIT,
  ThreadHistoryWindow,
  THREAD_STATE_IDLE_TTL_MS,
} from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

export interface EnvironmentThreadStateHandle {
  readonly state: SubscriptionRef.SubscriptionRef<EnvironmentThreadState>;
  readonly loadOlderMessages: Effect.Effect<void>;
}

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function shouldPersistThread(thread: OrchestrationThread): boolean {
  const status = thread.session?.status;
  return status !== "starting" && status !== "running";
}

function preserveLoadedOlderMessages(
  current: OrchestrationThread,
  refreshed: OrchestrationThread,
  loadedOlderCount: number,
): OrchestrationThread {
  if (loadedOlderCount === 0) return refreshed;

  const firstRefreshedMessageId = refreshed.messages[0]?.id;
  if (firstRefreshedMessageId === undefined) return refreshed;

  const firstRefreshedIndex = current.messages.findIndex(
    (message) => message.id === firstRefreshedMessageId,
  );
  if (firstRefreshedIndex < 0) return refreshed;

  const candidates = current.messages.slice(0, firstRefreshedIndex);
  const totalCount = refreshed.messageWindow?.totalCount ?? null;
  const preserveCount =
    totalCount === null
      ? candidates.length
      : Math.min(candidates.length, Math.max(0, totalCount - refreshed.messages.length));
  const preservedOlder = preserveCount === 0 ? [] : candidates.slice(-preserveCount);
  if (preservedOlder.length === 0) return refreshed;
  const messages = [...preservedOlder, ...refreshed.messages];
  return {
    ...refreshed,
    messages,
    messageWindow: {
      hasMoreOlder:
        totalCount === null
          ? (current.messageWindow?.hasMoreOlder ?? refreshed.messageWindow?.hasMoreOlder ?? false)
          : messages.length < totalCount,
      oldestLoadedMessageId: messages[0]?.id ?? null,
      totalCount,
    },
  };
}

function mergeThreadMessageArtifacts(
  current: OrchestrationThread,
  refreshed: OrchestrationThread,
  hydrateCompletedResponseIds: boolean,
): OrchestrationThread {
  const refreshedById = new Map(refreshed.messages.map((message) => [message.id, message]));
  return {
    ...current,
    completedTurnAssistantMessageIds: hydrateCompletedResponseIds
      ? refreshed.completedTurnAssistantMessageIds
      : current.completedTurnAssistantMessageIds,
    messages: current.messages.map((message) => {
      const refreshedMessage = refreshedById.get(message.id);
      if (refreshedMessage === undefined || refreshedMessage.text !== message.text) return message;
      const { generatedSummary: _summary, speech: _speech, ...base } = message;
      return {
        ...base,
        ...(refreshedMessage.generatedSummary === undefined
          ? {}
          : { generatedSummary: refreshedMessage.generatedSummary }),
        ...(refreshedMessage.speech === undefined ? {} : { speech: refreshedMessage.speech }),
      };
    }),
  };
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const scope = yield* Effect.scope;
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const messagePageLoader = yield* Effect.serviceOption(ThreadMessagePageLoader);
  const configuredHistoryWindow = yield* Effect.serviceOption(ThreadHistoryWindow);
  const historyWindow = Option.getOrElse(configuredHistoryWindow, () => ({
    messageWindowLimit: DEFAULT_MESSAGE_WINDOW_LIMIT,
    messageOlderPageSize: DEFAULT_MESSAGE_OLDER_PAGE_SIZE,
  }));
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const eventCoalescing = yield* Effect.serviceOption(ThreadEventCoalescing);
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) =>
    retainRecentThreadHistory(snapshot.thread, {
      messageWindowLimit: historyWindow.messageWindowLimit,
    }),
  );
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
    olderMessages: { isLoading: false, error: null },
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  const lastRevertSequence = yield* Ref.make(0);
  const loadedOlderMessageCount = yield* Ref.make(0);
  const mutationLock = yield* Semaphore.make(1);
  const pendingItems = yield* Ref.make<Array<OrchestrationThreadStreamItem>>([]);
  const flushGeneration = yield* Ref.make(0);
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);
  const artifactRefreshes = yield* Queue.sliding<PreparedConnection>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    const stored = yield* cache.loadThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not inspect the thread cache before persisting.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
          Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
        ),
      ),
    );
    if (Option.isSome(stored) && stored.value.snapshotSequence > snapshot.snapshotSequence) {
      return;
    }
    const retainedSnapshot = {
      ...snapshot,
      thread: retainRecentThreadHistory(snapshot.thread, {
        messageWindowLimit: historyWindow.messageWindowLimit,
      }),
    };
    yield* cache.saveThread(environmentId, retainedSnapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setSynchronizing = SubscriptionRef.update(state, (current) =>
    current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(formatThreadError(cause)),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationThread,
    messageWindowLimit: number | null = historyWindow.messageWindowLimit,
  ) {
    const retainedThread = retainRecentThreadHistory(thread, { messageWindowLimit });
    const waiting = yield* Ref.get(awaitingCompletion);
    const currentState = yield* SubscriptionRef.get(state);
    yield* SubscriptionRef.set(state, {
      data: Option.some(retainedThread),
      status: waiting ? "synchronizing" : "live",
      error: Option.none(),
      olderMessages: currentState.olderMessages,
    });
    // Active threads can update many times per second and retain large tool
    // payloads. The server remains the source of truth while a turn is active;
    // persist once it settles so cache encoding stays off the streaming path.
    if (shouldPersistThread(retainedThread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, { snapshotSequence, thread: retainedThread });
    }
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
      olderMessages: { isLoading: false, error: null },
    });
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  const loadOlderMessages = Effect.fn("EnvironmentThreadState.loadOlderMessages")(function* () {
    const request = yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        yield* flushPendingUnlocked();
        const current = yield* SubscriptionRef.get(state);
        if (
          current.status === "deleted" ||
          current.olderMessages.isLoading ||
          Option.isNone(current.data) ||
          current.data.value.messageWindow?.hasMoreOlder !== true
        ) {
          return Option.none<{
            readonly prepared: PreparedConnection;
            readonly beforeMessageId: MessageId | null;
            readonly sequence: number;
          }>();
        }

        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared)) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            olderMessages: { isLoading: false, error: "The environment is not connected." },
          }));
          return Option.none();
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        yield* SubscriptionRef.update(state, (value) => ({
          ...value,
          olderMessages: { isLoading: true, error: null },
        }));
        return Option.some({
          prepared: prepared.value,
          beforeMessageId: current.data.value.messageWindow.oldestLoadedMessageId,
          sequence,
        });
      }),
    );
    if (Option.isNone(request)) return;

    const page = Option.isNone(messagePageLoader)
      ? Option.none<OrchestrationThreadMessagePage>()
      : yield* messagePageLoader.value.loadOlder(request.value.prepared, threadId, {
          beforeMessageId: request.value.beforeMessageId,
          limit: historyWindow.messageOlderPageSize,
        });

    yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        yield* flushPendingUnlocked();
        const current = yield* SubscriptionRef.get(state);
        if (current.status === "deleted" || Option.isNone(current.data)) return;

        const revertedAt = yield* Ref.get(lastRevertSequence);
        const currentCursor = current.data.value.messageWindow?.oldestLoadedMessageId ?? null;
        if (
          revertedAt > request.value.sequence ||
          currentCursor !== request.value.beforeMessageId
        ) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            olderMessages: { isLoading: false, error: null },
          }));
          return;
        }
        if (Option.isNone(page) || page.value.threadId !== threadId) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            olderMessages: { isLoading: false, error: "Could not load older messages." },
          }));
          return;
        }
        if (page.value.snapshotSequence < revertedAt) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            olderMessages: { isLoading: false, error: null },
          }));
          return;
        }

        const currentThread = current.data.value;
        const thread = prependOlderThreadMessages(currentThread, page.value);
        yield* Ref.update(
          loadedOlderMessageCount,
          (count) => count + Math.max(0, thread.messages.length - currentThread.messages.length),
        );
        yield* SubscriptionRef.set(state, {
          ...current,
          data: Option.some(thread),
          olderMessages: { isLoading: false, error: null },
        });
        if (shouldPersistThread(thread)) {
          const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
          yield* Queue.offer(persistence, { snapshotSequence, thread });
        }
      }),
    );
  });

  const applyItemsUnlocked = Effect.fn("EnvironmentThreadState.applyItemsUnlocked")(function* (
    items: ReadonlyArray<OrchestrationThreadStreamItem>,
  ) {
    if (items.length === 0) return;

    const initialSequence = yield* SubscriptionRef.get(lastSequence);
    const initialRevertSequence = yield* Ref.get(lastRevertSequence);
    const initialLoadedOlderCount = yield* Ref.get(loadedOlderMessageCount);
    const initialState = yield* SubscriptionRef.get(state);
    let sequence = initialSequence;
    let revertSequence = initialRevertSequence;
    let loadedOlderCount = initialLoadedOlderCount;
    let data = initialState.data;
    let threadChanged = false;
    let deleted = false;
    let synchronized = false;

    for (const item of coalesceThreadStreamItems(items)) {
      if (item.kind === "synchronized") {
        synchronized = true;
        continue;
      }
      if (item.kind === "snapshot") {
        sequence = item.snapshot.snapshotSequence;
        loadedOlderCount = 0;
        data = Option.some(item.snapshot.thread);
        threadChanged = true;
        deleted = false;
        continue;
      }
      if (item.event.sequence <= sequence) continue;
      sequence = item.event.sequence;
      if (item.event.type === "thread.reverted") {
        revertSequence = item.event.sequence;
      }

      if (Option.isNone(data)) {
        if (item.event.type === "thread.deleted") deleted = true;
        continue;
      }
      const retainedLimit =
        historyWindow.messageWindowLimit === null
          ? null
          : historyWindow.messageWindowLimit + loadedOlderCount;
      const result = applyThreadDetailEvent(data.value, item.event, {
        messageWindowLimit: retainedLimit,
      });
      if (result.kind === "updated") {
        if (item.event.type === "thread.reverted") {
          loadedOlderCount = Math.min(loadedOlderCount, result.thread.messages.length);
        }
        data = Option.some(result.thread);
        threadChanged = true;
      } else if (result.kind === "deleted") {
        data = Option.none();
        threadChanged = false;
        deleted = true;
      }
    }

    if (sequence !== initialSequence) {
      yield* SubscriptionRef.set(lastSequence, sequence);
    }
    if (revertSequence !== initialRevertSequence) {
      yield* Ref.set(lastRevertSequence, revertSequence);
    }
    if (loadedOlderCount !== initialLoadedOlderCount) {
      yield* Ref.set(loadedOlderMessageCount, loadedOlderCount);
    }
    if (deleted) {
      yield* setDeleted();
    } else if (threadChanged && Option.isSome(data)) {
      const retainedLimit =
        historyWindow.messageWindowLimit === null
          ? null
          : historyWindow.messageWindowLimit + loadedOlderCount;
      yield* setThread(data.value, retainedLimit);
    }
    if (synchronized) {
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted"
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
    }
  });

  const flushPendingUnlocked = Effect.fn("EnvironmentThreadState.flushPendingUnlocked")(
    function* () {
      yield* Ref.update(flushGeneration, (generation) => generation + 1);
      const pending = yield* Ref.getAndSet(pendingItems, []);
      yield* applyItemsUnlocked(pending);
    },
  );
  const flushPending = mutationLock.withPermits(1)(flushPendingUnlocked());
  const scheduleFlush = Effect.fn("EnvironmentThreadState.scheduleFlush")(function* (
    generation: number,
    windowMs: number,
  ) {
    yield* Effect.sleep(Duration.millis(windowMs));
    yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(flushGeneration)) !== generation) return;
        yield* flushPendingUnlocked();
      }),
    );
  });
  const acceptItem = Effect.fn("EnvironmentThreadState.acceptItem")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        if (isStructuralThreadStreamItem(item)) {
          const pending = yield* Ref.getAndSet(pendingItems, []);
          yield* Ref.update(flushGeneration, (generation) => generation + 1);
          yield* applyItemsUnlocked([...pending, item]);
          return;
        }

        const priority = yield* Option.match(eventCoalescing, {
          onNone: () => Effect.succeed("foreground" as const),
          onSome: (service) =>
            service.priority({
              environmentId,
              threadId,
            }),
        });
        const windowMs = Option.match(eventCoalescing, {
          onNone: () => THREAD_EVENT_FOREGROUND_WINDOW_MS,
          onSome: (service) => service.windowMs(priority),
        });
        if (windowMs <= 0) {
          const pending = yield* Ref.getAndSet(pendingItems, []);
          yield* Ref.update(flushGeneration, (generation) => generation + 1);
          yield* applyItemsUnlocked([...pending, item]);
          return;
        }

        const pending = yield* Ref.get(pendingItems);
        const wasEmpty = pending.length === 0;
        pending.push(item);
        if (wasEmpty) {
          const generation = yield* Ref.updateAndGet(flushGeneration, (current) => current + 1);
          yield* Effect.forkIn(scheduleFlush(generation, windowMs), scope);
        }
      }),
    );
    if (item.kind !== "event" || item.event.type !== "thread.reverted") return;

    const current = yield* SubscriptionRef.get(state);
    if (
      Option.isSome(current.data) &&
      current.data.value.messages.length === 0 &&
      current.data.value.messageWindow?.hasMoreOlder === true
    ) {
      yield* loadOlderMessages();
    }
  });

  const refreshWarmSnapshot = Effect.fn("EnvironmentThreadState.refreshWarmSnapshot")(function* (
    prepared: PreparedConnection,
  ) {
    const httpSnapshot = yield* snapshotLoader.load(
      prepared,
      threadId,
      historyWindow.messageWindowLimit === null
        ? undefined
        : { messageLimit: historyWindow.messageWindowLimit },
    );
    if (Option.isNone(httpSnapshot)) return;
    yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        yield* flushPendingUnlocked();
        const currentState = yield* SubscriptionRef.get(state);
        if (currentState.status === "deleted" || Option.isNone(currentState.data)) return;

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const loadedOlderCount = yield* Ref.get(loadedOlderMessageCount);
        const retainedLimit =
          historyWindow.messageWindowLimit === null
            ? null
            : historyWindow.messageWindowLimit + loadedOlderCount;
        if (httpSnapshot.value.snapshotSequence > sequence) {
          yield* SubscriptionRef.set(lastSequence, httpSnapshot.value.snapshotSequence);
          const refreshed = preserveLoadedOlderMessages(
            currentState.data.value,
            httpSnapshot.value.thread,
            loadedOlderCount,
          );
          const refreshedOlderCount = Math.max(
            0,
            refreshed.messages.length - httpSnapshot.value.thread.messages.length,
          );
          yield* Ref.set(loadedOlderMessageCount, refreshedOlderCount);
          yield* setThread(
            refreshed,
            historyWindow.messageWindowLimit === null
              ? null
              : historyWindow.messageWindowLimit + refreshedOlderCount,
          );
          return;
        }
        yield* setThread(
          mergeThreadMessageArtifacts(
            currentState.data.value,
            httpSnapshot.value.thread,
            httpSnapshot.value.snapshotSequence === sequence,
          ),
          retainedLimit,
        );
      }),
    );
  });

  yield* Stream.fromQueue(artifactRefreshes).pipe(
    Stream.runForEach(refreshWarmSnapshot),
    Effect.forkScoped,
  );

  if (Option.isSome(eventCoalescing)) {
    yield* eventCoalescing.value.changes.pipe(
      Stream.filter(
        (change) =>
          change.threadRef.environmentId === environmentId &&
          change.threadRef.threadId === threadId,
      ),
      Stream.runForEach(() => flushPending),
      Effect.forkScoped,
    );
  }

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return flushPending.pipe(Effect.andThen(setSynchronizing));
        case "disconnected":
          return flushPending.pipe(Effect.andThen(setDisconnected));
        case "ready":
          return flushPending.pipe(Effect.andThen(setReady));
      }
    }),
    Effect.forkScoped,
  );

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        const supportsCompletionMarker = yield* session.initialConfig.pipe(
          Effect.map((config) => config.threadResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
        );
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;
        yield* flushPending;

        let current = yield* SubscriptionRef.get(state);
        if (current.status !== "deleted") {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          if (Option.isNone(current.data)) {
            const httpSnapshot = yield* snapshotLoader.load(
              prepared,
              threadId,
              historyWindow.messageWindowLimit === null
                ? undefined
                : { messageLimit: historyWindow.messageWindowLimit },
            );
            if (Option.isSome(httpSnapshot)) {
              yield* acceptItem({ kind: "snapshot", snapshot: httpSnapshot.value });
              current = yield* SubscriptionRef.get(state);
            }
          } else {
            yield* Queue.offer(artifactRefreshes, prepared);
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data);
        if (!supportsCompletionMarker && canResume) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(historyWindow.messageWindowLimit === null
            ? {}
            : { messageLimit: historyWindow.messageWindowLimit }),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
        };
      }),
      {
        onExpectedFailure: (cause) => flushPending.pipe(Effect.andThen(setStreamError(cause))),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEach(acceptItem)),
  );

  yield* Effect.addFinalizer(() =>
    flushPending.pipe(
      Effect.andThen(Effect.all([SubscriptionRef.get(state), SubscriptionRef.get(lastSequence)])),
      Effect.flatMap(([current, snapshotSequence]) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: (thread) =>
            shouldPersistThread(thread) ? persist({ snapshotSequence, thread }) : Effect.void,
        }),
      ),
    ),
  );

  return {
    state,
    loadOlderMessages: loadOlderMessages(),
  } satisfies EnvironmentThreadStateHandle;
});

interface EnvironmentThreadStateEntry {
  readonly state: EnvironmentThreadState;
  readonly loadOlderMessages: Effect.Effect<void>;
}

const EMPTY_ENVIRONMENT_THREAD_STATE_ENTRY: EnvironmentThreadStateEntry = {
  state: EMPTY_ENVIRONMENT_THREAD_STATE,
  loadOlderMessages: Effect.void,
};

function threadStateEntryChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentThreadState(threadId).pipe(
        Effect.map((handle) =>
          SubscriptionRef.changes(handle.state).pipe(
            Stream.map(
              (state): EnvironmentThreadStateEntry => ({
                state,
                loadOlderMessages: handle.loadOlderMessages,
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

export function threadStateChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return threadStateEntryChanges(environmentId, threadId).pipe(Stream.map((entry) => entry.state));
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
) {
  const entryFamily = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateEntryChanges(environmentId, threadId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE_ENTRY,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-entry:${key}`),
      );
  });
  const stateFamily = Atom.family((key: string) =>
    Atom.make((get) => AsyncResult.map(get(entryFamily(key)), (entry) => entry.state)).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-state:${key}`),
    ),
  );
  const loadOlderMessagesFamily = Atom.family((key: string) => {
    const entryAtom = entryFamily(key);
    return runtime
      .fn<void>()((_input, get) =>
        get.result(entryAtom).pipe(Effect.flatMap((entry) => entry.loadOlderMessages)),
      )
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-load-older-messages:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      stateFamily(threadKey({ environmentId, threadId })),
    loadOlderMessagesAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      loadOlderMessagesFamily(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./threadPrewarm.ts";
export * from "./threadMessagesHttp.ts";
export * from "./threadRetention.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadEventCoalescing.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
