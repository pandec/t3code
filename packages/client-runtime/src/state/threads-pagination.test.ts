import {
  EnvironmentId,
  EventId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import type { ThreadSnapshotLoadWindow } from "./threadSnapshotHttp.ts";
import {
  commitPrewarmedThreadSnapshot,
  INITIAL_THREAD_USER_TURN_LIMIT,
  makeEnvironmentThreadState,
  OLDER_THREAD_PAGE_USER_TURN_LIMIT,
  requestOlderThreadTurns,
  ThreadHistoryWindow,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
} from "./threads.ts";

// Turn pagination is opt-in per client: web/desktop leave `initialTurnLimit`
// unset and keep full history, so these tests configure it explicitly.
const PAGINATED_HISTORY_WINDOW = ThreadHistoryWindow.of({
  messageWindowLimit: null,
  messageOlderPageSize: 200,
  initialTurnLimit: INITIAL_THREAD_USER_TURN_LIMIT,
  olderTurnLimit: OLDER_THREAD_PAGE_USER_TURN_LIMIT,
  residentMessageCeiling: null,
});

function turnWindow(
  window: ThreadSnapshotLoadWindow | undefined,
): { readonly turnLimit: number; readonly beforeCursor?: string } | undefined {
  return window === undefined || "messageLimit" in window ? undefined : window;
}

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = ThreadId.make("thread-1");
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

function message(id: string, turnId: string, createdAt: string): OrchestrationMessage {
  return {
    id: id as OrchestrationMessage["id"],
    role: "assistant",
    text: `text of ${id}`,
    turnId: TurnId.make(turnId),
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

const OLDER_MESSAGE = message("message-old", "turn-1", "2026-04-01T00:00:00.000Z");
const RECENT_MESSAGE = message("message-recent", "turn-2", "2026-04-01T01:00:00.000Z");

// Reverts retain turns via checkpoints with checkpointTurnCount <= the revert's
// turnCount, so both fixture turns carry one: reverting to turnCount 1 keeps
// turn-1 (the older page's turn) and discards turn-2 (the loaded window's).
function checkpoint(turnId: string, turnCount: number): OrchestrationThread["checkpoints"][number] {
  return {
    turnId: TurnId.make(turnId),
    checkpointTurnCount: turnCount,
    checkpointRef:
      `checkpoint-${turnCount}` as OrchestrationThread["checkpoints"][number]["checkpointRef"],
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: "2026-04-01T01:00:00.000Z",
  };
}

const BASE_THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Windowed thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [RECENT_MESSAGE],
  completedTurnAssistantMessageIds: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [checkpoint("turn-2", 2)],
  session: null,
};

const WINDOWED_SNAPSHOT: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 10,
  thread: BASE_THREAD,
  page: { beforeCursor: "cursor-1", hasMore: true, snapshotSequence: 10 },
};

const OLDER_PAGE: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 10,
  thread: {
    ...BASE_THREAD,
    messages: [OLDER_MESSAGE],
    checkpoints: [checkpoint("turn-1", 1)],
  },
  page: { beforeCursor: null, hasMore: false, snapshotSequence: 10 },
};

type LoaderResponse = Option.Option<OrchestrationThreadDetailSnapshot>;

const makeHarness = Effect.fn("TestThreadPagination.makeHarness")(function* (options?: {
  readonly paginationCapability?: boolean;
  readonly initialResponse?: LoaderResponse;
  /** Unwindowed responses served in order (falls back to `initialResponse`). */
  readonly initialResponses?: ReadonlyArray<LoaderResponse>;
  /** Cached snapshot returned by the default cache store (simulates a warm cache). */
  readonly cached?: OrchestrationThreadDetailSnapshot;
  /** Existing cache service for persistence-to-cold-start integration tests. */
  readonly cache?: Persistence.EnvironmentCacheStore["Service"];
  /** Soft ceiling on resident messages for automatic refills. */
  readonly residentMessageCeiling?: number | null;
  /**
   * Hold unwindowed (initial / warm-refresh) loads on a deferred so a test can
   * interleave them with an older-page fetch.
   */
  readonly deferInitial?: boolean;
}) {
  const inputs = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const loaderWindows = yield* Ref.make<ReadonlyArray<ThreadSnapshotLoadWindow | undefined>>([]);
  const lastSubscribeInput = yield* Ref.make<Record<string, unknown> | undefined>(undefined);
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationThreadDetailSnapshot>>([]);
  // Older-page responses resolve through deferreds so tests can interleave
  // live events with an in-flight page fetch.
  const pendingPageResponses = yield* Queue.unbounded<Deferred.Deferred<LoaderResponse>>();
  const pendingInitialResponses = yield* Queue.unbounded<Deferred.Deferred<LoaderResponse>>();
  const scriptedInitialResponses = yield* Ref.make<ReadonlyArray<LoaderResponse>>(
    options?.initialResponses ?? [],
  );
  const nextScriptedInitial = Ref.modify(scriptedInitialResponses, (queue) =>
    queue.length === 0
      ? ([
          options?.initialResponse ?? Option.none<OrchestrationThreadDetailSnapshot>(),
          queue,
        ] as const)
      : ([queue[0]!, queue.slice(1)] as const),
  );
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: Record<string, unknown>) =>
      Stream.unwrap(Ref.set(lastSubscribeInput, input).pipe(Effect.as(Stream.fromQueue(inputs)))),
  } as unknown as WsRpcProtocolClient;
  const makeSession = (paginationCapability: boolean): RpcSession.RpcSession => ({
    client,
    initialConfig: Effect.succeed({ threadSnapshotPagination: paginationCapability } as never),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  });
  const session = makeSession(options?.paginationCapability !== false);
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(session),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const snapshotLoader = ThreadSnapshotLoader.of({
    load: (_prepared, _threadId, window) =>
      Ref.update(loaderWindows, (current) => [...current, window]).pipe(
        Effect.andThen(
          turnWindow(window)?.beforeCursor === undefined
            ? options?.deferInitial === true
              ? Deferred.make<LoaderResponse>().pipe(
                  Effect.tap((deferred) => Queue.offer(pendingInitialResponses, deferred)),
                  Effect.flatMap(Deferred.await),
                )
              : nextScriptedInitial
            : Deferred.make<LoaderResponse>().pipe(
                Effect.tap((deferred) => Queue.offer(pendingPageResponses, deferred)),
                Effect.flatMap(Deferred.await),
              ),
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
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache =
    options?.cache ??
    Persistence.EnvironmentCacheStore.of({
      loadShell: () => Effect.succeed(Option.none()),
      saveShell: () => Effect.void,
      loadThread: () =>
        Effect.succeed(options?.cached !== undefined ? Option.some(options.cached) : Option.none()),
      saveThread: (_environmentId, thread) =>
        Ref.update(savedThreads, (current) => [...current, thread]),
      removeThread: () => Effect.void,
      loadServerConfig: () => Effect.succeed(Option.none()),
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => Effect.succeed(Option.none()),
      saveVcsRefs: () => Effect.void,
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: () => Effect.void,
    });
  const threadState = yield* makeEnvironmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader, snapshotLoader),
    Effect.provideService(
      ThreadHistoryWindow,
      options?.residentMessageCeiling === undefined
        ? PAGINATED_HISTORY_WINDOW
        : ThreadHistoryWindow.of({
            ...PAGINATED_HISTORY_WINDOW,
            residentMessageCeiling: options.residentMessageCeiling,
          }),
    ),
  );
  yield* SubscriptionRef.changes(threadState.state).pipe(
    Stream.runForEach((state) => Queue.offer(observed, state)),
    Effect.forkScoped,
  );

  const awaitState = (predicate: (state: EnvironmentThreadState) => boolean) =>
    Queue.take(observed).pipe(Effect.repeat({ until: predicate }));
  const resolveNextPage = (response: LoaderResponse) =>
    Queue.take(pendingPageResponses).pipe(
      Effect.flatMap((deferred) => Deferred.succeed(deferred, response)),
    );
  const resolveNextInitial = (response: LoaderResponse) =>
    Queue.take(pendingInitialResponses).pipe(
      Effect.flatMap((deferred) => Deferred.succeed(deferred, response)),
    );
  /** Swaps in a session with a different capability, forcing a resubscribe. */
  const reconnectWithPagination = (paginationCapability: boolean) =>
    SubscriptionRef.set(supervisorSession, Option.some(makeSession(paginationCapability)));

  return {
    inputs,
    observed,
    awaitState,
    resolveNextPage,
    resolveNextInitial,
    reconnectWithPagination,
    loaderWindows,
    lastSubscribeInput,
    savedThreads,
    threadState,
  };
});

const hasMessage = (state: EnvironmentThreadState, id: string): boolean =>
  Option.match(state.data, {
    onNone: () => false,
    onSome: (thread) => thread.messages.some((entry) => entry.id === id),
  });

const titleEvent = (title: string, sequence: number): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-title-${sequence}`),
    sequence,
    occurredAt: "2026-04-01T01:30:00.000Z",
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
      updatedAt: "2026-04-01T01:30:00.000Z",
    },
  },
});

// Reverting to turnCount 1 retains only turns whose checkpoint count is <= 1:
// turn-1 survives, turn-2 (the loaded window's newest turn) is discarded.
const revertEvent = (sequence: number): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-revert-${sequence}`),
    sequence,
    occurredAt: "2026-04-01T02:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.reverted",
    payload: {
      threadId: THREAD_ID,
      turnCount: 1,
    },
  },
});

describe("thread pagination state", () => {
  it.effect("windows the initial load when the server advertises pagination", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      const state = yield* harness.awaitState((value) => Option.isSome(value.page));
      expect(Option.getOrThrow(state.page)).toEqual({
        beforeCursor: "cursor-1",
        hasMore: true,
        loadingOlder: false,
      });
      const windows = yield* Ref.get(harness.loaderWindows);
      expect(turnWindow(windows[0])?.turnLimit).toBe(INITIAL_THREAD_USER_TURN_LIMIT);
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput);
      expect(subscribeInput?.turnLimit).toBe(INITIAL_THREAD_USER_TURN_LIMIT);
    }),
  );

  it.effect("keeps a turn page usable after a legacy prewarm attempt and cold start", () =>
    Effect.gen(function* () {
      const stored = yield* Ref.make<OrchestrationThreadDetailSnapshot>(WINDOWED_SNAPSHOT);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Ref.get(stored).pipe(Effect.map(Option.some)),
        saveThread: (_environmentId, snapshot) => Ref.set(stored, snapshot),
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const legacyAttempt: OrchestrationThreadDetailSnapshot = {
        snapshotSequence: 20,
        thread: {
          ...BASE_THREAD,
          messageWindow: {
            hasMoreOlder: true,
            oldestLoadedMessageId: RECENT_MESSAGE.id,
            totalCount: 20,
          },
        },
      };

      expect(
        yield* commitPrewarmedThreadSnapshot(cache, TARGET.environmentId, legacyAttempt, 150),
      ).toBe(false);
      const cached = yield* Ref.get(stored);
      expect(cached.page).toEqual(WINDOWED_SNAPSHOT.page);
      expect(cached.thread.messageWindow).toBeUndefined();

      const harness = yield* makeHarness({
        cache,
        paginationCapability: true,
      });
      const state = yield* harness.awaitState((value) => Option.isSome(value.page));
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");
      yield* Effect.yieldNow;
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput);
      expect(subscribeInput?.afterSequence).toBe(10);
      expect(subscribeInput?.turnLimit).toBe(INITIAL_THREAD_USER_TURN_LIMIT);
      expect(subscribeInput?.messageLimit).toBeUndefined();
    }),
  );

  it.effect("does not send a window to servers without the capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        paginationCapability: false,
        initialResponse: Option.some({ snapshotSequence: 10, thread: BASE_THREAD }),
      });
      const state = yield* harness.awaitState((value) => Option.isSome(value.data));
      expect(Option.isNone(state.page)).toBe(true);
      const windows = yield* Ref.get(harness.loaderWindows);
      expect(windows[0]).toBeUndefined();
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput);
      expect(subscribeInput?.turnLimit).toBeUndefined();
    }),
  );

  it.effect("merges an older page below the loaded window and clears the cursor", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      expect(requestOlderThreadTurns(TARGET.environmentId, THREAD_ID)).toBe(true);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      yield* harness.resolveNextPage(Option.some(OLDER_PAGE));

      const state = yield* harness.awaitState((value) => hasMessage(value, "message-old"));
      const thread = Option.getOrThrow(state.data);
      // Older rows land before the loaded window's rows.
      expect(thread.messages.map((entry) => entry.id)).toEqual(["message-old", "message-recent"]);
      expect(Option.getOrThrow(state.page)).toEqual({
        beforeCursor: null,
        hasMore: false,
        loadingOlder: false,
      });
    }),
  );

  it.effect("discards an in-flight older page when a revert rewrites history", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      // Revert lands while the page fetch is in flight and removes turn-2.
      yield* Queue.offer(harness.inputs, revertEvent(11));
      yield* harness.awaitState((value) => !hasMessage(value, "message-recent"));
      yield* harness.resolveNextPage(Option.some(OLDER_PAGE));

      const state = yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => !page.loadingOlder }),
      );
      // The stale page was dropped: no resurrected rows, cursor unchanged.
      expect(hasMessage(state, "message-old")).toBe(false);
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");
    }),
  );

  it.effect("discards an in-flight older page when a fresh snapshot replaces the thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 20,
          thread: { ...BASE_THREAD, title: "Replaced thread" },
          page: { beforeCursor: "cursor-2", hasMore: true, snapshotSequence: 20 },
        },
      });
      yield* harness.awaitState((value) =>
        Option.match(value.data, {
          onNone: () => false,
          onSome: (thread) => thread.title === "Replaced thread",
        }),
      );
      yield* harness.resolveNextPage(Option.some(OLDER_PAGE));

      const state = yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => !page.loadingOlder }),
      );
      expect(hasMessage(state, "message-old")).toBe(false);
      // The replacement snapshot's cursor wins over the discarded page's.
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-2");
    }),
  );

  it.effect("discards an older page read from a projection behind the loaded state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      yield* harness.resolveNextPage(Option.some({ ...OLDER_PAGE, snapshotSequence: 5 }));

      const state = yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => !page.loadingOlder }),
      );
      expect(hasMessage(state, "message-old")).toBe(false);
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");
    }),
  );

  it.effect("a merged history page never advances the live-event dedupe sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      // The page was captured at a newer projection sequence (12) than the
      // loaded state (10); merging it must not swallow events 11-12.
      yield* harness.resolveNextPage(
        Option.some({
          ...OLDER_PAGE,
          snapshotSequence: 12,
          page: { beforeCursor: null, hasMore: false, snapshotSequence: 12 },
        }),
      );
      yield* harness.awaitState((value) => hasMessage(value, "message-old"));

      // Event at sequence 11 must still apply after the merge: the revert
      // discards turn-2, so the loaded window's row disappears while the
      // merged older turn-1 row survives. If the merge had advanced the
      // dedupe sequence to the page's 12, this event would be swallowed.
      yield* Queue.offer(harness.inputs, revertEvent(11));
      const state = yield* harness.awaitState(
        (value) => !hasMessage(value, "message-recent") && hasMessage(value, "message-old"),
      );
      expect(hasMessage(state, "message-old")).toBe(true);
    }),
  );

  it.effect("parks a page read ahead of the live state until events catch up", () =>
    Effect.gen(function* () {
      // A page whose thread watermark is ahead of the loaded state may
      // contain streaming content the subscription has not delivered yet
      // (e.g. an out-of-window subagent turn mid-stream); merging it
      // immediately and then replaying those deltas would duplicate text.
      // The page parks until the live state reaches the watermark.
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      // Page watermark 11 > loaded sequence 10: must park, not merge.
      yield* harness.resolveNextPage(
        Option.some({
          ...OLDER_PAGE,
          snapshotSequence: 11,
          page: { beforeCursor: null, hasMore: false, snapshotSequence: 11, threadSequence: 11 },
        }),
      );

      // A live event at sequence 11 arrives; only then does the page merge.
      yield* Queue.offer(harness.inputs, titleEvent("Advanced past watermark", 11));
      const state = yield* harness.awaitState((value) => hasMessage(value, "message-old"));
      expect(hasMessage(state, "message-recent")).toBe(true);
      expect(Option.getOrThrow(state.page).loadingOlder).toBe(false);
    }),
  );

  it.effect("a revert keeps the page cursor and triggers no refresh fetch", () =>
    Effect.gen(function* () {
      // Cursors are an (anchor, turnId) keyset derived from event content, so
      // they survive the revert projector's row rewrite: the machine keeps
      // the stored cursor and performs no snapshot re-fetch. The revert
      // reducer's turn filtering alone handles loaded history.
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      yield* Queue.offer(harness.inputs, revertEvent(11));
      const state = yield* harness.awaitState((value) => !hasMessage(value, "message-recent"));

      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");
      const windows = yield* Ref.get(harness.loaderWindows);
      // Only the initial load hit the loader — no post-revert refresh fetch.
      expect(windows.length).toBe(1);
    }),
  );

  it.effect("drops a windowed cache when the server lacks the pagination capability", () =>
    Effect.gen(function* () {
      // Resuming a windowed cache via afterSequence against a pre-pagination
      // server would render only the window forever with no way to load the
      // rest: the machine must discard the cache and take a full snapshot.
      const fullSnapshot: OrchestrationThreadDetailSnapshot = {
        snapshotSequence: 20,
        thread: { ...BASE_THREAD, title: "Full reload" },
      };
      const harness = yield* makeHarness({
        paginationCapability: false,
        cached: WINDOWED_SNAPSHOT,
        initialResponse: Option.some(fullSnapshot),
      });

      const state = yield* harness.awaitState((value) =>
        Option.match(value.data, {
          onNone: () => false,
          onSome: (thread) => thread.title === "Full reload",
        }),
      );
      expect(Option.isNone(state.page)).toBe(true);
      // The subscription resumed from the fresh full snapshot, not the
      // discarded windowed cache's watermark, and sent no window fields.
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput);
      expect(subscribeInput?.turnLimit).toBeUndefined();
      expect(subscribeInput?.afterSequence).toBe(20);
    }),
  );

  it.effect("an automatic refill respects the resident-message ceiling", () =>
    Effect.gen(function* () {
      // The ceiling is a LOCAL memory guard, not a history signal: it holds
      // back app-initiated refills but must never change `page.hasMore` and
      // must never block explicit user-driven scrollback.
      const harness = yield* makeHarness({
        initialResponse: Option.some(WINDOWED_SNAPSHOT),
        residentMessageCeiling: 1,
      });
      const loaded = yield* harness.awaitState((value) => Option.isSome(value.page));
      // One resident message, ceiling of 1: automatic refills are capped.
      expect(Option.getOrThrow(loaded.data).messages.length).toBe(1);

      yield* harness.threadState.loadOlderMessages({ automatic: true });
      const afterAutomatic = yield* Ref.get(harness.loaderWindows);
      // Only the initial load ran: the automatic refill never hit the loader.
      expect(afterAutomatic.length).toBe(1);
      const settled = yield* harness.awaitState((value) => !value.olderMessages.isLoading);
      // The cap is soft: it never rewrites the server's hasMore.
      expect(Option.getOrThrow(settled.page).hasMore).toBe(true);

      // Explicit scrollback is user intent and ignores the ceiling.
      yield* Effect.forkChild(harness.threadState.loadOlderMessages());
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      yield* harness.resolveNextPage(Option.some(OLDER_PAGE));
      const merged = yield* harness.awaitState((value) => hasMessage(value, "message-old"));
      expect(hasMessage(merged, "message-old")).toBe(true);
    }),
  );

  it.effect("a warm refresh that supersedes a parked page releases the loading latch", () =>
    Effect.gen(function* () {
      // A parked page is normally resolved by the next stream item. On an idle
      // thread none arrives, so a warm-refresh install that invalidates the
      // park has to release the latch itself — otherwise the spinner stays up
      // and every later request is rejected as a duplicate.
      const harness = yield* makeHarness({ cached: WINDOWED_SNAPSHOT, deferInitial: true });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      expect(requestOlderThreadTurns(TARGET.environmentId, THREAD_ID)).toBe(true);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      // Watermark 99 is far ahead of the loaded sequence 10, so the page parks.
      yield* harness.resolveNextPage(
        Option.some({
          ...OLDER_PAGE,
          snapshotSequence: 99,
          page: { beforeCursor: null, hasMore: false, snapshotSequence: 99, threadSequence: 99 },
        }),
      );

      // The warm refresh lands newer and supersedes the parked page. It keeps
      // message-recent, so it does not narrow the window and is installed.
      yield* harness.resolveNextInitial(
        Option.some({
          snapshotSequence: 30,
          thread: { ...BASE_THREAD, title: "Refreshed" },
          page: { beforeCursor: "cursor-3", hasMore: true, snapshotSequence: 30 },
        }),
      );

      const state = yield* harness.awaitState(
        (value) =>
          Option.match(value.data, {
            onNone: () => false,
            onSome: (thread) => thread.title === "Refreshed",
          }) && !value.olderMessages.isLoading,
      );
      expect(state.olderMessages.isLoading).toBe(false);
      expect(Option.getOrThrow(state.page).loadingOlder).toBe(false);
      // The parked page was discarded rather than merged into fresher history.
      expect(hasMessage(state, "message-old")).toBe(false);
    }),
  );

  it.effect("a capability downgrade releases the loading latch", () =>
    Effect.gen(function* () {
      // Reconnecting to a pre-pagination server tears down windowed mode. A
      // latch carried into legacy mode would block scrollback forever.
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      yield* harness.resolveNextPage(
        Option.some({
          ...OLDER_PAGE,
          snapshotSequence: 99,
          page: { beforeCursor: null, hasMore: false, snapshotSequence: 99, threadSequence: 99 },
        }),
      );

      yield* harness.reconnectWithPagination(false);

      const state = yield* harness.awaitState(
        (value) => Option.isNone(value.page) && !value.olderMessages.isLoading,
      );
      expect(state.olderMessages.isLoading).toBe(false);
    }),
  );

  it.effect("a narrowing refresh caused only by other threads keeps history and advances", () =>
    Effect.gen(function* () {
      // `snapshotSequence` is global, so it advances on unrelated threads'
      // events. The page's `threadSequence` is the thread-scoped watermark:
      // when it is at or behind the sequence we hold, nothing happened to THIS
      // thread, so the narrower refreshed window contains nothing our history
      // lacks. Keep the wider history AND adopt the newer sequence — leaving
      // the sequence behind would strand an idle thread until the replay gap
      // forces a fallback snapshot that drops the history anyway.
      const mergedCache: OrchestrationThreadDetailSnapshot = {
        snapshotSequence: 10,
        thread: { ...BASE_THREAD, messages: [OLDER_MESSAGE, RECENT_MESSAGE] },
        page: { beforeCursor: "cursor-deep", hasMore: true, snapshotSequence: 10 },
      };
      const harness = yield* makeHarness({ cached: mergedCache, deferInitial: true });
      yield* harness.awaitState((value) => hasMessage(value, "message-old"));

      // Newer globally (30), but this thread is untouched since sequence 10.
      yield* harness.resolveNextInitial(
        Option.some({
          snapshotSequence: 30,
          thread: { ...BASE_THREAD, title: "Narrow refresh" },
          page: {
            beforeCursor: "cursor-1",
            hasMore: true,
            snapshotSequence: 30,
            threadSequence: 10,
          },
        }),
      );

      yield* Effect.repeat(Effect.yieldNow, { times: 200 });
      const state = yield* SubscriptionRef.get(harness.threadState.state);
      expect(hasMessage(state, "message-old")).toBe(true);
      expect(hasMessage(state, "message-recent")).toBe(true);
      // The deeper cursor is retained, so paging continues below the cache.
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-deep");

      // ...and the resume cursor advanced, so a reconnect resumes at 30 rather
      // than falling ever further behind the server's head.
      yield* harness.reconnectWithPagination(true);
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput).pipe(
        Effect.repeat({ until: (input) => input?.afterSequence === 30 }),
      );
      expect(subscribeInput?.afterSequence).toBe(30);
      // The resubscribe did not silently replace the widened history.
      const afterResume = yield* SubscriptionRef.get(harness.threadState.state);
      expect(hasMessage(afterResume, "message-old")).toBe(true);
    }),
  );

  it.effect("a narrowing refresh after thread events installs and stays sequence-consistent", () =>
    Effect.gen(function* () {
      // Here the watermark proves thread-detail events HAVE landed since our
      // state, so the retained history cannot be shown to be current. Accept
      // the refreshed window: staying behind would only defer the same
      // replacement to the resume-gap fallback, and get there without
      // sequence continuity.
      const mergedCache: OrchestrationThreadDetailSnapshot = {
        snapshotSequence: 10,
        thread: { ...BASE_THREAD, messages: [OLDER_MESSAGE, RECENT_MESSAGE] },
        page: { beforeCursor: "cursor-deep", hasMore: true, snapshotSequence: 10 },
      };
      const harness = yield* makeHarness({ cached: mergedCache, deferInitial: true });
      yield* harness.awaitState((value) => hasMessage(value, "message-old"));

      yield* harness.resolveNextInitial(
        Option.some({
          snapshotSequence: 30,
          thread: { ...BASE_THREAD, title: "Narrow refresh" },
          page: {
            beforeCursor: "cursor-1",
            hasMore: true,
            snapshotSequence: 30,
            threadSequence: 25,
          },
        }),
      );

      const state = yield* harness.awaitState((value) =>
        Option.match(value.data, {
          onNone: () => false,
          onSome: (thread) => thread.title === "Narrow refresh",
        }),
      );
      expect(hasMessage(state, "message-old")).toBe(false);
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");

      yield* harness.reconnectWithPagination(true);
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput).pipe(
        Effect.repeat({ until: (input) => input?.afterSequence === 30 }),
      );
      expect(subscribeInput?.afterSequence).toBe(30);
    }),
  );

  it.effect("a superseded request never settles its successor's latch", () =>
    Effect.gen(function* () {
      // A warm install abandons request A and clears its latch. Request B then
      // claims the latch. When A finally returns it must stay silent: settling
      // here would drop B's spinner mid-flight, fire a false settledCount, and
      // let a third request start against the cursor B is already fetching.
      const harness = yield* makeHarness({ cached: WINDOWED_SNAPSHOT, deferInitial: true });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      // Requests go through the handle (the atom entry point the apps use)
      // rather than the registry: the registry drains serially, so a second
      // request could not overlap an in-flight first one there.
      yield* Effect.forkChild(harness.threadState.loadOlderMessages());
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );

      // Warm refresh installs (newer, non-narrowing) and abandons request A.
      yield* harness.resolveNextInitial(
        Option.some({
          snapshotSequence: 30,
          thread: { ...BASE_THREAD, title: "Refreshed" },
          page: { beforeCursor: "cursor-3", hasMore: true, snapshotSequence: 30 },
        }),
      );
      const abandoned = yield* harness.awaitState(
        (value) =>
          !value.olderMessages.isLoading &&
          Option.match(value.data, {
            onNone: () => false,
            onSome: (thread) => thread.title === "Refreshed",
          }),
      );
      const settledAfterAbandon = abandoned.olderMessages.settledCount;

      // Request B claims the latch while A is still in flight.
      yield* Effect.forkChild(harness.threadState.loadOlderMessages());
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );

      // A returns late. It lost ownership, so it must not touch the latch.
      yield* harness.resolveNextPage(Option.some(OLDER_PAGE));
      yield* Effect.repeat(Effect.yieldNow, { times: 200 });
      const duringB = yield* SubscriptionRef.get(harness.threadState.state);
      expect(duringB.olderMessages.isLoading).toBe(true);
      expect(duringB.olderMessages.settledCount).toBe(settledAfterAbandon);

      // B's own response settles it exactly once.
      yield* harness.resolveNextPage(Option.some(OLDER_PAGE));
      const settled = yield* harness.awaitState((value) => !value.olderMessages.isLoading);
      expect(settled.olderMessages.settledCount).toBe(settledAfterAbandon + 1);
    }),
  );

  it.effect("a late turn response never settles a legacy scrollback latch", () =>
    Effect.gen(function* () {
      // Downgrading to a pre-pagination server abandons the in-flight turn
      // request. Its late response must not settle — or clear the error of —
      // the legacy request that ran after the downgrade.
      const legacySnapshot: OrchestrationThreadDetailSnapshot = {
        snapshotSequence: 20,
        thread: {
          ...BASE_THREAD,
          title: "Legacy",
          messageWindow: {
            hasMoreOlder: true,
            oldestLoadedMessageId: RECENT_MESSAGE.id,
            totalCount: 5,
          },
        },
      };
      const harness = yield* makeHarness({
        initialResponses: [Option.some(WINDOWED_SNAPSHOT), Option.some(legacySnapshot)],
      });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );

      yield* harness.reconnectWithPagination(false);
      yield* harness.awaitState(
        (value) =>
          Option.isNone(value.page) &&
          Option.match(value.data, {
            onNone: () => false,
            onSome: (thread) => thread.title === "Legacy",
          }),
      );

      // Legacy scrollback runs and settles with its own failure (no message
      // page loader is provided in this harness).
      yield* harness.threadState.loadOlderMessages();
      const afterLegacy = yield* harness.awaitState((value) => value.olderMessages.error !== null);
      const settledAfterLegacy = afterLegacy.olderMessages.settledCount;
      expect(afterLegacy.olderMessages.error).not.toBe(null);

      // The abandoned turn request returns last; it must change nothing.
      yield* harness.resolveNextPage(Option.some(OLDER_PAGE));
      yield* Effect.repeat(Effect.yieldNow, { times: 200 });
      const final = yield* SubscriptionRef.get(harness.threadState.state);
      expect(final.olderMessages.settledCount).toBe(settledAfterLegacy);
      expect(final.olderMessages.error).toBe(afterLegacy.olderMessages.error);
    }),
  );

  it.effect("keeps a windowed cache when the server supports pagination", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: WINDOWED_SNAPSHOT });
      const state = yield* harness.awaitState((value) => Option.isSome(value.page));
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");
      // Wait for the subscription (recorded when the WS method is invoked)
      // before asserting its input.
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput).pipe(
        Effect.repeat({ until: (input) => input !== undefined }),
      );
      expect(subscribeInput?.afterSequence).toBe(10);
    }),
  );
});
