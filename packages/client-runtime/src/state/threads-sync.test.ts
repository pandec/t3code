import {
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadMessagePage,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  ThreadEventCoalescing,
  ThreadHistoryWindow,
  ThreadMessagePageLoader,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
  type ThreadEventPriority,
} from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = ThreadId.make("thread-1");
const CACHED_SNAPSHOT_SEQUENCE = 7;
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const BASE_THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Cached thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  completedTurnAssistantMessageIds: [],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};
function makeThreadMessage(index: number): OrchestrationThread["messages"][number] {
  const timestamp = `2026-04-01T00:${String(index).padStart(2, "0")}:00.000Z`;
  return {
    id: MessageId.make(`message-${index}`),
    role: index % 2 === 0 ? "assistant" : "user",
    text: `Message ${index}`,
    turnId: null,
    streaming: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const ACTIVE_THREAD: OrchestrationThread = {
  ...BASE_THREAD,
  latestTurn: {
    turnId: TurnId.make("turn-1"),
    state: "running",
    requestedAt: "2026-04-01T00:01:00.000Z",
    startedAt: "2026-04-01T00:01:00.000Z",
    completedAt: null,
    assistantMessageId: null,
  },
  session: {
    threadId: THREAD_ID,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: TurnId.make("turn-1"),
    lastError: null,
    updatedAt: "2026-04-01T00:01:00.000Z",
  },
};

type TestThreadInput = OrchestrationThreadStreamItem | Error;

function testSession(
  client: WsRpcProtocolClient,
  options?: { readonly completionMarker?: boolean },
): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(
      options?.completionMarker === true
        ? ({ threadResumeCompletionMarker: true } as never)
        : ({} as never),
    ),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function awaitThreadState(
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return Queue.take(observed).pipe(
    Effect.repeat({
      until: predicate,
    }),
  );
}

const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (options?: {
  readonly cached?: OrchestrationThread;
  readonly httpSnapshot?: Option.Option<OrchestrationThreadDetailSnapshot>;
  readonly snapshotLoadGate?: Deferred.Deferred<void>;
  readonly messagePage?: Option.Option<OrchestrationThreadMessagePage>;
  readonly messagePageForBefore?: (
    beforeMessageId: MessageId | null,
  ) => Option.Option<OrchestrationThreadMessagePage>;
  readonly messagePageLoadGate?: Deferred.Deferred<void>;
  readonly messageWindowLimit?: number;
  readonly messageOlderPageSize?: number;
  readonly completionMarker?: boolean;
  readonly initialEventPriority?: ThreadEventPriority;
  readonly foregroundWindowMs?: number;
  readonly backgroundWindowMs?: number;
  // Makes `cache.saveThread` sleep (on the virtual `TestClock`) before
  // committing whenever the snapshot's thread title matches `title`. This
  // reproduces the fact that a real cache write crosses a genuine async
  // boundary, so a test can deterministically control, via `TestClock`
  // alarms, whether a stale in-flight write lands before or after another
  // write without racing on scheduler internals.
  readonly saveThreadDelay?: { readonly title: string; readonly millis: number };
}) {
  const inputs = yield* Queue.unbounded<TestThreadInput>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
  const publicationCount = yield* Ref.make(0);
  const retryCount = yield* Ref.make(0);
  const subscriptionCount = yield* Ref.make(0);
  const loaderCalls = yield* Ref.make(0);
  const messagePageLoaderCalls = yield* Ref.make(0);
  const lastMessagePageBefore = yield* Ref.make<MessageId | null | undefined>(undefined);
  const lastSubscribeAfterSequence = yield* Ref.make<number | undefined>(undefined);
  const lastSubscribeMessageLimit = yield* Ref.make<number | undefined>(undefined);
  const lastRequestCompletionMarker = yield* Ref.make<boolean | undefined>(undefined);
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationThreadDetailSnapshot>>([]);
  const cachedThreadSnapshot = yield* Ref.make<Option.Option<OrchestrationThreadDetailSnapshot>>(
    options?.cached === undefined
      ? Option.none()
      : Option.some({
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          thread: options.cached,
        }),
  );
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
  const eventPriority = yield* Ref.make<ThreadEventPriority>(
    options?.initialEventPriority ?? "foreground",
  );
  const eventPriorityChanges = yield* Queue.unbounded<{
    readonly threadRef: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
    readonly priority: ThreadEventPriority;
  }>();
  const eventCoalescing = ThreadEventCoalescing.of({
    changes: Stream.fromQueue(eventPriorityChanges),
    priority: () => Ref.get(eventPriority),
    windowMs: (priority) =>
      priority === "foreground"
        ? (options?.foregroundWindowMs ?? 50)
        : (options?.backgroundWindowMs ?? 750),
    setPriority: (threadRef, priority) =>
      Ref.set(eventPriority, priority).pipe(
        Effect.andThen(Queue.offer(eventPriorityChanges, { threadRef, priority })),
        Effect.asVoid,
      ),
    setForeground: (threadRef) => {
      const priority = threadRef === null ? "background" : "foreground";
      return Ref.set(eventPriority, priority).pipe(
        Effect.andThen(
          Queue.offer(eventPriorityChanges, {
            threadRef: threadRef ?? { environmentId: TARGET.environmentId, threadId: THREAD_ID },
            priority,
          }),
        ),
        Effect.asVoid,
      );
    },
  });
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const streamFrom = (queue: Queue.Queue<TestThreadInput>) =>
    Stream.fromQueue(queue).pipe(
      Stream.mapEffect((input) =>
        input instanceof Error ? Effect.fail(input) : Effect.succeed(input),
      ),
    );
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: {
      readonly afterSequence?: number;
      readonly messageLimit?: number;
      readonly requestCompletionMarker?: boolean;
    }) =>
      Stream.unwrap(
        Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
          Effect.andThen(Ref.set(lastSubscribeAfterSequence, input.afterSequence)),
          Effect.andThen(Ref.set(lastSubscribeMessageLimit, input.messageLimit)),
          Effect.andThen(Ref.set(lastRequestCompletionMarker, input.requestCompletionMarker)),
          Effect.as(streamFrom(inputs)),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(
      testSession(
        client,
        options?.completionMarker === true ? { completionMarker: true } : undefined,
      ),
    ),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const snapshotLoader = ThreadSnapshotLoader.of({
    load: (_prepared, threadId) =>
      Ref.update(loaderCalls, (count) => count + 1).pipe(
        Effect.andThen(
          options?.snapshotLoadGate === undefined
            ? Effect.void
            : Deferred.await(options.snapshotLoadGate),
        ),
        Effect.as(
          threadId === THREAD_ID
            ? (options?.httpSnapshot ?? Option.none<OrchestrationThreadDetailSnapshot>())
            : Option.none<OrchestrationThreadDetailSnapshot>(),
        ),
      ),
  });
  const messagePageLoader = ThreadMessagePageLoader.of({
    loadOlder: (_prepared, threadId, pageOptions) =>
      Ref.update(messagePageLoaderCalls, (count) => count + 1).pipe(
        Effect.andThen(Ref.set(lastMessagePageBefore, pageOptions.beforeMessageId)),
        Effect.andThen(
          options?.messagePageLoadGate === undefined
            ? Effect.void
            : Deferred.await(options.messagePageLoadGate),
        ),
        Effect.as(
          threadId === THREAD_ID
            ? (options?.messagePageForBefore?.(pageOptions.beforeMessageId) ??
                options?.messagePage ??
                Option.none<OrchestrationThreadMessagePage>())
            : Option.none<OrchestrationThreadMessagePage>(),
        ),
      ),
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      threadId === THREAD_ID ? Ref.get(cachedThreadSnapshot) : Effect.succeed(Option.none()),
    saveThread: (_environmentId, thread) =>
      (options?.saveThreadDelay !== undefined &&
      thread.thread.title === options.saveThreadDelay.title
        ? Effect.sleep(`${options.saveThreadDelay.millis} millis`)
        : Effect.void
      ).pipe(
        Effect.andThen(Ref.set(cachedThreadSnapshot, Option.some(thread))),
        Effect.andThen(Ref.update(savedThreads, (current) => [...current, thread])),
      ),
    removeThread: (_environmentId, threadId) =>
      Ref.update(removedThreads, (current) => [...current, threadId]),
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const threadHandle = yield* makeEnvironmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader, snapshotLoader),
    Effect.provideService(ThreadMessagePageLoader, messagePageLoader),
    Effect.provideService(
      ThreadHistoryWindow,
      ThreadHistoryWindow.of({
        messageWindowLimit: options?.messageWindowLimit ?? 2_000,
        messageOlderPageSize: options?.messageOlderPageSize ?? 200,
      }),
    ),
    Effect.provideService(ThreadEventCoalescing, eventCoalescing),
    Effect.provideService(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
    ),
  );
  yield* SubscriptionRef.changes(threadHandle.state).pipe(
    Stream.runForEach((state) =>
      Ref.set(latest, state).pipe(
        Effect.andThen(Ref.update(publicationCount, (count) => count + 1)),
        Effect.andThen(Queue.offer(observed, state)),
      ),
    ),
    Effect.forkScoped,
  );

  return {
    inputs,
    observed,
    state: threadHandle.state,
    loadOlderMessages: threadHandle.loadOlderMessages,
    latest,
    publicationCount,
    retryCount,
    subscriptionCount,
    loaderCalls,
    messagePageLoaderCalls,
    lastMessagePageBefore,
    lastSubscribeAfterSequence,
    lastSubscribeMessageLimit,
    lastRequestCompletionMarker,
    supervisorState,
    supervisorSession,
    savedThreads,
    cachedThreadSnapshot,
    removedThreads,
    wakeups,
    eventPriority,
    prepared,
    setEventPriority: (priority: ThreadEventPriority) =>
      eventCoalescing.setPriority(
        { environmentId: TARGET.environmentId, threadId: THREAD_ID },
        priority,
      ),
    replaceSession: SubscriptionRef.set(
      supervisorSession,
      Option.some(
        testSession(
          client,
          options?.completionMarker === true ? { completionMarker: true } : undefined,
        ),
      ),
    ),
  };
});

const snapshot = (
  thread: OrchestrationThread,
  snapshotSequence = 1,
): OrchestrationThreadStreamItem => ({
  kind: "snapshot",
  snapshot: {
    snapshotSequence,
    thread,
  },
});

const synchronized = (): OrchestrationThreadStreamItem => ({ kind: "synchronized" });

const titleUpdated = (title: string, sequence = 2): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-title"),
    sequence,
    occurredAt: "2026-04-01T01:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.meta-updated",
    payload: {
      threadId: THREAD_ID,
      title,
      updatedAt: "2026-04-01T01:00:00.000Z",
    },
  },
});

const messageDelta = (
  text: string,
  sequence: number,
  messageId = MessageId.make("message-streaming"),
): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-message-${sequence}`),
    sequence,
    occurredAt: `2026-04-01T01:00:${String(sequence).padStart(2, "0")}.000Z`,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.message-sent",
    payload: {
      threadId: THREAD_ID,
      messageId,
      role: "assistant",
      text,
      turnId: TurnId.make("turn-1"),
      streaming: true,
      createdAt: "2026-04-01T01:00:00.000Z",
      updatedAt: `2026-04-01T01:00:${String(sequence).padStart(2, "0")}.000Z`,
    },
  },
});

const reverted = (turnCount: number, sequence: number): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-reverted-${sequence}`),
    sequence,
    occurredAt: "2026-04-01T01:01:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.reverted",
    payload: { threadId: THREAD_ID, turnCount },
  },
});

const sessionSettled = (sequence: number): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-session-${sequence}`),
    sequence,
    occurredAt: "2026-04-01T01:01:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.session-set",
    payload: {
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status: "idle",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-04-01T01:01:00.000Z",
      },
    },
  },
});

const deleted = (sequence = 3): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-deleted"),
    sequence,
    occurredAt: "2026-04-01T02:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.deleted",
    payload: {
      threadId: THREAD_ID,
      deletedAt: "2026-04-01T02:00:00.000Z",
    },
  },
});

describe("EnvironmentThreads", () => {
  it.effect("publishes cached data immediately from a warm cache", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
      expect(Option.isNone(state.error)).toBe(true);
    }),
  );

  it.effect("retains full history for a legacy cache when the page loader returns no page", () =>
    Effect.gen(function* () {
      const messages = Array.from({ length: 151 }, (_, index) => makeThreadMessage(index));
      const harness = yield* makeHarness({
        cached: { ...BASE_THREAD, messages },
        messageWindowLimit: 150,
        messagePage: Option.none(),
      });

      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));
      const thread = Option.getOrThrow(state.data);

      expect(thread.messages).toHaveLength(151);
      expect(thread.messageWindow).toBeUndefined();
    }),
  );

  it.effect("refreshes a warm cache before resuming from its sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });

      // The warm cache reaches live from the cached data, and a live event
      // applies on top of it.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      // The HTTP refresh can hydrate state stored outside orchestration events,
      // then the subscription still resumes from the cached sequence.
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(harness.lastSubscribeMessageLimit)).toBe(2_000);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
    }),
  );

  it.effect("prepends an older message page and updates the window", () =>
    Effect.gen(function* () {
      const recent = [makeThreadMessage(3), makeThreadMessage(4)];
      const harness = yield* makeHarness({
        cached: {
          ...BASE_THREAD,
          messages: recent,
          messageWindow: {
            hasMoreOlder: true,
            oldestLoadedMessageId: recent[0]!.id,
            totalCount: 4,
          },
        },
        messageWindowLimit: 2,
        messageOlderPageSize: 2,
        messagePage: Option.some({
          threadId: THREAD_ID,
          messages: [makeThreadMessage(1), makeThreadMessage(2)],
          hasMoreOlder: false,
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
        }),
      });
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      yield* harness.loadOlderMessages;
      const state = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.messages.length === 4,
      );
      const thread = Option.getOrThrow(state.data);

      expect(thread.messages.map((message) => message.id)).toEqual([
        "message-1",
        "message-2",
        "message-3",
        "message-4",
      ]);
      expect(thread.messageWindow).toEqual({
        hasMoreOlder: false,
        oldestLoadedMessageId: "message-1",
        totalCount: 4,
      });
      expect(yield* Ref.get(harness.lastMessagePageBefore)).toBe("message-3");
      expect(yield* Ref.get(harness.messagePageLoaderCalls)).toBe(1);
      expect(state.olderMessages).toEqual({ isLoading: false, error: null, settledCount: 1 });

      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      expect(
        (yield* Ref.get(harness.savedThreads)).at(-1)?.thread.messages.map((message) => message.id),
      ).toEqual(["message-3", "message-4"]);
    }),
  );

  it.effect("reopens the 600-message scrollback cap when a revert frees capacity", () =>
    Effect.gen(function* () {
      const historyMessage = (index: number) => {
        const timestamp = `2026-04-01T00:00:00.${String(index).padStart(3, "0")}Z`;
        return {
          ...makeThreadMessage(index),
          turnId: TurnId.make("turn-1"),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      };
      const messageRange = (start: number, end: number) =>
        Array.from({ length: end - start + 1 }, (_, index) => historyMessage(start + index));
      const recent = messageRange(601, 750);
      const harness = yield* makeHarness({
        cached: {
          ...BASE_THREAD,
          messages: recent,
          messageWindow: {
            hasMoreOlder: true,
            oldestLoadedMessageId: recent[0]!.id,
            totalCount: 750,
          },
        },
        messageWindowLimit: 150,
        messageOlderPageSize: 100,
        messagePageForBefore: (beforeMessageId) => {
          const beforeIndex = beforeMessageId === null ? 751 : Number(beforeMessageId.slice(8));
          return Option.some({
            threadId: THREAD_ID,
            messages: messageRange(Math.max(1, beforeIndex - 100), beforeIndex - 1),
            hasMoreOlder: true,
            snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 1,
          });
        },
      });
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      for (const expectedLength of [250, 350, 450, 550, 650, 750]) {
        yield* harness.loadOlderMessages;
        yield* awaitThreadState(
          harness.observed,
          (value) =>
            Option.isSome(value.data) && value.data.value.messages.length === expectedLength,
        );
      }
      const capped = Option.getOrThrow((yield* Ref.get(harness.latest)).data);
      expect(capped.messages).toHaveLength(750);
      expect(capped.messageWindow?.hasMoreOlder).toBe(false);
      expect(yield* Ref.get(harness.messagePageLoaderCalls)).toBe(6);

      yield* harness.loadOlderMessages;
      const cappedAttempt = yield* awaitThreadState(
        harness.observed,
        (value) => value.olderMessages.settledCount === 7,
      );
      expect(cappedAttempt.olderMessages.isLoading).toBe(false);
      expect(yield* Ref.get(harness.messagePageLoaderCalls)).toBe(6);

      yield* Queue.offer(harness.inputs, reverted(0, CACHED_SNAPSHOT_SEQUENCE + 1));
      const refilled = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.messages[0]?.id === "message-651" &&
          value.olderMessages.settledCount === 8,
      );
      expect(Option.getOrThrow(refilled.data).messageWindow?.hasMoreOlder).toBe(true);
      expect(yield* Ref.get(harness.lastMessagePageBefore)).toBeNull();
      expect(yield* Ref.get(harness.messagePageLoaderCalls)).toBe(7);

      yield* harness.loadOlderMessages;
      const paged = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.messages[0]?.id === "message-551",
      );
      expect(Option.getOrThrow(paged.data).messageWindow?.hasMoreOlder).toBe(true);
      expect(yield* Ref.get(harness.messagePageLoaderCalls)).toBe(8);
    }),
  );

  it.effect("keeps server-reported exhausted history closed after a revert", () =>
    Effect.gen(function* () {
      const retainedMessage = {
        ...makeThreadMessage(1),
        turnId: TurnId.make("turn-1"),
      };
      const harness = yield* makeHarness({
        cached: {
          ...BASE_THREAD,
          messages: [retainedMessage],
          messageWindow: {
            hasMoreOlder: false,
            oldestLoadedMessageId: retainedMessage.id,
            totalCount: 1,
          },
        },
        foregroundWindowMs: 0,
      });
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      yield* harness.loadOlderMessages;
      const rejected = yield* awaitThreadState(
        harness.observed,
        (value) => value.olderMessages.settledCount === 1,
      );
      expect(rejected.olderMessages).toEqual({ isLoading: false, error: null, settledCount: 1 });
      expect(yield* Ref.get(harness.messagePageLoaderCalls)).toBe(0);

      yield* Queue.offer(harness.inputs, reverted(0, CACHED_SNAPSHOT_SEQUENCE + 1));
      const revertedState = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.messages.length === 0,
      );
      expect(Option.getOrThrow(revertedState.data).messageWindow?.hasMoreOlder).toBe(false);
      expect(revertedState.olderMessages.settledCount).toBe(1);
      expect(yield* Ref.get(harness.messagePageLoaderCalls)).toBe(0);
    }),
  );

  it.effect("preserves the settlement signal through thread updates and deletion", () =>
    Effect.gen(function* () {
      const recent = [makeThreadMessage(3), makeThreadMessage(4)];
      const harness = yield* makeHarness({
        cached: {
          ...BASE_THREAD,
          messages: recent,
          messageWindow: {
            hasMoreOlder: true,
            oldestLoadedMessageId: recent[0]!.id,
            totalCount: 4,
          },
        },
        foregroundWindowMs: 0,
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      yield* SubscriptionRef.set(harness.prepared, Option.none());

      yield* harness.loadOlderMessages;
      yield* awaitThreadState(harness.observed, (value) => value.olderMessages.settledCount === 1);

      yield* Queue.offer(
        harness.inputs,
        snapshot({ ...BASE_THREAD, title: "Updated title" }, CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      const updated = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.title === "Updated title",
      );
      expect(updated.olderMessages.settledCount).toBe(1);

      yield* Queue.offer(harness.inputs, deleted(CACHED_SNAPSHOT_SEQUENCE + 2));
      const deletedState = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );
      expect(deletedState.olderMessages).toEqual({
        isLoading: false,
        error: null,
        settledCount: 1,
      });
    }),
  );

  it.effect("flushes buffered events before loading and prepending an older page", () =>
    Effect.gen(function* () {
      const recent = [makeThreadMessage(3), makeThreadMessage(4)];
      const harness = yield* makeHarness({
        cached: {
          ...ACTIVE_THREAD,
          messages: recent,
          messageWindow: {
            hasMoreOlder: true,
            oldestLoadedMessageId: recent[0]!.id,
            totalCount: 4,
          },
        },
        messageWindowLimit: 2,
        messageOlderPageSize: 2,
        messagePage: Option.some({
          threadId: THREAD_ID,
          messages: [makeThreadMessage(2), makeThreadMessage(3)],
          hasMoreOlder: true,
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
        }),
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );

      yield* Queue.offer(harness.inputs, messageDelta("Buffered", CACHED_SNAPSHOT_SEQUENCE + 1));
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
      expect(Option.getOrThrow((yield* Ref.get(harness.latest)).data).messages).toHaveLength(2);

      yield* harness.loadOlderMessages;
      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.messages.at(-1)?.text === "Buffered" &&
          value.data.value.messages.length === 4,
      );

      expect(yield* Ref.get(harness.lastMessagePageBefore)).toBe("message-4");
      expect(Option.getOrThrow(state.data).messages.map((message) => message.id)).toEqual([
        "message-2",
        "message-3",
        "message-4",
        "message-streaming",
      ]);
    }),
  );

  it.effect("preserves contiguous loaded history across a newer warm refresh", () =>
    Effect.gen(function* () {
      const snapshotLoadGate = yield* Deferred.make<void>();
      const recent = [makeThreadMessage(3), makeThreadMessage(4)];
      const harness = yield* makeHarness({
        cached: {
          ...BASE_THREAD,
          messages: recent,
          messageWindow: {
            hasMoreOlder: true,
            oldestLoadedMessageId: recent[0]!.id,
            totalCount: 4,
          },
        },
        messageWindowLimit: 2,
        messageOlderPageSize: 2,
        snapshotLoadGate,
        httpSnapshot: Option.some({
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 1,
          thread: {
            ...BASE_THREAD,
            messages: [makeThreadMessage(4), makeThreadMessage(5)],
            messageWindow: {
              hasMoreOlder: true,
              oldestLoadedMessageId: MessageId.make("message-4"),
              totalCount: 5,
            },
          },
        }),
        messagePage: Option.some({
          threadId: THREAD_ID,
          messages: [makeThreadMessage(1), makeThreadMessage(2)],
          hasMoreOlder: false,
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
        }),
      });
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));
      yield* harness.loadOlderMessages;
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.messages.length === 4,
      );

      yield* Deferred.succeed(snapshotLoadGate, undefined);
      const refreshed = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.messages.at(-1)?.id === MessageId.make("message-5"),
      );

      expect(Option.getOrThrow(refreshed.data).messages.map((message) => message.id)).toEqual([
        "message-1",
        "message-2",
        "message-3",
        "message-4",
        "message-5",
      ]);
    }),
  );

  it.effect("discards an older page when a snapshot moves its cursor", () =>
    Effect.gen(function* () {
      const messagePageLoadGate = yield* Deferred.make<void>();
      const recent = [makeThreadMessage(3), makeThreadMessage(4)];
      const harness = yield* makeHarness({
        cached: {
          ...BASE_THREAD,
          messages: recent,
          messageWindow: {
            hasMoreOlder: true,
            oldestLoadedMessageId: recent[0]!.id,
            totalCount: 4,
          },
        },
        messageWindowLimit: 2,
        messageOlderPageSize: 2,
        messagePageLoadGate,
        messagePage: Option.some({
          threadId: THREAD_ID,
          messages: [makeThreadMessage(1), makeThreadMessage(2)],
          hasMoreOlder: false,
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
        }),
      });
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));
      yield* Effect.forkChild(harness.loadOlderMessages);
      yield* awaitThreadState(harness.observed, (value) => value.olderMessages.isLoading);

      const moved = [makeThreadMessage(4), makeThreadMessage(5)];
      yield* Queue.offer(
        harness.inputs,
        snapshot(
          {
            ...BASE_THREAD,
            messages: moved,
            messageWindow: {
              hasMoreOlder: true,
              oldestLoadedMessageId: moved[0]!.id,
              totalCount: 5,
            },
          },
          CACHED_SNAPSHOT_SEQUENCE + 1,
        ),
      );
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.messages[0]?.id === "message-4",
      );
      yield* Deferred.succeed(messagePageLoadGate, undefined);
      const settled = yield* awaitThreadState(
        harness.observed,
        (value) => !value.olderMessages.isLoading,
      );

      expect(Option.getOrThrow(settled.data).messages.map((message) => message.id)).toEqual([
        "message-4",
        "message-5",
      ]);
      expect(Option.getOrThrow(settled.data).messageWindow?.hasMoreOlder).toBe(true);
      expect(settled.olderMessages.settledCount).toBe(1);
    }),
  );

  it.effect(
    "discards an in-flight older page when a hard snapshot lands with the same cursor",
    () =>
      Effect.gen(function* () {
        const messagePageLoadGate = yield* Deferred.make<void>();
        const recent = [makeThreadMessage(3), makeThreadMessage(4)];
        const harness = yield* makeHarness({
          cached: {
            ...BASE_THREAD,
            messages: recent,
            messageWindow: {
              hasMoreOlder: true,
              oldestLoadedMessageId: recent[0]!.id,
              totalCount: 4,
            },
          },
          messageWindowLimit: 2,
          messageOlderPageSize: 2,
          messagePageLoadGate,
          messagePage: Option.some({
            threadId: THREAD_ID,
            messages: [makeThreadMessage(1), makeThreadMessage(2)],
            hasMoreOlder: false,
            snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          }),
        });
        yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));
        yield* Effect.forkChild(harness.loadOlderMessages);
        yield* awaitThreadState(harness.observed, (value) => value.olderMessages.isLoading);

        // A hard snapshot (e.g. after a reconnect/install) reinstalls the
        // exact same window, so the cursor comparison alone can't detect
        // that the in-flight page is now stale.
        yield* Queue.offer(
          harness.inputs,
          snapshot(
            {
              ...BASE_THREAD,
              messages: recent,
              messageWindow: {
                hasMoreOlder: true,
                oldestLoadedMessageId: recent[0]!.id,
                totalCount: 4,
              },
            },
            CACHED_SNAPSHOT_SEQUENCE + 1,
          ),
        );
        for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;

        yield* Deferred.succeed(messagePageLoadGate, undefined);
        const settled = yield* awaitThreadState(
          harness.observed,
          (value) => !value.olderMessages.isLoading,
        );

        // The stale page is discarded outright: messages stay exactly as the
        // hard snapshot installed them, and `hasMoreOlder` is retained rather
        // than being overwritten by the discarded page's `false`.
        expect(Option.getOrThrow(settled.data).messages.map((message) => message.id)).toEqual([
          "message-3",
          "message-4",
        ]);
        expect(Option.getOrThrow(settled.data).messageWindow?.hasMoreOlder).toBe(true);
        expect(Option.getOrThrow(settled.data).messageWindow?.oldestLoadedMessageId).toBe(
          "message-3",
        );
        expect(settled.olderMessages.settledCount).toBe(1);
      }),
  );

  it.effect("settles an in-flight older page discarded by thread deletion", () =>
    Effect.gen(function* () {
      const messagePageLoadGate = yield* Deferred.make<void>();
      const recent = [makeThreadMessage(3), makeThreadMessage(4)];
      const harness = yield* makeHarness({
        cached: {
          ...BASE_THREAD,
          messages: recent,
          messageWindow: {
            hasMoreOlder: true,
            oldestLoadedMessageId: recent[0]!.id,
            totalCount: 4,
          },
        },
        messagePageLoadGate,
        messagePage: Option.some({
          threadId: THREAD_ID,
          messages: [makeThreadMessage(1), makeThreadMessage(2)],
          hasMoreOlder: false,
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
        }),
      });
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));
      yield* Effect.forkChild(harness.loadOlderMessages);
      yield* awaitThreadState(harness.observed, (value) => value.olderMessages.isLoading);

      yield* Queue.offer(harness.inputs, deleted(CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");
      yield* Deferred.succeed(messagePageLoadGate, undefined);
      const settled = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted" && value.olderMessages.settledCount === 1,
      );

      expect(Option.isNone(settled.data)).toBe(true);
      expect(settled.olderMessages).toEqual({ isLoading: false, error: null, settledCount: 1 });
    }),
  );

  it.effect("increments the settlement signal for consecutive disconnected page attempts", () =>
    Effect.gen(function* () {
      const recent = [makeThreadMessage(3), makeThreadMessage(4)];
      const harness = yield* makeHarness({
        cached: {
          ...BASE_THREAD,
          messages: recent,
          messageWindow: {
            hasMoreOlder: true,
            oldestLoadedMessageId: recent[0]!.id,
            totalCount: 4,
          },
        },
      });
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));
      yield* SubscriptionRef.set(harness.prepared, Option.none());

      yield* harness.loadOlderMessages;
      const first = yield* awaitThreadState(
        harness.observed,
        (value) => value.olderMessages.settledCount === 1,
      );
      expect(first.olderMessages).toEqual({
        isLoading: false,
        error: "The environment is not connected.",
        settledCount: 1,
      });

      yield* harness.loadOlderMessages;
      const second = yield* awaitThreadState(
        harness.observed,
        (value) => value.olderMessages.settledCount === 2,
      );
      expect(second.olderMessages).toEqual({
        isLoading: false,
        error: "The environment is not connected.",
        settledCount: 2,
      });
      expect(yield* Ref.get(harness.messagePageLoaderCalls)).toBe(0);
    }),
  );

  it.effect("clears a disconnected page error on warm resume and pages on the next attempt", () =>
    Effect.gen(function* () {
      const recent = [makeThreadMessage(3), makeThreadMessage(4)];
      const harness = yield* makeHarness({
        cached: {
          ...BASE_THREAD,
          messages: recent,
          messageWindow: {
            hasMoreOlder: true,
            oldestLoadedMessageId: recent[0]!.id,
            totalCount: 4,
          },
        },
        messagePage: Option.some({
          threadId: THREAD_ID,
          messages: [makeThreadMessage(1), makeThreadMessage(2)],
          hasMoreOlder: false,
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
        }),
      });
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));
      yield* SubscriptionRef.set(harness.prepared, Option.none());

      yield* harness.loadOlderMessages;
      const disconnected = yield* awaitThreadState(
        harness.observed,
        (value) => value.olderMessages.settledCount === 1,
      );
      expect(disconnected.olderMessages.error).toBe("The environment is not connected.");
      expect(Option.getOrThrow(disconnected.data).messages[0]?.id).toBe("message-3");

      yield* SubscriptionRef.set(harness.prepared, Option.some(PREPARED));
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      const ready = yield* awaitThreadState(
        harness.observed,
        (value) => value.olderMessages.error === null,
      );
      expect(ready.olderMessages.settledCount).toBe(1);
      expect(Option.getOrThrow(ready.data).messages[0]?.id).toBe("message-3");

      yield* harness.loadOlderMessages;
      const paged = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.olderMessages.settledCount === 2 &&
          Option.isSome(value.data) &&
          value.data.value.messages[0]?.id === "message-1",
      );
      expect(paged.olderMessages).toEqual({ isLoading: false, error: null, settledCount: 2 });
      expect(yield* Ref.get(harness.messagePageLoaderCalls)).toBe(1);
    }),
  );

  it.effect("auto-refills an emptied window after a deep revert", () =>
    Effect.gen(function* () {
      const retainedMessage = {
        ...makeThreadMessage(3),
        turnId: TurnId.make("turn-1"),
      };
      const harness = yield* makeHarness({
        cached: {
          ...BASE_THREAD,
          messages: [retainedMessage],
          messageWindow: {
            hasMoreOlder: true,
            oldestLoadedMessageId: retainedMessage.id,
            totalCount: 3,
          },
        },
        messageWindowLimit: 1,
        messagePage: Option.some({
          threadId: THREAD_ID,
          messages: [makeThreadMessage(1)],
          hasMoreOlder: false,
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 1,
        }),
      });
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      yield* Queue.offer(harness.inputs, reverted(0, CACHED_SNAPSHOT_SEQUENCE + 1));
      const refilled = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.messages[0]?.id === "message-1",
      );

      expect(yield* Ref.get(harness.lastMessagePageBefore)).toBeNull();
      expect(Option.getOrThrow(refilled.data).messageWindow?.hasMoreOlder).toBe(false);
    }),
  );

  it.effect(
    "does not block WS event consumption while a deep-revert auto-refill's HTTP call is in flight",
    () =>
      Effect.gen(function* () {
        // The auto-refill after a deep revert is triggered from inside
        // `acceptItem`, which runs on the WS event consumption loop
        // (`Stream.runForEach(acceptItem)`). If the refill's HTTP call were
        // awaited there instead of forked onto its own fiber, every
        // subsequent WS event would queue behind it until the page loader
        // settled. Gate the loader open and prove a later structural event
        // still applies before the gate is released.
        const retainedMessage = {
          ...makeThreadMessage(3),
          turnId: TurnId.make("turn-1"),
        };
        const messagePageLoadGate = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          cached: {
            ...BASE_THREAD,
            messages: [retainedMessage],
            messageWindow: {
              hasMoreOlder: true,
              oldestLoadedMessageId: retainedMessage.id,
              totalCount: 3,
            },
          },
          messageWindowLimit: 1,
          messagePageLoadGate,
          messagePage: Option.some({
            threadId: THREAD_ID,
            messages: [makeThreadMessage(1)],
            hasMoreOlder: false,
            snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 1,
          }),
        });
        yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

        yield* Queue.offer(harness.inputs, reverted(0, CACHED_SNAPSHOT_SEQUENCE + 1));
        yield* awaitThreadState(
          harness.observed,
          (value) => Option.isSome(value.data) && value.data.value.messages.length === 0,
        );
        // The refill's page loader has been called and is now blocked on the
        // unresolved gate. A structural event queued behind it must still
        // reach the reducer without waiting for the gate to open.
        yield* awaitThreadState(harness.observed, (value) => value.olderMessages.isLoading);
        yield* Queue.offer(
          harness.inputs,
          titleUpdated("Live during refill", CACHED_SNAPSHOT_SEQUENCE + 2),
        );
        const live = yield* awaitThreadState(
          harness.observed,
          (value) => Option.isSome(value.data) && value.data.value.title === "Live during refill",
        );
        expect(Option.getOrThrow(live.data).messages).toEqual([]);
        expect(yield* Ref.get(harness.messagePageLoaderCalls)).toBe(1);

        yield* Deferred.succeed(messagePageLoadGate, undefined);
        const refilled = yield* awaitThreadState(
          harness.observed,
          (value) => Option.isSome(value.data) && value.data.value.messages[0]?.id === "message-1",
        );
        expect(Option.getOrThrow(refilled.data).title).toBe("Live during refill");
      }),
  );

  it.effect(
    "settles without looping when a deep-revert auto-refill returns a non-advancing page",
    () =>
      Effect.gen(function* () {
        // A refill page that adds nothing (an empty page, or one whose
        // messages are already present) must not leave the window stuck
        // reporting more history than it can actually deliver: the stale
        // guard in `prependOlderThreadMessages` forces `hasMoreOlder` false
        // whenever the page didn't advance the message count, so the feed
        // stops retrying the same exhausted cursor instead of looping.
        const retainedMessage = {
          ...makeThreadMessage(3),
          turnId: TurnId.make("turn-1"),
        };
        const harness = yield* makeHarness({
          cached: {
            ...BASE_THREAD,
            messages: [retainedMessage],
            messageWindow: {
              hasMoreOlder: true,
              oldestLoadedMessageId: retainedMessage.id,
              totalCount: 3,
            },
          },
          messageWindowLimit: 1,
          messagePage: Option.some({
            threadId: THREAD_ID,
            messages: [],
            hasMoreOlder: true,
            snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 1,
          }),
        });
        yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

        yield* Queue.offer(harness.inputs, reverted(0, CACHED_SNAPSHOT_SEQUENCE + 1));
        // Wait for the refill to actually start (`isLoading` true) before
        // waiting for it to settle, so the captured state reflects the
        // refill's result rather than the moment right after the revert.
        yield* awaitThreadState(harness.observed, (value) => value.olderMessages.isLoading);
        const settled = yield* awaitThreadState(
          harness.observed,
          (value) => !value.olderMessages.isLoading,
        );

        expect(Option.getOrThrow(settled.data).messages).toEqual([]);
        expect(Option.getOrThrow(settled.data).messageWindow?.hasMoreOlder).toBe(false);
        expect(settled.olderMessages).toEqual({
          isLoading: false,
          error: null,
          settledCount: 1,
        });
        expect(yield* Ref.get(harness.messagePageLoaderCalls)).toBe(1);
      }),
  );

  it.effect("hydrates persisted message artifacts over a same-sequence cache", () =>
    Effect.gen(function* () {
      const cachedThread: OrchestrationThread = {
        ...BASE_THREAD,
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "assistant",
            text: "Response",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        ],
      };
      const httpThread: OrchestrationThread = {
        ...cachedThread,
        completedTurnAssistantMessageIds: [MessageId.make("message-1")],
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "assistant",
            text: "Response",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
            generatedSummary: {
              messageId: MessageId.make("message-1"),
              summary: "Persisted summary",
              createdAt: "2026-04-01T00:01:00.000Z",
            },
          },
        ],
      };
      const harness = yield* makeHarness({
        cached: cachedThread,
        httpSnapshot: Option.some({
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          thread: httpThread,
        }),
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.messages[0]?.generatedSummary?.summary === "Persisted summary",
      );

      expect(Option.getOrThrow(state.data).messages[0]?.generatedSummary?.summary).toBe(
        "Persisted summary",
      );
      expect(Option.getOrThrow(state.data).completedTurnAssistantMessageIds).toEqual(["message-1"]);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);

      // The hydrated artifacts must reach the cache even though the stored
      // snapshot sits at the same sequence: the persist guard only rejects
      // strictly newer stored data.
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(saved?.snapshotSequence).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(saved?.thread.messages[0]?.generatedSummary?.summary).toBe("Persisted summary");
    }),
  );

  it.effect("merges older artifact metadata after a live event wins the refresh race", () =>
    Effect.gen(function* () {
      const message = {
        id: MessageId.make("message-race"),
        role: "assistant" as const,
        text: "Response",
        turnId: null,
        streaming: false,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      };
      const cachedThread: OrchestrationThread = {
        ...BASE_THREAD,
        messages: [message],
        completedTurnAssistantMessageIds: [message.id],
      };
      const snapshotLoadGate = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        cached: cachedThread,
        snapshotLoadGate,
        httpSnapshot: Option.some({
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          thread: {
            ...cachedThread,
            completedTurnAssistantMessageIds: [],
            messages: [
              {
                ...message,
                generatedSummary: {
                  messageId: message.id,
                  summary: "Persisted summary",
                  createdAt: "2026-04-01T00:01:00.000Z",
                },
              },
            ],
          },
        }),
      });

      yield* Queue.offer(harness.inputs, titleUpdated("Live title", CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.title === "Live title",
      );
      yield* Deferred.succeed(snapshotLoadGate, undefined);

      const hydrated = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.title === "Live title" &&
          value.data.value.messages[0]?.generatedSummary?.summary === "Persisted summary",
      );
      expect(Option.getOrThrow(hydrated.data).title).toBe("Live title");
      expect(Option.getOrThrow(hydrated.data).completedTurnAssistantMessageIds).toEqual([
        message.id,
      ]);
    }),
  );

  it.effect("reduces live events and persists the latest thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD, CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", CACHED_SNAPSHOT_SEQUENCE + 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.thread.title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.snapshotSequence).toBe(
        CACHED_SNAPSHOT_SEQUENCE + 2,
      );
    }),
  );

  it.effect("coalesces consecutive streaming deltas into one publication", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: ACTIVE_THREAD });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      yield* Ref.set(harness.publicationCount, 0);

      yield* Queue.offer(harness.inputs, messageDelta("Hello", CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* Queue.offer(harness.inputs, messageDelta(" world", CACHED_SNAPSHOT_SEQUENCE + 2));
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;

      expect(Option.getOrThrow((yield* Ref.get(harness.latest)).data).messages).toEqual([]);
      yield* TestClock.adjust("50 millis");
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.publicationCount)).toBe(1);
      expect(Option.getOrThrow((yield* Ref.get(harness.latest)).data).messages[0]?.text).toBe(
        "Hello world",
      );
    }),
  );

  it.effect("applies message windowing to a coalesced batch", () =>
    Effect.gen(function* () {
      const recent = [makeThreadMessage(1), makeThreadMessage(2)];
      const harness = yield* makeHarness({
        cached: {
          ...ACTIVE_THREAD,
          messages: recent,
          messageWindow: {
            hasMoreOlder: false,
            oldestLoadedMessageId: recent[0]!.id,
            totalCount: 2,
          },
        },
        messageWindowLimit: 2,
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      yield* Ref.set(harness.publicationCount, 0);

      yield* Queue.offer(harness.inputs, messageDelta("Hello", CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* Queue.offer(harness.inputs, messageDelta(" world", CACHED_SNAPSHOT_SEQUENCE + 2));
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      const flushed = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) && value.data.value.messages.at(-1)?.text === "Hello world",
      );
      const thread = Option.getOrThrow(flushed.data);

      expect(thread.messages.map((message) => message.id)).toEqual([
        "message-2",
        "message-streaming",
      ]);
      expect(thread.messageWindow).toEqual({
        hasMoreOlder: true,
        oldestLoadedMessageId: "message-2",
        totalCount: 3,
      });
      expect(yield* Ref.get(harness.publicationCount)).toBe(1);
    }),
  );

  it.effect("applies events immediately when coalescing is disabled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: ACTIVE_THREAD,
        foregroundWindowMs: 0,
        backgroundWindowMs: 0,
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      yield* Ref.set(harness.publicationCount, 0);

      yield* Queue.offer(harness.inputs, messageDelta("First", CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.messages[0]?.text === "First",
      );
      yield* Queue.offer(harness.inputs, messageDelta(" second", CACHED_SNAPSHOT_SEQUENCE + 2));
      const final = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) && value.data.value.messages[0]?.text === "First second",
      );

      expect(Option.getOrThrow(final.data).messages[0]?.text).toBe("First second");
      expect(yield* Ref.get(harness.publicationCount)).toBe(2);
    }),
  );

  it.effect("preserves buffered order when the active window becomes zero", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: ACTIVE_THREAD,
        initialEventPriority: "background",
        foregroundWindowMs: 0,
        backgroundWindowMs: 750,
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      yield* Queue.offer(harness.inputs, messageDelta("Buffered", CACHED_SNAPSHOT_SEQUENCE + 1));
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;

      yield* Ref.set(harness.eventPriority, "foreground");
      yield* Queue.offer(harness.inputs, messageDelta(" immediate", CACHED_SNAPSHOT_SEQUENCE + 2));
      const final = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) && value.data.value.messages[0]?.text === "Buffered immediate",
      );

      expect(Option.getOrThrow(final.data).messages[0]?.text).toBe("Buffered immediate");
    }),
  );

  it.effect("flushes buffered deltas before structural settle events", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: ACTIVE_THREAD });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );

      yield* Queue.offer(harness.inputs, messageDelta("Completed", CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* Queue.offer(harness.inputs, sessionSettled(CACHED_SNAPSHOT_SEQUENCE + 2));
      const settled = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.session?.status === "idle" &&
          value.data.value.messages[0]?.text === "Completed",
      );
      expect(Option.getOrThrow(settled.data).messages[0]?.text).toBe("Completed");

      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(saved?.snapshotSequence).toBe(CACHED_SNAPSHOT_SEQUENCE + 2);
      expect(saved?.thread.messages[0]?.text).toBe("Completed");
    }),
  );

  it.effect("flushes before a replacement session reads the resume cursor", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: ACTIVE_THREAD, completionMarker: true });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      yield* Queue.offer(harness.inputs, messageDelta("Buffered", CACHED_SNAPSHOT_SEQUENCE + 1));
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
      expect(Option.getOrThrow((yield* Ref.get(harness.latest)).data).messages).toEqual([]);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect(Option.getOrThrow((yield* Ref.get(harness.latest)).data).messages[0]?.text).toBe(
        "Buffered",
      );
    }),
  );

  it.effect("uses the longer background coalescing window", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: ACTIVE_THREAD,
        initialEventPriority: "background",
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      yield* Queue.offer(harness.inputs, messageDelta("Background", CACHED_SNAPSHOT_SEQUENCE + 1));
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;

      yield* TestClock.adjust("50 millis");
      expect(Option.getOrThrow((yield* Ref.get(harness.latest)).data).messages).toEqual([]);
      yield* TestClock.adjust("700 millis");
      const flushed = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.messages.length === 1,
      );
      expect(Option.getOrThrow(flushed.data).messages[0]?.text).toBe("Background");
    }),
  );

  it.effect("flushes promptly when a background thread becomes foreground", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: ACTIVE_THREAD,
        initialEventPriority: "background",
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      yield* Queue.offer(harness.inputs, messageDelta("Focused", CACHED_SNAPSHOT_SEQUENCE + 1));
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;

      yield* harness.setEventPriority("foreground");
      const flushed = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.messages.length === 1,
      );
      expect(Option.getOrThrow(flushed.data).messages[0]?.text).toBe("Focused");
    }),
  );

  it.effect("does not commit a manual older page after thread teardown", () =>
    Effect.gen(function* () {
      const messagePageLoadGate = yield* Deferred.make<void>();
      const teardownScope = yield* Scope.make();
      const recent = [makeThreadMessage(3), makeThreadMessage(4)];
      const harness = yield* makeHarness({
        cached: {
          ...BASE_THREAD,
          messages: recent,
          messageWindow: {
            hasMoreOlder: true,
            oldestLoadedMessageId: recent[0]!.id,
            totalCount: 4,
          },
        },
        messagePageLoadGate,
        messagePage: Option.some({
          threadId: THREAD_ID,
          messages: [makeThreadMessage(1), makeThreadMessage(2)],
          hasMoreOlder: false,
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
        }),
      }).pipe(Scope.provide(teardownScope));
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      const pageFiber = yield* Effect.forkChild(harness.loadOlderMessages);
      yield* awaitThreadState(harness.observed, (value) => value.olderMessages.isLoading);
      yield* Scope.close(teardownScope, Exit.void);
      const stateAfterTeardown = yield* SubscriptionRef.get(harness.state);
      const savedAfterTeardown = yield* Ref.get(harness.savedThreads);

      yield* Deferred.succeed(messagePageLoadGate, undefined);
      yield* Fiber.await(pageFiber);
      yield* harness.loadOlderMessages;
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;

      expect(yield* SubscriptionRef.get(harness.state)).toEqual(stateAfterTeardown);
      expect(yield* Ref.get(harness.savedThreads)).toEqual(savedAfterTeardown);
      expect(yield* Ref.get(harness.messagePageLoaderCalls)).toBe(1);
      expect(
        Option.getOrThrow(stateAfterTeardown.data).messages.map((message) => message.id),
      ).toEqual(["message-3", "message-4"]);
    }),
  );

  it.effect("flushes pending events before teardown persistence", () =>
    Effect.gen(function* () {
      const savedThreads = yield* Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ cached: BASE_THREAD });
          yield* awaitThreadState(
            harness.observed,
            (value) => value.status === "live" && Option.isSome(value.data),
          );
          yield* Queue.offer(
            harness.inputs,
            messageDelta("Persist on close", CACHED_SNAPSHOT_SEQUENCE + 1),
          );
          for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
          return harness.savedThreads;
        }),
      );

      const saved = (yield* Ref.get(savedThreads)).at(-1);
      expect(saved?.snapshotSequence).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect(saved?.thread.messages[0]?.text).toBe("Persist on close");
    }),
  );

  it.effect("does not let teardown overwrite a newer cached snapshot", () =>
    Effect.gen(function* () {
      const refs = yield* Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ cached: BASE_THREAD });
          yield* awaitThreadState(
            harness.observed,
            (value) => value.status === "live" && Option.isSome(value.data),
          );
          yield* Ref.set(
            harness.cachedThreadSnapshot,
            Option.some({
              snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 3,
              thread: { ...BASE_THREAD, title: "Prewarmed title" },
            }),
          );
          return {
            cachedThreadSnapshot: harness.cachedThreadSnapshot,
            savedThreads: harness.savedThreads,
          };
        }),
      );

      const cached = Option.getOrThrow(yield* Ref.get(refs.cachedThreadSnapshot));
      expect(cached.snapshotSequence).toBe(CACHED_SNAPSHOT_SEQUENCE + 3);
      expect(cached.thread.title).toBe("Prewarmed title");
      expect(yield* Ref.get(refs.savedThreads)).toEqual([]);
    }),
  );

  it.effect("does not persist active thread snapshots during streaming or teardown", () =>
    Effect.gen(function* () {
      const savedThreads = yield* Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ cached: ACTIVE_THREAD });
          yield* awaitThreadState(
            harness.observed,
            (value) =>
              value.status === "live" &&
              Option.isSome(value.data) &&
              value.data.value.session?.status === "running",
          );

          yield* TestClock.adjust("500 millis");
          yield* Effect.yieldNow;

          expect(yield* Ref.get(harness.savedThreads)).toEqual([]);
          return harness.savedThreads;
        }),
      );

      expect(yield* Ref.get(savedThreads)).toEqual([]);
    }),
  );

  it.effect("applies the last running -> idle event before teardown decides what to persist", () =>
    Effect.gen(function* () {
      // Own the handle's scope explicitly instead of wrapping the harness
      // in `Effect.scoped`, so teardown can be triggered at a precise
      // moment relative to the final settle event.
      const teardownScope = yield* Scope.make();
      const harness = yield* makeHarness({ cached: ACTIVE_THREAD }).pipe(
        Scope.provide(teardownScope),
      );
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.session?.status === "running",
      );

      yield* Queue.offer(harness.inputs, sessionSettled(CACHED_SNAPSHOT_SEQUENCE + 1));
      // Give the producer fiber scheduling turns to dequeue and apply the
      // event. The 500ms debounced persistence writer never gets a
      // chance to fire on its own here (the TestClock is never
      // advanced), so the only path that can cache this event is the
      // teardown finalizer's own flush-then-persist.
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
      yield* Scope.close(teardownScope, Exit.void);

      const cached = Option.getOrThrow(yield* Ref.get(harness.cachedThreadSnapshot));
      const saved = yield* Ref.get(harness.savedThreads);
      const lastSaved = saved.at(-1);

      expect(cached.thread.session?.status).toBe("idle");
      expect(lastSaved?.thread.session?.status).toBe("idle");
      expect(lastSaved?.thread).toEqual(cached.thread);
      expect(saved.some((entry) => entry.thread.session?.status === "running")).toBe(false);
    }),
  );

  it.effect(
    "does not let a stale debounced write land after teardown's own persist and clobber the final state",
    () =>
      Effect.gen(function* () {
        // Reproduces the finalizer teardown race deterministically via the
        // virtual `TestClock`: a debounced persistence write for an *older*
        // published state is already in flight (past its cache read, mid
        // "commit") when a newer event supersedes it and teardown begins.
        // The stale write's cache commit is given a long virtual delay so it
        // is still outstanding when teardown's own explicit persist runs.
        // Before this fix, the finalizer ran its persist immediately without
        // first stopping the debounced writer, so once the virtual clock
        // advanced far enough for the stale write's delay to elapse, it
        // would land *after* the finalizer's own write and clobber the
        // correct final snapshot with stale data.
        const teardownScope = yield* Scope.make();
        const harness = yield* makeHarness({
          cached: BASE_THREAD,
          saveThreadDelay: { title: "Interim title", millis: 10_000 },
        }).pipe(Scope.provide(teardownScope));

        yield* awaitThreadState(
          harness.observed,
          (value) => value.status === "live" && Option.isSome(value.data),
        );

        // This update's debounced write starts, reads the cache, and then
        // sleeps (on the virtual clock) for a long time right before it
        // would commit.
        yield* Queue.offer(
          harness.inputs,
          titleUpdated("Interim title", CACHED_SNAPSHOT_SEQUENCE + 1),
        );
        yield* awaitThreadState(
          harness.observed,
          (value) => Option.isSome(value.data) && value.data.value.title === "Interim title",
        );
        yield* TestClock.adjust("500 millis");
        for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;

        // A final update supersedes it in published state before teardown
        // begins.
        yield* Queue.offer(
          harness.inputs,
          titleUpdated("Final title", CACHED_SNAPSHOT_SEQUENCE + 2),
        );
        yield* awaitThreadState(
          harness.observed,
          (value) => Option.isSome(value.data) && value.data.value.title === "Final title",
        );

        // Start teardown and let its own (undelayed) persist run. A correct
        // implementation has already interrupted the debounced writer here,
        // cancelling its pending sleep, so it can never commit. A buggy
        // implementation instead lets that write keep sleeping in the
        // background while teardown's own persist completes first.
        const closing = yield* Effect.forkChild(Scope.close(teardownScope, Exit.void));
        for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;

        // Advance the virtual clock past the stale write's delay. On correct
        // code this fires no alarm (the writer was already interrupted). On
        // buggy code this fires the still-pending stale write, which commits
        // "Interim title" over the already-persisted "Final title".
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(closing);

        const cached = Option.getOrThrow(yield* Ref.get(harness.cachedThreadSnapshot));
        const saved = yield* Ref.get(harness.savedThreads);
        expect(cached.thread.title).toBe("Final title");
        expect(saved.at(-1)?.thread.title).toBe("Final title");
      }),
  );

  it.effect("seeds the thread from the HTTP snapshot and resumes live events", () =>
    Effect.gen(function* () {
      const httpThread: OrchestrationThread = { ...BASE_THREAD, title: "HTTP title" };
      const harness = yield* makeHarness({
        httpSnapshot: Option.some({ snapshotSequence: 1, thread: httpThread }),
      });
      // No socket snapshot is pushed; only a live event arrives over the socket.
      // It can only be applied if the HTTP snapshot already seeded the thread.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
      // Cold cache: the full snapshot was loaded over HTTP and the socket
      // resumed from that snapshot's sequence.
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(1);
    }),
  );

  it.effect("ignores replayed thread events at or below the snapshot sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, titleUpdated("Replayed title", 1));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
    }),
  );

  it.effect("removes cached data when the thread is deleted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, deleted());

      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
    }),
  );

  it.effect("does not resurrect a deleted thread when the app returns to the foreground", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_THREAD,
        completionMarker: true,
        httpSnapshot: Option.some({
          snapshotSequence: 4,
          thread: { ...BASE_THREAD, title: "Stale HTTP thread" },
        }),
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, deleted());
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");

      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      yield* Queue.offer(harness.wakeups, "application-active");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          (yield* Ref.get(harness.subscriptionCount)) >= 2 &&
          (yield* Ref.get(harness.loaderCalls)) >= 2
        )
          break;
        yield* Effect.yieldNow;
      }

      const latest = yield* Ref.get(harness.latest);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      // A deleted thread skips later snapshot refreshes, so the initial load is
      // the only HTTP request.
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect(latest.status).toBe("deleted");
      expect(Option.isNone(latest.data)).toBe(true);
    }),
  );

  it.effect("preserves data after a domain failure and resumes on a replacement session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, new Error("stream failed"));

      const state = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
      expect(Option.getOrThrow(state.error)).toBe("stream failed");
      expect(yield* Ref.get(harness.retryCount)).toBe(0);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          title: "Recovered thread",
        }),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Recovered thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
    }),
  );

  it.effect("recovers from a transient domain failure without replacing the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, new Error("thread not found yet"));

      const failed = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );
      expect(Option.getOrThrow(failed.error)).toBe("thread not found yet");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* TestClock.adjust("250 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          title: "Materialized thread",
        }),
      );

      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Materialized thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
    }),
  );

  it.effect("does not overwrite a live snapshot when the supervisor becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("live");
    }),
  );

  it.effect("keeps replayed updates synchronizing until the completion marker arrives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD, completionMarker: true });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);

      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Caught-up title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      const catchingUp = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "synchronizing" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Caught-up title",
      );
      expect(catchingUp.status).toBe("synchronizing");

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).title).toBe("Caught-up title");
    }),
  );

  it.effect("resumes replacement sessions from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD, completionMarker: true });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Latest title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Latest title",
      );

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
    }),
  );

  it.effect("resubscribes on app foreground from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD, completionMarker: true });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Latest title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Latest title",
      );

      yield* Queue.offer(harness.wakeups, "application-active");
      const synchronizing = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          (yield* Ref.get(harness.subscriptionCount)) >= 2 &&
          (yield* Ref.get(harness.loaderCalls)) >= 2
        )
          break;
        yield* Effect.yieldNow;
      }

      expect(synchronizing.status).toBe("synchronizing");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(2);

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).title).toBe("Latest title");

      yield* Queue.offer(harness.wakeups, "application-active-probe");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 3) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(3);

      yield* Queue.offer(harness.wakeups, "application-active-reconnect");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(3);
    }),
  );
});
