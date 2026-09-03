import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type MessageId,
  type OrchestrationThread,
  type OrchestrationThreadDetailPage,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadMessagePage,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase, type PreparedConnection } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { withEnvironmentCacheMutationLock } from "../platform/environmentCacheMutationLock.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { ThreadMessagePageLoader } from "./threadMessagesHttp.ts";
import { ThreadSnapshotLoader, type ThreadSnapshotWindow } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import {
  coalesceThreadStreamItems,
  filterAppliedThreadStreamItems,
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
  DEFAULT_INITIAL_TURN_LIMIT,
  DEFAULT_MESSAGE_OLDER_PAGE_SIZE,
  DEFAULT_MESSAGE_WINDOW_LIMIT,
  DEFAULT_OLDER_TURN_LIMIT,
  MAX_MESSAGE_WINDOW_MULTIPLIER,
  ThreadHistoryWindow,
  THREAD_STATE_IDLE_TTL_MS,
} from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  EMPTY_THREAD_OLDER_MESSAGES_STATE,
  type EnvironmentThreadPageState,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
  type ThreadLoadOlderHistoryOptions,
} from "./threadState.ts";

export interface EnvironmentThreadStateHandle {
  readonly state: SubscriptionRef.SubscriptionRef<EnvironmentThreadState>;
  readonly loadOlderMessages: (options?: ThreadLoadOlderHistoryOptions) => Effect.Effect<void>;
}

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

/**
 * Turn window sizes for paginated thread loads. Re-exported from the retention
 * module so callers that only import thread state keep working.
 */
export const INITIAL_THREAD_USER_TURN_LIMIT = DEFAULT_INITIAL_TURN_LIMIT;
export const OLDER_THREAD_PAGE_USER_TURN_LIMIT = DEFAULT_OLDER_TURN_LIMIT;

function pageStateFromSnapshot(
  page: OrchestrationThreadDetailPage | undefined,
): Option.Option<EnvironmentThreadPageState> {
  return page === undefined
    ? Option.none()
    : Option.some({
        beforeCursor: page.beforeCursor,
        hasMore: page.hasMore,
        loadingOlder: false,
      });
}

function persistedPage(
  page: Option.Option<EnvironmentThreadPageState>,
  snapshotSequence: number,
): { readonly page?: OrchestrationThreadDetailPage } {
  return Option.match(page, {
    onNone: () => ({}),
    onSome: (value) =>
      ({
        page: {
          beforeCursor: value.beforeCursor,
          hasMore: value.hasMore,
          snapshotSequence,
        },
      }) as const,
  });
}

interface ThreadOlderTurnRequestRegistry {
  /**
   * Registers the live state machine for a thread. Returns the deregistration
   * cleanup; registration lives exactly as long as the machine's scope, and a
   * successor machine for the same thread simply replaces the entry.
   */
  readonly register: (key: string, handler: () => void) => () => void;
  readonly request: (key: string) => boolean;
}

function makeThreadOlderTurnRequestRegistry(): ThreadOlderTurnRequestRegistry {
  const handlers = new Map<string, () => void>();
  return {
    register: (key, handler) => {
      handlers.set(key, handler);
      return () => {
        if (handlers.get(key) === handler) {
          handlers.delete(key);
        }
      };
    },
    request: (key) => {
      const handler = handlers.get(key);
      if (handler === undefined) {
        return false;
      }
      handler();
      return true;
    },
  };
}

const defaultOlderTurnRequestRegistry = makeThreadOlderTurnRequestRegistry();

/**
 * Channel from UI actions to the live per-thread state machines. The machines
 * resolve it from the Effect environment (overridable in tests); the default
 * instance is shared with the sync `requestOlderThreadTurns` entry point so
 * the apps get working wiring without providing anything.
 */
export class ThreadOlderTurnRequests extends Context.Reference<ThreadOlderTurnRequestRegistry>(
  "@t3tools/client-runtime/state/threads/ThreadOlderTurnRequests",
  { defaultValue: () => defaultOlderTurnRequestRegistry },
) {}

/**
 * Asks the live state machine for `threadId` to fetch the next older page.
 * Returns false when no machine is live; callers render from
 * `EnvironmentThreadState.page`/`olderMessages` and can treat false as
 * "nothing to do".
 */
export function requestOlderThreadTurns(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
): boolean {
  return defaultOlderTurnRequestRegistry.request(threadKey({ environmentId, threadId }));
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

interface ThreadWarmRefreshRetention {
  readonly messageWindowLimit: number | null;
  readonly maxLoadedOlderMessageCount: number | null;
}

/**
 * Reattaches explicitly loaded older messages that a warm refresh's base
 * window doesn't cover. The merge is clamped to the same bounds explicit
 * scrollback observes (`MAX_MESSAGE_WINDOW_MULTIPLIER` resident messages,
 * `maxLoadedOlderMessageCount` older messages) so a warm refresh can never
 * grow the retained history past what `loadOlderMessages` itself allows.
 *
 * LEGACY message-window mode only. Turn-windowed threads never take this path:
 * their warm refresh either replaces the window wholesale (nothing older is
 * loaded yet) or is skipped (see refreshWarmSnapshot).
 */
export function preserveLoadedOlderMessages(
  current: OrchestrationThread,
  refreshed: OrchestrationThread,
  loadedOlderCount: number,
  retention: ThreadWarmRefreshRetention,
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
  const totalCountBound =
    totalCount === null ? candidates.length : Math.max(0, totalCount - refreshed.messages.length);
  const naturalBound = Math.min(candidates.length, totalCountBound);
  const residentCapBound =
    retention.messageWindowLimit === null
      ? Number.POSITIVE_INFINITY
      : Math.max(
          0,
          retention.messageWindowLimit * MAX_MESSAGE_WINDOW_MULTIPLIER - refreshed.messages.length,
        );
  const olderCountCapBound = retention.maxLoadedOlderMessageCount ?? Number.POSITIVE_INFINITY;
  const retentionBound = Math.min(residentCapBound, olderCountCapBound);
  const cappedByRetention = retentionBound < naturalBound;
  const preserveCount = Math.min(naturalBound, retentionBound);
  const preservedOlder = preserveCount <= 0 ? [] : candidates.slice(-preserveCount);
  if (preservedOlder.length === 0) return refreshed;
  const messages = [...preservedOlder, ...refreshed.messages];
  return {
    ...refreshed,
    messages,
    messageWindow: {
      // Retention caps stop growth outright, mirroring the explicit-scrollback
      // cap in `loadOlderMessages`: don't invite more loads once the resident
      // or older-message ceiling is reached.
      hasMoreOlder: cappedByRetention
        ? false
        : totalCount === null
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

/**
 * Per-thread live state machine.
 *
 * History loading has two mutually exclusive modes, chosen per connection from
 * the server's `threadSnapshotPagination` capability:
 *
 * - TURN WINDOW (current): the snapshot is bounded to N user-anchored turns and
 *   carries an opaque `page` cursor. "Load earlier" fetches the adjacent older
 *   page and merges it below the loaded window.
 * - LEGACY MESSAGE WINDOW: used only against servers that predate turn
 *   windows. The snapshot is bounded by `messageLimit` and carries
 *   `thread.messageWindow`; "load earlier" pages messages by id.
 *
 * The two never mix on one response — the server enforces that — and the client
 * never sends both window parameters in one request (see makeSubscribeInput).
 */
export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  // Every fiber that can read stream events, mutate `state`, or enqueue a
  // persistence write is forked into this dedicated child scope. On teardown
  // we close `teardownScope` first (interrupting and
  // *awaiting* all of those fibers) before flushing pending items and
  // persisting the final snapshot, so no producer can still be applying a
  // late event (e.g. the last running -> idle transition) while the
  // finalizer reads `state` and writes the cache. See the finalizer below.
  const teardownScope = yield* Scope.make();
  // Ensure partial initialization cannot leak the independent child scope. The
  // final persistence finalizer below closes it first during normal teardown;
  // this earlier registration is then an idempotent no-op.
  yield* Effect.addFinalizer(() => Scope.close(teardownScope, Exit.void));
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const messagePageLoader = yield* Effect.serviceOption(ThreadMessagePageLoader);
  const configuredHistoryWindow = yield* Effect.serviceOption(ThreadHistoryWindow);
  const historyWindow = Option.getOrElse(configuredHistoryWindow, () => ({
    messageWindowLimit: DEFAULT_MESSAGE_WINDOW_LIMIT,
    messageOlderPageSize: DEFAULT_MESSAGE_OLDER_PAGE_SIZE,
    initialTurnLimit: null as number | null,
    olderTurnLimit: DEFAULT_OLDER_TURN_LIMIT,
    residentMessageCeiling: null as number | null,
  }));
  // `null` opts this client out of turn pagination entirely (web/desktop): it
  // then always requests — and the server always serves — full history.
  const initialTurnLimit = historyWindow.initialTurnLimit ?? null;
  const olderTurnLimit = historyWindow.olderTurnLimit ?? DEFAULT_OLDER_TURN_LIMIT;
  const residentMessageCeiling = historyWindow.residentMessageCeiling ?? null;
  const maxLoadedOlderMessageCount =
    historyWindow.messageWindowLimit === null
      ? null
      : historyWindow.messageWindowLimit * (MAX_MESSAGE_WINDOW_MULTIPLIER - 1);
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
  // A cached turn window is stored verbatim: its cursor describes exactly the
  // rows it holds, so trimming it here would make the cursor skip history.
  // Only legacy/full cached threads go through message retention.
  const cachedThread = Option.map(cached, (snapshot) =>
    snapshot.page === undefined
      ? retainRecentThreadHistory(snapshot.thread, {
          messageWindowLimit: historyWindow.messageWindowLimit,
        })
      : snapshot.thread,
  );
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
    // A cached windowed snapshot restores its page cursor so "load earlier"
    // works while rendering from cache; a cached full snapshot has no page.
    page: Option.flatMap(cached, (snapshot) => pageStateFromSnapshot(snapshot.page)),
    olderMessages: EMPTY_THREAD_OLDER_MESSAGES_STATE,
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  const lastRevertSequence = yield* Ref.make(0);
  const loadedOlderMessageCount = yield* Ref.make(0);
  // Number of older TURN pages merged below the initial window. Reset on every
  // snapshot install; gates the warm refresh, which can only safely replace a
  // window it did not page beyond.
  const loadedOlderPageCount = yield* Ref.make(0);
  // Distinguishes a client-enforced history ceiling from a server-reported end
  // of history so a revert can reopen paging after it frees resident capacity.
  const olderHistoryCapped = yield* Ref.make(false);
  const tornDown = yield* Ref.make(false);
  // Bumped whenever loaded history may have been rewritten out from under an
  // in-flight older-page fetch: a hard snapshot install, a revert, or a
  // deletion. An in-flight request can land with a cursor that coincidentally
  // matches the post-rewrite window, so the cursor check alone can't detect
  // staleness; this generation check can. A response captured under an older
  // generation is discarded, not merged.
  const historyEpoch = yield* Ref.make(0);
  const mutationLock = yield* Semaphore.make(1);
  const pendingItems = yield* Ref.make<Array<OrchestrationThreadStreamItem>>([]);
  const flushGeneration = yield* Ref.make(0);
  // Whether the connected server accepts windowed reads; set per subscription
  // from the session config. Gates the turn-window mode so a reconnect to a
  // pre-pagination server never sends unsupported query parameters.
  const paginationSupported = yield* Ref.make(false);
  // An older page whose thread watermark is ahead of the live state, parked
  // until the subscription catches up. At most one can exist because the
  // loader no-ops while a fetch is in flight.
  const pendingOlderPage = yield* Ref.make<{
    readonly snapshot: OrchestrationThreadDetailSnapshot;
    readonly epoch: number;
    readonly owner: number;
  } | null>(null);
  // Ownership token for the in-flight older-history request. `historyEpoch`
  // stops stale DATA from merging; this stops a stale COMPLETION from settling
  // somebody else's latch. Without it: request A starts, a warm-refresh install
  // abandons it and clears the latch, request B starts, then A returns and —
  // seeing a stale epoch — settles B's latch. That fires a false `settledCount`
  // notification, drops the spinner while B is still running, and lets a third
  // request start against the cursor B is already fetching. Only the current
  // owner may settle; every abandonment invalidates outstanding ownership.
  const olderRequestOwner = yield* Ref.make(0);
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);
  const artifactRefreshes = yield* Queue.sliding<PreparedConnection>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    yield* withEnvironmentCacheMutationLock(
      cache,
      environmentId,
      Effect.gen(function* () {
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
        // Never trim a windowed snapshot: its cursor and its rows must stay in
        // agreement or a cache restore would page from the wrong boundary.
        const retainedSnapshot =
          snapshot.page === undefined
            ? {
                ...snapshot,
                thread: retainRecentThreadHistory(snapshot.thread, {
                  messageWindowLimit: historyWindow.messageWindowLimit,
                }),
              }
            : snapshot;
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
      }),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkIn(teardownScope),
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
    current.status === "deleted"
      ? current
      : {
          ...current,
          status: current.status === "live" ? current.status : ("synchronizing" as const),
          error: Option.none(),
          olderMessages: { ...current.olderMessages, error: null },
        },
  );
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    // The capability belongs to the session that advertised it. During a
    // reconnect, a new prepared connection can exist before the new session's
    // config arrives; leaving the old value would let an older-page fetch send
    // window parameters to a server that may not accept them.
    // makeSubscribeInput re-sets it from the next session's config.
    yield* Ref.set(paginationSupported, false);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  const setOlderLoading = (isLoading: boolean) =>
    SubscriptionRef.update(state, (current) => ({
      ...current,
      page: Option.map(current.page, (existing) => ({ ...existing, loadingOlder: isLoading })),
      olderMessages: { ...current.olderMessages, isLoading, error: null },
    }));
  const settleOlderMessages = (error: string | null) =>
    SubscriptionRef.update(state, (current) => ({
      ...current,
      page: Option.map(current.page, (existing) => ({ ...existing, loadingOlder: false })),
      olderMessages: {
        isLoading: false,
        error,
        settledCount: current.olderMessages.settledCount + 1,
      },
    }));
  /**
   * Claims the older-history latch for a new request and returns its ownership
   * token. Invalidates any previous owner, so a superseded request's late
   * response can no longer settle this one.
   */
  const beginOlderRequest = Effect.fn("EnvironmentThreadState.beginOlderRequest")(function* () {
    const owner = yield* Ref.updateAndGet(olderRequestOwner, (value) => value + 1);
    yield* setOlderLoading(true);
    return owner;
  });
  /**
   * Settles the latch only if `owner` still holds it. A deleted thread is the
   * one exception: deletion invalidates ownership so a late response cannot
   * touch a reinstalled thread, but while the state is still deleted the
   * settle goes through so the request's waiters observe a settlement.
   */
  const settleOwnedOlderMessages = (owner: number, error: string | null) =>
    Effect.all([Ref.get(olderRequestOwner), SubscriptionRef.get(state)]).pipe(
      Effect.flatMap(([current, currentState]) =>
        current === owner || currentState.status === "deleted"
          ? settleOlderMessages(error)
          : Effect.void,
      ),
    );
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
    // "keep" preserves the current page state (live events touch only loaded
    // recent turns); a snapshot or merged page passes its own page state.
    page: Option.Option<EnvironmentThreadPageState> | "keep",
    messageWindowLimit: number | null = historyWindow.messageWindowLimit,
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    const currentState = yield* SubscriptionRef.get(state);
    const nextPage = page === "keep" ? currentState.page : page;
    // A turn-windowed thread is bounded by the server and its cursor names the
    // exact boundary of what it returned. Trimming inside that page while
    // keeping the cursor would permanently skip the trimmed rows, so retention
    // applies only to legacy/full threads.
    const retainedThread = Option.isSome(nextPage)
      ? thread
      : retainRecentThreadHistory(thread, { messageWindowLimit });
    yield* SubscriptionRef.set(state, {
      data: Option.some(retainedThread),
      status: waiting ? "synchronizing" : "live",
      error: Option.none(),
      page: nextPage,
      olderMessages: currentState.olderMessages,
    });
    // Active threads can update many times per second and retain large tool
    // payloads. The server remains the source of truth while a turn is active;
    // persist once it settles so cache encoding stays off the streaming path.
    if (shouldPersistThread(retainedThread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, {
        snapshotSequence,
        thread: retainedThread,
        // Persist the window boundary with the window's content so a cache
        // restore can keep paging from where the loaded history ends.
        ...persistedPage(nextPage, snapshotSequence),
      });
    }
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* Ref.set(olderHistoryCapped, false);
    yield* Ref.set(pendingOlderPage, null);
    yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
    // A pre-delete request must not settle the latch after the thread is
    // reinstalled, so deletion invalidates ownership like abandonment does and
    // settles any in-flight request itself so its waiters wake now.
    yield* Ref.update(olderRequestOwner, (value) => value + 1);
    yield* SubscriptionRef.update(state, (current) => ({
      data: Option.none(),
      status: "deleted" as const,
      error: Option.none(),
      page: Option.none(),
      olderMessages: {
        isLoading: false,
        error: null,
        settledCount: current.olderMessages.settledCount,
      },
    }));
    yield* withEnvironmentCacheMutationLock(
      cache,
      environmentId,
      cache.removeThread(environmentId, threadId),
    ).pipe(
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

  // Merges an older disjoint turn page below the currently loaded window. All
  // windowed collections prepend; identity dedupe guards the (server-bug or
  // cursor-misuse) case of overlapping pages so a row never renders twice.
  // Must run under `mutationLock`.
  const mergeOlderPageUnlocked = Effect.fn("EnvironmentThreadState.mergeOlderPage")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
    owner: number,
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (Option.isNone(current.data)) {
      return;
    }
    const loaded = current.data.value;
    const older = snapshot.thread;
    const mergeById = <T extends { readonly id: string }>(
      olderRows: ReadonlyArray<T>,
      loadedRows: ReadonlyArray<T>,
    ): ReadonlyArray<T> => {
      const seen = new Set(loadedRows.map((row) => row.id));
      return [...olderRows.filter((row) => !seen.has(row.id)), ...loadedRows];
    };
    const seenCheckpoints = new Set(loaded.checkpoints.map((row) => row.turnId));
    const merged: OrchestrationThread = {
      // Thread metadata stays the loaded (newer) snapshot's; only the
      // windowed collections gain rows from the older page.
      ...loaded,
      messages: mergeById(older.messages, loaded.messages),
      activities: mergeById(older.activities, loaded.activities),
      proposedPlans: mergeById(older.proposedPlans, loaded.proposedPlans),
      checkpoints: [
        ...older.checkpoints.filter((row) => !seenCheckpoints.has(row.turnId)),
        ...loaded.checkpoints,
      ],
    };
    const nextPage = pageStateFromSnapshot(snapshot.page);
    const owns = (yield* Ref.get(olderRequestOwner)) === owner;
    yield* Ref.update(loadedOlderPageCount, (count) => count + 1);
    yield* SubscriptionRef.set(state, {
      ...current,
      data: Option.some(merged),
      page: nextPage,
      // The merge itself is gated by `historyEpoch`, which is always bumped
      // alongside an ownership change — so reaching here means the data is
      // still valid. The LATCH, though, may belong to a successor request by
      // now; only its owner may release it.
      olderMessages: owns
        ? {
            isLoading: false,
            error: null,
            settledCount: current.olderMessages.settledCount + 1,
          }
        : current.olderMessages,
    });
    // Persist the widened window under the *loaded* watermark: the merged
    // content is only known consistent with the state it merged into, not
    // with the page's own (possibly newer) sequence.
    if (shouldPersistThread(merged)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, {
        snapshotSequence,
        thread: merged,
        ...persistedPage(nextPage, snapshotSequence),
      });
    }
  });

  /**
   * Drops a parked older page and releases the "loading older" latch after
   * history was rewritten underneath it (a warm-refresh install, a capability
   * downgrade — anything that bumps `historyEpoch` outside the stream path).
   *
   * A parked page is normally resolved by `tryMergePendingOlderPage`, which
   * only runs when a stream item is applied. On an idle thread no further item
   * may ever arrive, so an epoch bump from outside that path has to clean up
   * after itself; otherwise the spinner stays up forever and every later
   * request is rejected by the `olderMessages.isLoading` guard.
   *
   * The latch is released whenever it is set, not only when a page was parked:
   * an in-flight fetch cannot be cancelled, and a missed settle wedges paging
   * permanently. Ownership is invalidated at the same time, so that in-flight
   * fetch can no longer settle the latch when it eventually returns — by then
   * the latch may belong to a successor request.
   * Must run under `mutationLock`.
   */
  const abandonPendingOlderPage = Effect.fn("EnvironmentThreadState.abandonPendingOlderPage")(
    function* () {
      const hadParkedPage = (yield* Ref.getAndSet(pendingOlderPage, null)) !== null;
      yield* Ref.update(olderRequestOwner, (value) => value + 1);
      const current = yield* SubscriptionRef.get(state);
      if (hadParkedPage || current.olderMessages.isLoading) {
        yield* settleOlderMessages(null);
      }
    },
  );

  // Merges a parked older page once the live state has caught up to the page's
  // thread watermark, or discards it if history was rewritten (epoch advanced)
  // while it waited. Must run under `mutationLock`.
  const tryMergePendingOlderPage = Effect.fn("EnvironmentThreadState.tryMergePendingOlderPage")(
    function* () {
      const pending = yield* Ref.get(pendingOlderPage);
      if (pending === null) {
        return;
      }
      const epochNow = yield* Ref.get(historyEpoch);
      if (epochNow !== pending.epoch) {
        yield* Ref.set(pendingOlderPage, null);
        yield* settleOwnedOlderMessages(pending.owner, null);
        return;
      }
      const watermark = pending.snapshot.page?.threadSequence;
      const loadedSequence = yield* SubscriptionRef.get(lastSequence);
      if (watermark !== undefined && watermark > loadedSequence) {
        return;
      }
      yield* Ref.set(pendingOlderPage, null);
      yield* mergeOlderPageUnlocked(pending.snapshot, pending.owner);
    },
  );

  interface OlderTurnRequest {
    readonly prepared: PreparedConnection;
    readonly beforeCursor: string;
    readonly epoch: number;
    readonly sequence: number;
    /** Ownership token; only its holder may settle the latch on return. */
    readonly owner: number;
  }

  /**
   * Turn-window "load earlier". Fetches the adjacent older page from the
   * server and merges it below the loaded window; never slices the returned
   * page and never rewrites `page.hasMore`.
   */
  const loadOlderTurns = Effect.fn("EnvironmentThreadState.loadOlderTurns")(function* (options: {
    readonly automatic: boolean;
  }) {
    const request = yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(tornDown)) return Option.none<OlderTurnRequest>();
        yield* flushPendingUnlocked();
        const current = yield* SubscriptionRef.get(state);
        // Keep this guard ahead of the data/window guards: a duplicate attempt
        // must settle without clearing the accepted request's loading/error
        // state.
        if (current.olderMessages.isLoading) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            olderMessages: {
              ...value.olderMessages,
              settledCount: value.olderMessages.settledCount + 1,
            },
          }));
          return Option.none<OlderTurnRequest>();
        }
        const page = Option.getOrNull(current.page);
        if (
          current.status === "deleted" ||
          Option.isNone(current.data) ||
          page === null ||
          !page.hasMore ||
          page.beforeCursor === null
        ) {
          yield* settleOlderMessages(null);
          return Option.none<OlderTurnRequest>();
        }
        // Soft resident ceiling: it only holds back AUTOMATIC refills. It never
        // trims the loaded window and never overwrites the server's
        // `hasMore`, so an explicit "load earlier" always still works and no
        // history becomes unreachable.
        if (
          options.automatic &&
          residentMessageCeiling !== null &&
          current.data.value.messages.length >= residentMessageCeiling
        ) {
          yield* settleOlderMessages(null);
          return Option.none<OlderTurnRequest>();
        }
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared)) {
          // React can batch adjacent state publications into one commit, so a
          // synthetic loading transition is not a reliable latch-release
          // signal. Every terminal attempt increments `settledCount` instead.
          yield* settleOlderMessages("The environment is not connected.");
          return Option.none<OlderTurnRequest>();
        }
        return Option.some({
          prepared: prepared.value,
          beforeCursor: page.beforeCursor,
          epoch: yield* Ref.get(historyEpoch),
          sequence: yield* SubscriptionRef.get(lastSequence),
          owner: yield* beginOlderRequest(),
        });
      }),
    );
    if (Option.isNone(request)) return;

    const window: ThreadSnapshotWindow = {
      turnLimit: olderTurnLimit,
      beforeCursor: request.value.beforeCursor,
    };
    const response = yield* snapshotLoader.load(request.value.prepared, threadId, window);

    // The staleness check and the merge run under the same lock as stream-item
    // application, so a revert/snapshot cannot land between them: anything
    // that rewrites history bumps the epoch before this permit is acquired.
    yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(tornDown)) return;
        yield* flushPendingUnlocked();
        if (yield* Ref.get(tornDown)) return;
        const current = yield* SubscriptionRef.get(state);
        if (current.status === "deleted" || Option.isNone(current.data)) {
          yield* settleOwnedOlderMessages(request.value.owner, null);
          return;
        }
        if (Option.isNone(response)) {
          yield* settleOwnedOlderMessages(request.value.owner, "Could not load earlier messages.");
          return;
        }
        const epochNow = yield* Ref.get(historyEpoch);
        const revertedAt = yield* Ref.get(lastRevertSequence);
        const loadedSequence = yield* SubscriptionRef.get(lastSequence);
        // A page carrying a sequence older than the loaded state was read from
        // a projection behind what we render; merging it could resurrect turns
        // a newer snapshot or revert already removed.
        if (
          epochNow !== request.value.epoch ||
          revertedAt > request.value.sequence ||
          response.value.snapshotSequence < loadedSequence
        ) {
          // Stale response. It may only release the latch if it still owns it:
          // an abandonment already handed ownership on, and settling here would
          // clear a successor request's spinner mid-flight.
          yield* settleOwnedOlderMessages(request.value.owner, null);
          return;
        }
        // A page read AHEAD of the live state may include content (e.g.
        // streaming deltas of an out-of-window turn) the subscription has not
        // delivered yet; merging now and then replaying those events would
        // duplicate them. Park the page until the live state reaches the
        // page's thread-scoped watermark; the loading flag stays set so the UI
        // shows progress and no second fetch starts. Pages from pre-watermark
        // servers (threadSequence absent) merge immediately.
        const watermark = response.value.page?.threadSequence;
        if (watermark !== undefined && watermark > loadedSequence) {
          yield* Ref.set(pendingOlderPage, {
            snapshot: response.value,
            epoch: epochNow,
            owner: request.value.owner,
          });
          return;
        }
        yield* mergeOlderPageUnlocked(response.value, request.value.owner);
      }),
    );
  });

  /**
   * LEGACY message-window "load earlier", used only against servers without
   * turn-window support.
   */
  const loadOlderMessages = Effect.fn("EnvironmentThreadState.loadOlderMessages")(function* () {
    const request = yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(tornDown)) {
          return Option.none<{
            readonly prepared: PreparedConnection;
            readonly beforeMessageId: MessageId | null;
            readonly limit: number;
            readonly sequence: number;
            readonly generation: number;
            readonly owner: number;
          }>();
        }
        yield* flushPendingUnlocked();
        const current = yield* SubscriptionRef.get(state);
        // Keep this guard ahead of the data/window guards: a duplicate attempt
        // must settle without clearing the accepted request's loading/error state.
        if (current.olderMessages.isLoading) {
          // This invocation is terminal even though another accepted request is
          // still loading. Advance the signal without clearing that request.
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            olderMessages: {
              ...value.olderMessages,
              settledCount: value.olderMessages.settledCount + 1,
            },
          }));
          return Option.none<{
            readonly prepared: PreparedConnection;
            readonly beforeMessageId: MessageId | null;
            readonly limit: number;
            readonly sequence: number;
            readonly generation: number;
            readonly owner: number;
          }>();
        }
        if (
          current.status === "deleted" ||
          Option.isNone(current.data) ||
          current.data.value.messageWindow?.hasMoreOlder !== true
        ) {
          yield* settleOlderMessages(null);
          return Option.none<{
            readonly prepared: PreparedConnection;
            readonly beforeMessageId: MessageId | null;
            readonly limit: number;
            readonly sequence: number;
            readonly generation: number;
            readonly owner: number;
          }>();
        }

        const loadedOlderCount = yield* Ref.get(loadedOlderMessageCount);
        const remainingCapacity =
          maxLoadedOlderMessageCount === null
            ? historyWindow.messageOlderPageSize
            : Math.max(0, maxLoadedOlderMessageCount - loadedOlderCount);
        if (remainingCapacity === 0) {
          yield* Ref.set(olderHistoryCapped, true);
          yield* SubscriptionRef.update(state, (value) =>
            Option.match(value.data, {
              onNone: () => ({
                ...value,
                olderMessages: {
                  isLoading: false,
                  error: null,
                  settledCount: value.olderMessages.settledCount + 1,
                },
              }),
              onSome: (thread) => ({
                ...value,
                data: Option.some({
                  ...thread,
                  messageWindow: {
                    ...thread.messageWindow!,
                    hasMoreOlder: false,
                  },
                }),
                olderMessages: {
                  isLoading: false,
                  error: null,
                  settledCount: value.olderMessages.settledCount + 1,
                },
              }),
            }),
          );
          return Option.none();
        }

        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared)) {
          // React can batch adjacent state publications into one commit, so a
          // synthetic loading transition is not a reliable latch-release
          // signal. Every terminal attempt increments `settledCount` instead.
          yield* settleOlderMessages("The environment is not connected.");
          return Option.none();
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const generation = yield* Ref.get(historyEpoch);
        return Option.some({
          prepared: prepared.value,
          beforeMessageId: current.data.value.messageWindow.oldestLoadedMessageId,
          limit: Math.min(historyWindow.messageOlderPageSize, remainingCapacity),
          sequence,
          generation,
          owner: yield* beginOlderRequest(),
        });
      }),
    );
    if (Option.isNone(request)) return;

    const page = Option.isNone(messagePageLoader)
      ? Option.none<OrchestrationThreadMessagePage>()
      : yield* messagePageLoader.value.loadOlder(request.value.prepared, threadId, {
          beforeMessageId: request.value.beforeMessageId,
          limit: request.value.limit,
        });

    yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(tornDown)) return;
        yield* flushPendingUnlocked();
        if (yield* Ref.get(tornDown)) return;
        const current = yield* SubscriptionRef.get(state);
        if (current.status === "deleted" || Option.isNone(current.data)) {
          yield* settleOwnedOlderMessages(request.value.owner, null);
          return;
        }

        const revertedAt = yield* Ref.get(lastRevertSequence);
        const currentCursor = current.data.value.messageWindow?.oldestLoadedMessageId ?? null;
        const currentGeneration = yield* Ref.get(historyEpoch);
        if (
          revertedAt > request.value.sequence ||
          currentCursor !== request.value.beforeMessageId ||
          currentGeneration !== request.value.generation
        ) {
          // Stale, or superseded by an abandonment: settle only if still owned.
          yield* settleOwnedOlderMessages(request.value.owner, null);
          return;
        }
        if (Option.isNone(page) || page.value.threadId !== threadId) {
          yield* settleOwnedOlderMessages(request.value.owner, "Could not load older messages.");
          return;
        }
        if (page.value.snapshotSequence < revertedAt) {
          yield* settleOwnedOlderMessages(request.value.owner, null);
          return;
        }

        const currentThread = current.data.value;
        const prependedThread = prependOlderThreadMessages(currentThread, page.value);
        const addedCount = Math.max(
          0,
          prependedThread.messages.length - currentThread.messages.length,
        );
        const loadedOlderCount = yield* Ref.updateAndGet(loadedOlderMessageCount, (count) =>
          maxLoadedOlderMessageCount === null
            ? count + addedCount
            : Math.min(maxLoadedOlderMessageCount, count + addedCount),
        );
        const reachedLoadedHistoryLimit =
          maxLoadedOlderMessageCount !== null && loadedOlderCount >= maxLoadedOlderMessageCount;
        const cappedByClient =
          reachedLoadedHistoryLimit && prependedThread.messageWindow?.hasMoreOlder === true;
        const thread = cappedByClient
          ? {
              ...prependedThread,
              messageWindow: { ...prependedThread.messageWindow, hasMoreOlder: false },
            }
          : prependedThread;
        yield* Ref.set(olderHistoryCapped, cappedByClient);
        // The cursor/revert/epoch guards above already proved this page is
        // valid to merge; the latch, however, may have been handed to a
        // successor request by an abandonment, and only its owner may clear it.
        const owns = (yield* Ref.get(olderRequestOwner)) === request.value.owner;
        yield* SubscriptionRef.set(state, {
          ...current,
          data: Option.some(thread),
          olderMessages: owns
            ? {
                isLoading: false,
                error: null,
                settledCount: current.olderMessages.settledCount + 1,
              }
            : current.olderMessages,
        });
        if (shouldPersistThread(thread)) {
          const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
          yield* Queue.offer(persistence, { snapshotSequence, thread });
        }
      }),
    );
  });

  /**
   * Single "load earlier history" entry point. Routes to the turn-window
   * loader when the connected server advertises pagination, and to the legacy
   * message-window loader otherwise. The two never run against the same
   * response shape.
   */
  const loadOlderHistory = Effect.fn("EnvironmentThreadState.loadOlderHistory")(function* (
    options: { readonly automatic: boolean } = { automatic: false },
  ) {
    if (yield* Ref.get(paginationSupported)) {
      yield* loadOlderTurns(options);
      return;
    }
    yield* loadOlderMessages();
  });

  const applyItemsUnlocked = Effect.fn("EnvironmentThreadState.applyItemsUnlocked")(function* (
    items: ReadonlyArray<OrchestrationThreadStreamItem>,
  ) {
    if (items.length === 0) return;

    const initialSequence = yield* SubscriptionRef.get(lastSequence);
    const initialRevertSequence = yield* Ref.get(lastRevertSequence);
    const initialLoadedOlderCount = yield* Ref.get(loadedOlderMessageCount);
    const initialOlderHistoryCapped = yield* Ref.get(olderHistoryCapped);
    const initialState = yield* SubscriptionRef.get(state);
    let sequence = initialSequence;
    let revertSequence = initialRevertSequence;
    let loadedOlderCount = initialLoadedOlderCount;
    let historyCapped = initialOlderHistoryCapped;
    let data = initialState.data;
    let pageState: Option.Option<EnvironmentThreadPageState> | "keep" = "keep";
    let threadChanged = false;
    let deleted = false;
    let synchronized = false;
    let installed = false;
    let historyRewritten = false;

    const deduped = filterAppliedThreadStreamItems(items, initialSequence);
    for (const item of coalesceThreadStreamItems(deduped)) {
      if (item.kind === "synchronized") {
        synchronized = true;
        continue;
      }
      if (item.kind === "snapshot") {
        // A fresh snapshot replaces all loaded history, including older pages:
        // a turn reverted while disconnected would otherwise survive in the
        // preserved history with no event left to remove it. The epoch bump
        // below discards any older-page fetch racing this snapshot.
        sequence = item.snapshot.snapshotSequence;
        loadedOlderCount = 0;
        historyCapped = false;
        data = Option.some(item.snapshot.thread);
        pageState = pageStateFromSnapshot(item.snapshot.page);
        threadChanged = true;
        deleted = false;
        installed = true;
        continue;
      }
      if (item.event.sequence <= sequence) continue;
      sequence = item.event.sequence;
      if (item.event.type === "thread.reverted") {
        revertSequence = item.event.sequence;
        // A revert rewrites loaded history (whole turns disappear), so an
        // older-page fetch in flight may straddle the removed range. The stored
        // page cursor stays valid: cursors are an (anchor, turnId) keyset
        // derived from event content, which survives the revert projector's row
        // rewrite, so only the in-flight fetch needs discarding.
        historyRewritten = true;
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
        let thread = result.thread;
        if (item.event.type === "thread.reverted") {
          loadedOlderCount = Math.min(loadedOlderCount, thread.messages.length);
          if (
            historyCapped &&
            maxLoadedOlderMessageCount !== null &&
            loadedOlderCount < maxLoadedOlderMessageCount
          ) {
            historyCapped = false;
            if (thread.messageWindow?.hasMoreOlder === false) {
              thread = {
                ...thread,
                messageWindow: { ...thread.messageWindow, hasMoreOlder: true },
              };
            }
          }
        }
        data = Option.some(thread);
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
    if (historyCapped !== initialOlderHistoryCapped) {
      yield* Ref.set(olderHistoryCapped, historyCapped);
    }
    if (installed) {
      yield* Ref.set(loadedOlderPageCount, 0);
    }
    if (installed || historyRewritten) {
      yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
    }
    if (deleted) {
      yield* setDeleted();
    } else if (threadChanged && Option.isSome(data)) {
      const retainedLimit =
        historyWindow.messageWindowLimit === null
          ? null
          : historyWindow.messageWindowLimit + loadedOlderCount;
      yield* setThread(data.value, pageState, retainedLimit);
    }
    if (synchronized) {
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted"
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
    }
    // The batch may have advanced the live state past a parked page's
    // watermark (or invalidated it); resolve it as soon as that happens.
    yield* tryMergePendingOlderPage();
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
          yield* Effect.forkIn(scheduleFlush(generation, windowMs), teardownScope);
        }
      }),
    );
    if (item.kind !== "event" || item.event.type !== "thread.reverted") return;

    const current = yield* SubscriptionRef.get(state);
    if (Option.isNone(current.data) || current.data.value.messages.length !== 0) return;
    const currentThread = current.data.value;
    const hasOlder = Option.match(current.page, {
      onNone: () => currentThread.messageWindow?.hasMoreOlder === true,
      onSome: (page) => page.hasMore,
    });
    if (!hasOlder) return;
    // The refill's HTTP fetch must not hold up `acceptItem` — it runs inside
    // the WS event consumption loop (`Stream.runForEach(acceptItem)`), so
    // awaiting the page load here would stall every subsequent WS event
    // until it settled. Fork it into the thread's teardown scope instead;
    // the loader's own mutation-lock and stale-cursor/revert-sequence
    // guards still apply when it eventually runs, and teardown awaits it
    // before the final persisted snapshot is read.
    yield* Effect.forkIn(loadOlderHistory({ automatic: true }), teardownScope);
  });

  const refreshWarmSnapshot = Effect.fn("EnvironmentThreadState.refreshWarmSnapshot")(function* (
    prepared: PreparedConnection,
  ) {
    const paginated = yield* Ref.get(paginationSupported);
    // A warm refresh re-reads the *initial* window. Once older pages have been
    // merged below it, that window no longer describes the loaded history and
    // its cursor points above the loaded bottom, so adopting it would make
    // "load earlier" refetch pages we already hold. The refresh only hydrates
    // message artifacts, so skipping it is harmless — the next snapshot
    // install refreshes everything anyway.
    if (paginated && (yield* Ref.get(loadedOlderPageCount)) > 0) return;
    const window: ThreadSnapshotWindow | undefined = paginated
      ? { turnLimit: initialTurnLimit ?? INITIAL_THREAD_USER_TURN_LIMIT }
      : undefined;
    const httpSnapshot = yield* snapshotLoader.load(
      prepared,
      threadId,
      window ??
        (historyWindow.messageWindowLimit === null
          ? undefined
          : { messageLimit: historyWindow.messageWindowLimit }),
    );
    if (Option.isNone(httpSnapshot)) return;
    yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        yield* flushPendingUnlocked();
        const currentState = yield* SubscriptionRef.get(state);
        if (currentState.status === "deleted" || Option.isNone(currentState.data)) return;

        const sequence = yield* SubscriptionRef.get(lastSequence);
        if (paginated) {
          // Whether the refreshed window would NARROW the loaded history. The
          // `loadedOlderPageCount` fast path above cannot be trusted on its own:
          // it resets to 0 whenever the machine is rebuilt, so a thread restored
          // from cache with older pages already merged into it reaches here with
          // a count of 0 and would be truncated back to the initial window.
          // Content answers it definitively: if the refreshed window does not
          // contain the oldest message we currently hold, it covers strictly
          // less history.
          const loadedOldestId = currentState.data.value.messages[0]?.id;
          const refreshedMessageIds = new Set(
            httpSnapshot.value.thread.messages.map((message) => message.id),
          );
          const refreshWouldNarrow =
            loadedOldestId !== undefined && !refreshedMessageIds.has(loadedOldestId);

          // `snapshotSequence` is GLOBAL — it advances on every thread's
          // events — so a newer refresh usually says nothing about this thread.
          // The page's `threadSequence` is the thread-scoped watermark: when it
          // is at or behind the sequence we already hold, no thread-detail
          // event has landed since our state, and the refreshed window is our
          // window plus refreshed artifacts.
          //
          // Keeping history while leaving `lastSequence` behind would be a trap:
          // an idle thread receives no events to advance it (the subscription is
          // aggregate-filtered), so once unrelated server activity pushes the
          // head past the replay-gap limit the server answers the resume with a
          // fresh windowed snapshot, which installs hard and drops the widened
          // history anyway. So we advance the sequence too. That is provably
          // safe here: every event we skip is, by construction, another
          // thread's, and this subscription would never have delivered it.
          const refreshedThreadSequence = httpSnapshot.value.page?.threadSequence;
          const threadUnchangedSinceLoaded =
            refreshedThreadSequence !== undefined && refreshedThreadSequence <= sequence;

          if (httpSnapshot.value.snapshotSequence > sequence) {
            if (refreshWouldNarrow && threadUnchangedSinceLoaded) {
              // Retain the wider history AND stay sequence-consistent.
              yield* SubscriptionRef.set(lastSequence, httpSnapshot.value.snapshotSequence);
              yield* setThread(
                mergeThreadMessageArtifacts(
                  currentState.data.value,
                  httpSnapshot.value.thread,
                  // The refreshed window is narrower, so its completed-response
                  // ids cover only part of the loaded history; keep ours.
                  false,
                ),
                "keep",
              );
              return;
            }
            // Either the refresh is non-narrowing (a plain replacement), or
            // thread-detail events HAVE landed since our state and we cannot
            // prove the retained history is still current. Install it: falling
            // behind the sequence would only defer the same replacement to the
            // resume-gap fallback, and arrive there without sequence continuity.
            yield* SubscriptionRef.set(lastSequence, httpSnapshot.value.snapshotSequence);
            yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
            // This install supersedes any page parked against the old epoch.
            // Nothing else will notice on an idle thread, so release it here.
            yield* abandonPendingOlderPage();
            yield* setThread(
              httpSnapshot.value.thread,
              pageStateFromSnapshot(httpSnapshot.value.page),
            );
            return;
          }
          yield* setThread(
            mergeThreadMessageArtifacts(
              currentState.data.value,
              httpSnapshot.value.thread,
              httpSnapshot.value.snapshotSequence === sequence,
            ),
            "keep",
          );
          return;
        }

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
            {
              messageWindowLimit: historyWindow.messageWindowLimit,
              maxLoadedOlderMessageCount,
            },
          );
          const refreshedOlderCount = Math.max(
            0,
            refreshed.messages.length - httpSnapshot.value.thread.messages.length,
          );
          const cappedByClient =
            maxLoadedOlderMessageCount !== null &&
            refreshedOlderCount >= maxLoadedOlderMessageCount &&
            refreshed.messageWindow?.hasMoreOlder === false &&
            httpSnapshot.value.thread.messageWindow?.hasMoreOlder === true;
          yield* Ref.set(loadedOlderMessageCount, refreshedOlderCount);
          yield* Ref.set(olderHistoryCapped, cappedByClient);
          yield* setThread(
            refreshed,
            "keep",
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
          "keep",
          retainedLimit,
        );
      }),
    );
  });

  yield* Stream.fromQueue(artifactRefreshes).pipe(
    Stream.runForEach(refreshWarmSnapshot),
    Effect.forkIn(teardownScope),
  );

  if (Option.isSome(eventCoalescing)) {
    yield* eventCoalescing.value.changes.pipe(
      Stream.filter(
        (change) =>
          change.threadRef.environmentId === environmentId &&
          change.threadRef.threadId === threadId,
      ),
      Stream.runForEach(() => flushPending),
      Effect.forkIn(teardownScope),
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
    Effect.forkIn(teardownScope),
  );

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkIn(
    subscribeDynamic(
      ORCHESTRATION_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        const config = yield* session.initialConfig.pipe(
          Effect.orElseSucceed(
            () =>
              ({}) as {
                threadResumeCompletionMarker?: boolean;
                threadSnapshotPagination?: boolean;
              },
          ),
        );
        const supportsCompletionMarker = config.threadResumeCompletionMarker === true;
        // Windowed loads are gated on the server capability AND on this client
        // opting in (`initialTurnLimit`): pre-pagination servers reject unknown
        // query params, and a windowed fallback to such a server would silently
        // hide history.
        const supportsPagination =
          config.threadSnapshotPagination === true && initialTurnLimit !== null;
        const turnLimit = initialTurnLimit ?? INITIAL_THREAD_USER_TURN_LIMIT;
        yield* Ref.set(paginationSupported, supportsPagination);
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;
        yield* flushPending;

        let current = yield* SubscriptionRef.get(state);
        // A windowed cache resuming against a server without pagination is a
        // trap: afterSequence resume keeps only the window, and the missing
        // older turns can never be loaded (the server has no cursor reads).
        // Drop the window marker and treat the data as needing a full reload.
        if (!supportsPagination && Option.isSome(current.page)) {
          yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
          yield* Ref.set(loadedOlderPageCount, 0);
          // The whole windowed mode is being torn down. Release the
          // "loading older" latch along with any parked page: carrying
          // `isLoading` into legacy mode would leave a stuck spinner and make
          // the legacy loader reject every scrollback request as a duplicate.
          yield* abandonPendingOlderPage();
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            data: Option.none(),
            status: value.status === "deleted" ? value.status : ("empty" as const),
            page: Option.none(),
          }));
          yield* SubscriptionRef.set(lastSequence, 0);
          current = yield* SubscriptionRef.get(state);
        }
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
              // Exactly one window mode per request: a turn window when the
              // server supports it, otherwise the legacy message window.
              supportsPagination
                ? { turnLimit }
                : historyWindow.messageWindowLimit === null
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
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
          // The WS fallback snapshot (sent when afterSequence is missing or the
          // gap is too large) is windowed the same way as the HTTP path; without
          // this a resume failure re-downloads the full thread. Never both
          // window parameters at once — the response would carry `page` and the
          // server would ignore `messageLimit`.
          ...(supportsPagination
            ? { turnLimit }
            : historyWindow.messageWindowLimit === null
              ? {}
              : { messageLimit: historyWindow.messageWindowLimit }),
        };
      }),
      {
        onExpectedFailure: (cause) => flushPending.pipe(Effect.andThen(setStreamError(cause))),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEach(acceptItem)),
    teardownScope,
  );

  // Expose the loader to UI actions through the request registry as well as the
  // atom handle. Requests funnel through a sliding queue drained serially, so
  // mashing "load earlier" coalesces (the loader itself no-ops while a fetch is
  // in flight).
  const olderTurnRequestRegistry = yield* ThreadOlderTurnRequests;
  const olderTurnRequests = yield* Queue.sliding<void>(1);
  yield* Stream.fromQueue(olderTurnRequests).pipe(
    Stream.runForEach(() => loadOlderHistory()),
    Effect.forkIn(teardownScope),
  );
  const deregister = olderTurnRequestRegistry.register(
    threadKey({ environmentId, threadId }),
    () => {
      Queue.offerUnsafe(olderTurnRequests, undefined);
    },
  );
  yield* Effect.addFinalizer(() => Effect.sync(deregister));

  // Teardown must not race the final persisted snapshot against a producer
  // that is still in flight. Mark teardown first so a manually invoked page
  // load cannot commit after its HTTP wait. `teardownScope` owns the stream,
  // watcher, refresh, persistence, timer, and deep-refill fibers; closing it
  // interrupts and awaits them. Only then do we take the mutation lock to
  // flush buffered items and persist the final published state.
  yield* Effect.addFinalizer(() =>
    Ref.set(tornDown, true).pipe(
      Effect.andThen(Scope.close(teardownScope, Exit.void)),
      Effect.andThen(
        mutationLock.withPermits(1)(
          Effect.gen(function* () {
            yield* flushPendingUnlocked();
            const [current, snapshotSequence] = yield* Effect.all([
              SubscriptionRef.get(state),
              SubscriptionRef.get(lastSequence),
            ]);
            yield* Option.match(current.data, {
              onNone: () => Effect.void,
              onSome: (thread) =>
                shouldPersistThread(thread)
                  ? persist({
                      snapshotSequence,
                      thread,
                      ...persistedPage(current.page, snapshotSequence),
                    })
                  : Effect.void,
            });
          }),
        ),
      ),
    ),
  );

  return {
    state,
    loadOlderMessages: (options?: ThreadLoadOlderHistoryOptions) =>
      loadOlderHistory({ automatic: options?.automatic === true }),
  } satisfies EnvironmentThreadStateHandle;
});

interface EnvironmentThreadStateEntry {
  readonly state: EnvironmentThreadState;
  readonly loadOlderMessages: (options?: ThreadLoadOlderHistoryOptions) => Effect.Effect<void>;
}

const EMPTY_ENVIRONMENT_THREAD_STATE_ENTRY: EnvironmentThreadStateEntry = {
  state: EMPTY_ENVIRONMENT_THREAD_STATE,
  loadOlderMessages: () => Effect.void,
};

function threadStateEntryChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentThreadState(threadId).pipe(
        Effect.map((handle) =>
          SubscriptionRef.changes(handle.state).pipe(
            Stream.map((state): EnvironmentThreadStateEntry => ({
              state,
              loadOlderMessages: handle.loadOlderMessages,
            })),
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
      .fn<ThreadLoadOlderHistoryOptions | undefined>()((input, get) =>
        get.result(entryAtom).pipe(Effect.flatMap((entry) => entry.loadOlderMessages(input))),
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
export * from "./threadFeedback.ts";
export * from "./threadDetail.ts";
export * from "./threadEventCoalescing.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
