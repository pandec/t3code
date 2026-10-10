// fork: continuation-compatible account switches (durable continuation groups)
// and their races with Stop, sends, feedback, native compaction and the
// replaced session's late exit.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Path from "effect/Path";
import * as Crypto from "effect/Crypto";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ClaudeAdapterV2 from "../Adapters/ClaudeAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Orchestrator from "../Orchestrator.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const DRIVER = ProviderDriverKind.make("claudeAgent");
const ACCOUNT_A: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude-account-a"),
  model: "claude-sonnet",
};
const ACCOUNT_B: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude-account-b"),
  model: "claude-sonnet",
};
const SHARED_KEY = "claudeAgent:home:/shared/.claude";

interface ActiveTurn {
  readonly input: ProviderAdapterV2TurnInput;
  readonly providerTurnId: ProviderTurnId;
  readonly events: SessionEvents;
}

type SessionEvents = Queue.Queue<ProviderAdapterV2Event, ProviderAdapterProtocolError | Cause.Done>;

/** One provider process: its event feed and a signal that its event stream was torn down. */
interface SessionHandle {
  readonly instanceId: ProviderInstanceId;
  readonly events: SessionEvents;
  readonly streamEnded: Deferred.Deferred<void>;
}

interface AdapterLog {
  readonly opened: ReadonlyArray<readonly [ProviderInstanceId, ProviderSessionId]>;
  readonly closed: ReadonlyArray<ProviderSessionId>;
  readonly ensured: ReadonlyArray<readonly [ProviderInstanceId, string]>;
  readonly resumed: ReadonlyArray<readonly [ProviderInstanceId, string]>;
  readonly started: ReadonlyArray<readonly [ProviderInstanceId, string, string]>;
  readonly interrupted: ReadonlyArray<ProviderInstanceId>;
  readonly compacted: ReadonlyArray<ProviderInstanceId>;
}

interface Harness {
  readonly log: Ref.Ref<AdapterLog>;
  /** Live continuation key per registered instance; a missing entry is a removed instance. */
  readonly instances: Ref.Ref<ReadonlyMap<ProviderInstanceId, string>>;
  readonly activeTurns: Ref.Ref<ReadonlyMap<string, ActiveTurn>>;
  readonly sessions: Ref.Ref<ReadonlyMap<ProviderSessionId, SessionHandle>>;
  /** Waits until the held turn with this prompt reached the provider. */
  readonly turnStarted: (text: string) => Effect.Effect<void>;
  readonly registryLayer: Layer.Layer<ProviderAdapterRegistry.ProviderAdapterRegistryV2>;
}

const append = <A>(items: ReadonlyArray<A>, item: A) => [...items, item];

/** Publishes the provider's terminal report for a held turn, possibly long after Stop. */
const completeTurn = (active: ActiveTurn, status: "completed" | "interrupted") =>
  Effect.gen(function* () {
    const at = yield* DateTime.now;
    const { input, providerTurnId } = active;
    yield* Queue.offerAll(active.events, [
      {
        type: "provider_turn.updated",
        driver: DRIVER,
        providerTurn: {
          id: providerTurnId,
          providerThreadId: input.providerThread.id,
          nodeId: input.rootNodeId,
          runAttemptId: input.attemptId,
          nativeTurnRef: {
            driver: DRIVER,
            nativeId: `native:${providerTurnId}`,
            strength: "strong",
          },
          ordinal: input.providerTurnOrdinal,
          status,
          startedAt: at,
          completedAt: at,
        },
      },
      {
        type: "turn_item.updated",
        driver: DRIVER,
        turnItem: {
          id: TurnItemId.make(`turn-item:${input.attemptId}:assistant`),
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
          providerThreadId: input.providerThread.id,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: input.runOrdinal * 100 + 1,
          status,
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "assistant_message",
          messageId: MessageId.make(`message:${input.attemptId}:assistant`),
          text: `reply to ${input.message.text}`,
          streaming: false,
        },
      },
      {
        type: "turn.terminal",
        driver: DRIVER,
        providerThreadId: input.providerThread.id,
        providerTurnId,
        runOrdinal: input.runOrdinal,
        status,
        failure: null,
        threadDisposition: "reusable",
      },
    ]);
  });

/**
 * Turns whose prompt is listed stay open until the test publishes their end.
 * `announce: false` holds the turn without reporting it running, like a native
 * compaction that hasn't reported its start yet.
 */
interface HeldTurn {
  readonly text: string;
  readonly announce?: boolean;
}

const makeHarness = (options: {
  readonly holds: ReadonlyArray<HeldTurn>;
  /** Reconfigures an instance while its thread start is still pending. */
  readonly rekeyDuringEnsure?: { readonly instanceId: ProviderInstanceId; readonly key: string };
}) =>
  Effect.gen(function* () {
    const log = yield* Ref.make<AdapterLog>({
      opened: [],
      closed: [],
      ensured: [],
      resumed: [],
      started: [],
      interrupted: [],
      compacted: [],
    });
    const instances = yield* Ref.make<ReadonlyMap<ProviderInstanceId, string>>(
      new Map([
        [ACCOUNT_A.instanceId, SHARED_KEY],
        [ACCOUNT_B.instanceId, SHARED_KEY],
      ]),
    );
    const activeTurns = yield* Ref.make<ReadonlyMap<string, ActiveTurn>>(new Map());
    const sessions = yield* Ref.make<ReadonlyMap<ProviderSessionId, SessionHandle>>(new Map());
    const startedSignals = new Map<string, Deferred.Deferred<void>>();
    for (const hold of options.holds) startedSignals.set(hold.text, yield* Deferred.make<void>());

    const makeAdapter = (instanceId: ProviderInstanceId): ProviderAdapterV2["Service"] => ({
      instanceId,
      driver: DRIVER,
      getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (sessionInput) =>
        Effect.gen(function* () {
          const sessionId = sessionInput.providerSessionId;
          const events = yield* Queue.unbounded<
            ProviderAdapterV2Event,
            ProviderAdapterProtocolError | Cause.Done
          >();
          const streamEnded = yield* Deferred.make<void>();
          yield* Ref.update(sessions, (current) =>
            new Map(current).set(sessionId, { instanceId, events, streamEnded }),
          );
          const now = yield* DateTime.now;
          yield* Ref.update(log, (current) => ({
            ...current,
            opened: append(current.opened, [instanceId, sessionId] as const),
          }));
          yield* Effect.addFinalizer(() =>
            Ref.update(log, (current) => ({
              ...current,
              closed: append(current.closed, sessionId),
            })),
          );
          const providerSession: OrchestrationV2ProviderSession = {
            id: sessionId,
            driver: DRIVER,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
            model: sessionInput.modelSelection.model,
            capabilities: ClaudeProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          };
          const start = (input: ProviderAdapterV2TurnInput) =>
            Effect.gen(function* () {
              const nativeId = input.providerThread.nativeThreadRef?.nativeId ?? "<none>";
              yield* Ref.update(log, (current) => ({
                ...current,
                started: append(current.started, [
                  instanceId,
                  nativeId,
                  input.message.text,
                ] as const),
              }));
              const active: ActiveTurn = {
                input,
                providerTurnId: ProviderTurnId.make(`provider-turn:${input.attemptId}`),
                events,
              };
              const started = startedSignals.get(input.message.text);
              if (started === undefined) return yield* completeTurn(active, "completed");
              yield* Ref.update(activeTurns, (current) =>
                new Map(current).set(input.message.text, active),
              );
              const announce =
                options.holds.find((hold) => hold.text === input.message.text)?.announce ?? true;
              if (!announce) return yield* Deferred.succeed(started, undefined);
              const at = yield* DateTime.now;
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver: DRIVER,
                providerTurn: {
                  id: active.providerTurnId,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: null,
                  ordinal: input.providerTurnOrdinal,
                  status: "running",
                  startedAt: at,
                  completedAt: null,
                },
              });
              yield* Deferred.succeed(started, undefined);
            });
          return {
            instanceId,
            driver: DRIVER,
            providerSessionId: sessionId,
            providerSession,
            events: Stream.fromQueue(events).pipe(
              Stream.ensuring(Deferred.succeed(streamEnded, undefined)),
            ),
            ensureThread: (threadInput) =>
              Effect.gen(function* () {
                const createdAt = yield* DateTime.now;
                const nativeId = `native:${threadInput.threadId}:${instanceId}`;
                yield* Ref.update(log, (current) => ({
                  ...current,
                  ensured: append(current.ensured, [instanceId, nativeId] as const),
                }));
                const rekey = options.rekeyDuringEnsure;
                if (rekey?.instanceId === instanceId) {
                  yield* Ref.update(instances, (current) =>
                    new Map(current).set(rekey.instanceId, rekey.key),
                  );
                }
                return {
                  id: ProviderThreadId.make(
                    `provider-thread:${threadInput.threadId}:${instanceId}`,
                  ),
                  driver: DRIVER,
                  providerInstanceId: instanceId,
                  providerSessionId: sessionId,
                  appThreadId: threadInput.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver: DRIVER, nativeId, strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt,
                  updatedAt: createdAt,
                } satisfies OrchestrationV2ProviderThread;
              }),
            resumeThread: ({ providerThread }) =>
              Ref.update(log, (current) => ({
                ...current,
                resumed: append(current.resumed, [
                  instanceId,
                  providerThread.nativeThreadRef?.nativeId ?? "<none>",
                ] as const),
              })).pipe(Effect.as(providerThread)),
            startTurn: start,
            compactThread: (input) =>
              Ref.update(log, (current) => ({
                ...current,
                compacted: append(current.compacted, instanceId),
              })).pipe(Effect.andThen(start(input))),
            steerTurn: () => Effect.void,
            // Stop is only a request: the provider reports the turn's end later.
            interruptTurn: () =>
              Ref.update(log, (current) => ({
                ...current,
                interrupted: append(current.interrupted, instanceId),
              })),
            respondToRuntimeRequest: () => Effect.void,
            uploadFeedback: () => Effect.succeed({ feedbackId: `feedback:${sessionId}` }),
            readThreadSnapshot: () =>
              Effect.fail(new ProviderAdapterProtocolError({ driver: DRIVER, detail: "unused" })),
            rollbackThread: () =>
              Effect.fail(new ProviderAdapterProtocolError({ driver: DRIVER, detail: "unused" })),
            forkThread: () =>
              Effect.fail(new ProviderAdapterProtocolError({ driver: DRIVER, detail: "unused" })),
          };
        }),
    });

    const adapters = [makeAdapter(ACCOUNT_A.instanceId), makeAdapter(ACCOUNT_B.instanceId)];
    const lookup = (instanceId: ProviderInstanceId) =>
      Effect.gen(function* () {
        const key = (yield* Ref.get(instances)).get(instanceId);
        const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
        if (key === undefined || adapter === undefined) {
          return yield* new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({
            instanceId,
          });
        }
        return { adapter, key };
      });
    const registryLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        get: (instanceId) => lookup(instanceId).pipe(Effect.map(({ adapter }) => adapter)),
        list: () => Ref.get(instances).pipe(Effect.map((current) => [...current.keys()])),
        getMetadata: (instanceId) =>
          lookup(instanceId).pipe(
            Effect.map(({ key }) => ({
              driver: DRIVER,
              continuationKey: key,
              enabled: true,
              capabilities: ClaudeProviderCapabilitiesV2,
            })),
          ),
      }),
    );
    return {
      log,
      instances,
      activeTurns,
      sessions,
      turnStarted: (text) => {
        const started = startedSignals.get(text);
        return started === undefined
          ? Effect.die(new Error(`turn "${text}" is not held`))
          : Deferred.await(started);
      },
      registryLayer,
    } satisfies Harness;
  });

const runWithOrchestrator = <A, E>(
  name: string,
  harness: Pick<Harness, "registryLayer">,
  body: Effect.Effect<
    A,
    E,
    | Orchestrator.OrchestratorV2
    | EffectWorker.OrchestrationEffectWorkerV2
    | ProviderSessionManager.ProviderSessionManagerV2
    | SqlClient.SqlClient
  >,
) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const databaseLayer = SqlitePersistence.layerMemory;
    return yield* body.pipe(
      Effect.provide(
        Layer.mergeAll(
          ProviderReplayHarness.layerWithRegistry(
            {
              name,
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: {
                  type: "readOnly",
                  access: { type: "fullAccess" },
                  networkAccess: false,
                },
              },
            },
            harness.registryLayer,
            { databaseLayer },
          ),
          databaseLayer,
        ),
      ),
    );
  });

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${threadId}:create`),
      threadId,
      projectId: ProjectId.make(`project:${threadId}`),
      title: "Account switch",
      modelSelection: ACCOUNT_A,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  });

const send = (
  threadId: ThreadId,
  text: string,
  modelSelection: ModelSelection,
  dispatchMode: { readonly type: "start_immediately" } | { readonly type: "queue_after_active" },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      modelSelection,
      dispatchMode,
    });
  });

/** Waits for the stored event matching `predicate` (replays history first, then tails). */
const waitForEvent = (predicate: (event: OrchestrationV2StoredEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.streamStoredEvents.pipe(Stream.filter(predicate), Stream.runHead);
  });

const runSettled = (threadId: ThreadId, ordinal: number) =>
  waitForEvent(
    ({ event }) =>
      event.type === "run.updated" &&
      event.threadId === threadId &&
      event.payload.ordinal === ordinal &&
      ["completed", "interrupted", "failed", "cancelled"].includes(event.payload.status),
  );

const runRunning = (threadId: ThreadId, ordinal: number) =>
  waitForEvent(
    ({ event }) =>
      event.type === "run.updated" &&
      event.threadId === threadId &&
      event.payload.ordinal === ordinal &&
      event.payload.status === "running",
  );

const nativeIdOf = (
  projection: { readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread> },
  providerThreadId: ProviderThreadId | null | undefined,
) =>
  projection.providerThreads.find((thread) => thread.id === providerThreadId)?.nativeThreadRef
    ?.nativeId ?? null;

/** Runs one completed turn on account A and returns its native conversation id. */
const firstTurnOnA = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* createThread(threadId);
    yield* send(threadId, "first", ACCOUNT_A, { type: "start_immediately" });
    yield* runSettled(threadId, 1);
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const nativeId = nativeIdOf(projection, projection.runs[0]?.providerThreadId);
    return nativeId ?? (yield* Effect.die(new Error("the first turn has no native thread")));
  });

/** The held turn's adapter-side handle, once it reached the provider. */
const heldTurn = (harness: Harness, text: string) =>
  Effect.gen(function* () {
    yield* harness.turnStarted(text);
    const active = (yield* Ref.get(harness.activeTurns)).get(text);
    return active ?? (yield* Effect.die(new Error(`turn "${text}" has no handle`)));
  });

const providerTurnRunning = (providerTurnId: ProviderTurnId) =>
  waitForEvent(
    ({ event }) =>
      event.type === "provider-turn.updated" &&
      event.payload.id === providerTurnId &&
      event.payload.status === "running",
  );

const sessionHandle = (harness: Harness, providerSessionId: ProviderSessionId) =>
  Effect.gen(function* () {
    const handle = (yield* Ref.get(harness.sessions)).get(providerSessionId);
    return handle ?? (yield* Effect.die(new Error(`no session ${providerSessionId}`)));
  });

describe("account switches keep native continuation only when provably compatible", () => {
  it.live("records the continuation group and resumes natively on a sibling account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ holds: [] });
        const threadId = ThreadId.make("thread:account-switch:compatible");
        const result = yield* runWithOrchestrator(
          "account-switch-compatible",
          harness,
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const sql = yield* SqlClient.SqlClient;
            const nativeA = yield* firstTurnOnA(threadId);
            yield* send(threadId, "second", ACCOUNT_B, { type: "start_immediately" });
            yield* runSettled(threadId, 2);
            return {
              nativeA,
              projection: yield* orchestrator.getThreadProjection(threadId),
              recorded: yield* sql<{
                readonly provider_instance_id: string;
                readonly native_thread_id: string;
                readonly continuation_key: string;
              }>`
                SELECT provider_instance_id, native_thread_id, continuation_key
                FROM fork_native_continuation ORDER BY provider_instance_id
              `,
            };
          }),
        );
        const log = yield* Ref.get(harness.log);
        assert.equal(result.nativeA, `native:${threadId}:${ACCOUNT_A.instanceId}`);
        assert.deepEqual(
          result.projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [ACCOUNT_A.instanceId, "completed"],
            [ACCOUNT_B.instanceId, "completed"],
          ],
        );
        assert.lengthOf(result.projection.contextHandoffs, 0);
        assert.deepEqual(log.resumed, [[ACCOUNT_B.instanceId, result.nativeA]]);
        assert.deepEqual(
          result.recorded.map((row) => [
            row.provider_instance_id,
            row.native_thread_id,
            row.continuation_key,
          ]),
          [
            [ACCOUNT_A.instanceId, result.nativeA, SHARED_KEY],
            [ACCOUNT_B.instanceId, result.nativeA, SHARED_KEY],
          ],
        );
      }),
    ),
  );

  it.live("hands off when the owner was reconfigured onto the target's account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ holds: [] });
        const threadId = ThreadId.make("thread:account-switch:drifted");
        const result = yield* runWithOrchestrator(
          "account-switch-drifted",
          harness,
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* Ref.set(
              harness.instances,
              new Map([
                [ACCOUNT_A.instanceId, "claudeAgent:home:/old/.claude"],
                [ACCOUNT_B.instanceId, SHARED_KEY],
              ]),
            );
            const nativeA = yield* firstTurnOnA(threadId);
            // A now shares B's config dir, but the conversation stayed in A's old one.
            yield* Ref.update(harness.instances, (current) =>
              new Map(current).set(ACCOUNT_A.instanceId, SHARED_KEY),
            );
            yield* send(threadId, "second", ACCOUNT_B, { type: "start_immediately" });
            yield* runSettled(threadId, 2);
            return { nativeA, projection: yield* orchestrator.getThreadProjection(threadId) };
          }),
        );
        const log = yield* Ref.get(harness.log);
        assert.lengthOf(result.projection.contextHandoffs, 1);
        assert.deepEqual(log.resumed, []);
        assert.deepEqual(
          log.started.map(([instanceId, nativeId]) => [instanceId, nativeId]),
          [
            [ACCOUNT_A.instanceId, result.nativeA],
            [ACCOUNT_B.instanceId, `native:${threadId}:${ACCOUNT_B.instanceId}`],
          ],
        );
      }),
    ),
  );

  it.live("records the key the owner's session opened with, not a later reconfiguration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A is moved onto B's account while its thread start is still pending;
        // the conversation was created in A's old config dir.
        const harness = yield* makeHarness({
          holds: [],
          rekeyDuringEnsure: { instanceId: ACCOUNT_A.instanceId, key: SHARED_KEY },
        });
        const threadId = ThreadId.make("thread:account-switch:rekeyed-during-attach");
        const result = yield* runWithOrchestrator(
          "account-switch-rekeyed-during-attach",
          harness,
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const sql = yield* SqlClient.SqlClient;
            yield* Ref.update(harness.instances, (current) =>
              new Map(current).set(ACCOUNT_A.instanceId, "claudeAgent:home:/old/.claude"),
            );
            const nativeA = yield* firstTurnOnA(threadId);
            yield* send(threadId, "second", ACCOUNT_B, { type: "start_immediately" });
            yield* runSettled(threadId, 2);
            return {
              nativeA,
              projection: yield* orchestrator.getThreadProjection(threadId),
              recorded: yield* sql<{ readonly continuation_key: string }>`
                SELECT continuation_key FROM fork_native_continuation
                WHERE provider_instance_id = ${ACCOUNT_A.instanceId}
                  AND native_thread_id = ${nativeA}
              `,
            };
          }),
        );
        const log = yield* Ref.get(harness.log);
        assert.deepEqual(
          result.recorded.map((row) => row.continuation_key),
          ["claudeAgent:home:/old/.claude"],
        );
        assert.lengthOf(result.projection.contextHandoffs, 1);
        assert.deepEqual(log.resumed, []);
      }),
    ),
  );

  it.live.each([
    { name: "recorded", recorded: true },
    { name: "unrecorded", recorded: false },
  ])("switches away from a removed owner ($name continuation group)", ({ name, recorded }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ holds: [] });
        const threadId = ThreadId.make(`thread:account-switch:removed-${name}`);
        const result = yield* runWithOrchestrator(
          `account-switch-removed-${name}`,
          harness,
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const sql = yield* SqlClient.SqlClient;
            const nativeA = yield* firstTurnOnA(threadId);
            // An unrecorded conversation predates the store (e.g. imported from v1).
            if (!recorded) yield* sql`DELETE FROM fork_native_continuation`;
            yield* Ref.update(harness.instances, (current) => {
              const next = new Map(current);
              next.delete(ACCOUNT_A.instanceId);
              return next;
            });
            yield* send(threadId, "second", ACCOUNT_B, { type: "start_immediately" });
            yield* runSettled(threadId, 2);
            return { nativeA, projection: yield* orchestrator.getThreadProjection(threadId) };
          }),
        );
        const log = yield* Ref.get(harness.log);
        assert.equal(result.projection.runs[1]?.status, "completed");
        if (recorded) {
          // The record still proves the removed owner shared B's config dir.
          assert.lengthOf(result.projection.contextHandoffs, 0);
          assert.deepEqual(log.resumed, [[ACCOUNT_B.instanceId, result.nativeA]]);
        } else {
          // Nothing can vouch for the conversation: fail closed to a handoff.
          assert.lengthOf(result.projection.contextHandoffs, 1);
          assert.deepEqual(log.resumed, []);
        }
      }),
    ),
  );
});

const stop = (threadId: ThreadId, runId: RunId, label: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`command:${threadId}:stop:${label}`),
      threadId,
      runId,
    });
  });

/**
 * Feedback as the `providerUploadFeedback` RPC resolves it: the active provider
 * thread's bound session, only while that runtime is live. It never opens one.
 */
const uploadFeedback = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === projection.thread.activeProviderThreadId,
    );
    const providerSessionId = providerThread?.providerSessionId ?? null;
    if (providerThread === undefined || providerSessionId === null) return "no session";
    const runtime = yield* sessions.get(providerSessionId);
    if (Option.isNone(runtime) || runtime.value.uploadFeedback === undefined) return "not running";
    const { feedbackId } = yield* runtime.value.uploadFeedback({ providerThread });
    return feedbackId;
  });

describe("account switch races (generation fencing, per-thread ownership, compaction)", () => {
  it.live.each([
    { name: "send then Stop", order: ["send", "stop"] as const },
    { name: "Stop then send", order: ["stop", "send"] as const },
  ])("a switching send, Stop and feedback racing a running turn: $name", ({ order }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ holds: [{ text: "first" }] });
        const threadId = ThreadId.make(`thread:account-switch:race:${order.join("-")}`);
        const result = yield* runWithOrchestrator(
          `account-switch-race-${order.join("-")}`,
          harness,
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* createThread(threadId);
            yield* send(threadId, "first", ACCOUNT_A, { type: "start_immediately" });
            const first = yield* heldTurn(harness, "first");
            yield* providerTurnRunning(first.providerTurnId);
            const sessionA = first.input.providerThread.providerSessionId;
            const feedback = [yield* uploadFeedback(threadId)];
            for (const step of order) {
              yield* step === "send"
                ? send(threadId, "follow-up", ACCOUNT_B, { type: "queue_after_active" })
                : stop(threadId, first.input.runId, "first");
              yield* worker.drain();
              feedback.push(yield* uploadFeedback(threadId));
            }
            // The provider never acknowledges Stop in time: Stop's follow-up
            // ends the run locally, so its late report reaches a released process.
            yield* completeTurn(first, "interrupted");
            yield* runSettled(threadId, 2);
            yield* worker.drain();
            feedback.push(yield* uploadFeedback(threadId));
            return {
              feedback,
              sessionA,
              projection: yield* orchestrator.getThreadProjection(threadId),
            };
          }),
        );
        const log = yield* Ref.get(harness.log);
        const nativeA = `native:${threadId}:${ACCOUNT_A.instanceId}`;
        assert.deepEqual(
          result.projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [ACCOUNT_A.instanceId, "interrupted"],
            [ACCOUNT_B.instanceId, "completed"],
          ],
        );
        assert.deepEqual(log.interrupted, [ACCOUNT_A.instanceId]);
        // One process per account (feedback never opened one), and B continued A's conversation.
        assert.deepEqual(
          log.opened.map(([instanceId]) => instanceId),
          [ACCOUNT_A.instanceId, ACCOUNT_B.instanceId],
        );
        assert.deepEqual(log.started, [
          [ACCOUNT_A.instanceId, nativeA, "first"],
          [ACCOUNT_B.instanceId, nativeA, "follow-up"],
        ]);
        assert.lengthOf(result.projection.contextHandoffs, 0);
        assert.include(log.closed, result.sessionA);
        // Feedback reaches A's live process until B's run replaces it: after
        // the queued send while A still runs, and after a Stop that ended A's
        // run but left its process; once both landed, B's.
        const sessionB = log.opened[1]![1];
        assert.deepEqual(result.feedback, [
          `feedback:${result.sessionA}`,
          `feedback:${result.sessionA}`,
          `feedback:${sessionB}`,
          `feedback:${sessionB}`,
        ]);
      }),
    ),
  );

  it.live(
    "classifies a queued switch against the conversation's owner after a selection change",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ holds: [{ text: "first" }] });
          const threadId = ThreadId.make("thread:account-switch:selection-first");
          const result = yield* runWithOrchestrator(
            "account-switch-selection-first",
            harness,
            Effect.gen(function* () {
              const orchestrator = yield* Orchestrator.OrchestratorV2;
              const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
              yield* createThread(threadId);
              yield* send(threadId, "first", ACCOUNT_A, { type: "start_immediately" });
              const first = yield* heldTurn(harness, "first");
              yield* providerTurnRunning(first.providerTurnId);
              yield* send(threadId, "follow-up", ACCOUNT_B, { type: "queue_after_active" });
              // The app thread moves to B while A's conversation is still running.
              yield* orchestrator.dispatch({
                type: "thread.model-selection.set",
                commandId: CommandId.make(`command:${threadId}:select-b`),
                threadId,
                modelSelection: ACCOUNT_B,
              });
              yield* worker.drain();
              yield* runSettled(threadId, 2);
              return yield* orchestrator.getThreadProjection(threadId);
            }),
          );
          const log = yield* Ref.get(harness.log);
          const nativeA = `native:${threadId}:${ACCOUNT_A.instanceId}`;
          // (v2 releases A's process on the selection command itself, which ends
          // the first run; that is upstream behavior and not asserted here.)
          assert.deepEqual(
            [result.runs[1]?.providerInstanceId, result.runs[1]?.status],
            [ACCOUNT_B.instanceId, "completed"],
          );
          assert.lengthOf(result.contextHandoffs, 0);
          assert.deepEqual(log.started.at(-1), [ACCOUNT_B.instanceId, nativeA, "follow-up"]);
        }),
      ),
  );

  it.live("ignores the replaced session's late completion and exit after a switch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ holds: [{ text: "second" }] });
        const threadId = ThreadId.make("thread:account-switch:late-exit");
        const result = yield* runWithOrchestrator(
          "account-switch-late-exit",
          harness,
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
            const nativeA = yield* firstTurnOnA(threadId);
            const afterFirst = yield* orchestrator.getThreadProjection(threadId);
            const sessionA = afterFirst.providerSessions[0]!.id;
            const firstTurn = afterFirst.providerTurns[0]!;
            yield* send(threadId, "second", ACCOUNT_B, { type: "start_immediately" });
            const second = yield* heldTurn(harness, "second");
            yield* providerTurnRunning(second.providerTurnId);
            yield* worker.drain();
            assert.include((yield* Ref.get(harness.log)).closed, sessionA);
            // The replaced process reports its last turn again, errors, and exits.
            const oldProcess = yield* sessionHandle(harness, sessionA);
            const now = yield* DateTime.now;
            yield* Queue.offerAll(oldProcess.events, [
              {
                type: "provider_turn.updated",
                driver: DRIVER,
                providerTurn: { ...firstTurn, status: "failed", completedAt: now },
              },
              {
                type: "turn.terminal",
                driver: DRIVER,
                providerThreadId: firstTurn.providerThreadId,
                providerTurnId: firstTurn.id,
                runOrdinal: 1,
                status: "failed",
                failureItemOrdinal: 199,
                failure: makeProviderFailure({
                  message: "process exited",
                  code: "process_exited",
                  class: "provider_error",
                }),
                threadDisposition: "reusable",
              },
              {
                type: "provider_session.updated",
                driver: DRIVER,
                providerSession: {
                  ...afterFirst.providerSessions[0]!,
                  status: "error",
                  lastError: "process exited",
                  updatedAt: now,
                },
              },
            ]);
            yield* Queue.fail(
              oldProcess.events,
              new ProviderAdapterProtocolError({ driver: DRIVER, detail: "process exited" }),
            );
            yield* Deferred.await(oldProcess.streamEnded);
            yield* completeTurn(second, "completed");
            yield* runSettled(threadId, 2);
            yield* worker.drain();
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const activeThread = projection.providerThreads.find(
              (thread) => thread.id === projection.thread.activeProviderThreadId,
            );
            return {
              nativeA,
              projection,
              activeThread,
              replacementLive: Option.isSome(
                yield* sessions.get(activeThread?.providerSessionId ?? sessionA),
              ),
            };
          }),
        );
        const { projection, activeThread } = result;
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [ACCOUNT_A.instanceId, "completed"],
            [ACCOUNT_B.instanceId, "completed"],
          ],
        );
        assert.deepEqual(
          projection.providerTurns.map((turn) => turn.status),
          ["completed", "completed"],
        );
        assert.equal(activeThread?.providerInstanceId, ACCOUNT_B.instanceId);
        assert.equal(activeThread?.nativeThreadRef?.nativeId, result.nativeA);
        assert.isTrue(result.replacementLive);
        assert.deepEqual(
          projection.providerSessions.map((session) => [
            session.providerInstanceId,
            session.status,
          ]),
          [[ACCOUNT_B.instanceId, "ready"]],
        );
      }),
    ),
  );

  it.live.each([
    { name: "before it reports running", announce: false },
    { name: "after it reports running", announce: true },
  ])("Stop and a switch during native compaction, completing late ($name)", ({ announce }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ holds: [{ text: "/compact", announce }] });
        const threadId = ThreadId.make(`thread:account-switch:compact:${announce}`);
        const result = yield* runWithOrchestrator(
          `account-switch-compact-${announce}`,
          harness,
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const nativeA = yield* firstTurnOnA(threadId);
            yield* send(threadId, "/compact", ACCOUNT_A, { type: "start_immediately" });
            const compaction = yield* heldTurn(harness, "/compact");
            if (announce) yield* providerTurnRunning(compaction.providerTurnId);
            const sessionA = compaction.input.providerThread.providerSessionId;
            yield* send(threadId, "after compaction", ACCOUNT_B, {
              type: "queue_after_active",
            });
            yield* stop(threadId, compaction.input.runId, "compact");
            yield* worker.drain();
            // Stop ends the compaction without the provider's report (at once when
            // unannounced, after Stop's settle wait when announced), and the switch
            // proceeds before the old process finishes compacting.
            yield* runSettled(threadId, 3);
            yield* completeTurn(compaction, "completed");
            const oldProcess = yield* sessionHandle(harness, sessionA!);
            yield* Queue.end(oldProcess.events);
            yield* Deferred.await(oldProcess.streamEnded);
            yield* worker.drain();
            return {
              nativeA,
              sessionA,
              projection: yield* orchestrator.getThreadProjection(threadId),
            };
          }),
        );
        const log = yield* Ref.get(harness.log);
        assert.deepEqual(log.compacted, [ACCOUNT_A.instanceId]);
        assert.deepEqual(log.interrupted, announce ? [ACCOUNT_A.instanceId] : []);
        assert.deepEqual(
          result.projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [ACCOUNT_A.instanceId, "completed"],
            [ACCOUNT_A.instanceId, "interrupted"],
            [ACCOUNT_B.instanceId, "completed"],
          ],
        );
        // The compacted conversation continues natively on B.
        assert.deepEqual(log.started.at(-1), [
          ACCOUNT_B.instanceId,
          result.nativeA,
          "after compaction",
        ]);
        assert.lengthOf(result.projection.contextHandoffs, 0);
        assert.include(log.closed, result.sessionA);
        assert.deepEqual(
          result.projection.providerSessions.map((session) => [
            session.providerInstanceId,
            session.status,
          ]),
          [[ACCOUNT_B.instanceId, "ready"]],
        );
      }),
    ),
  );
});

/**
 * Real Claude adapters for both accounts over a fake SDK. The first prompt is
 * held until the test answers it; later prompts are answered at once.
 */
const CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

const makeClaudeRegistry = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const opened: Array<{
    readonly instanceId: ProviderInstanceId;
    readonly options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;
  }> = [];
  const firstPrompt = yield* Deferred.make<Queue.Queue<SDKMessage>>();
  let prompts = 0;
  let sessions = 0;
  const result = (uuid: string) =>
    ({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "Done.",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      terminal_reason: "completed",
      uuid,
      session_id: "unused",
    }) as unknown as SDKMessage;
  const makeAdapter = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-account-switch-claude-",
      });
      return yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId,
        settings: CLAUDE_SETTINGS,
        environment: {},
        attachmentsDir,
        fileSystem,
        path,
        crypto,
        idAllocator,
        queryRunner: {
          allocateSessionId: Effect.sync(
            () => `00000000-0000-4000-8000-${String(++sessions).padStart(12, "0")}`,
          ),
          open: (input) =>
            Effect.gen(function* () {
              opened.push({ instanceId, options: input.options });
              const messages = yield* Queue.unbounded<SDKMessage>();
              return {
                messages: Stream.fromQueue(messages),
                offer: () =>
                  ++prompts === 1
                    ? Deferred.succeed(firstPrompt, messages).pipe(Effect.asVoid)
                    : Queue.offer(messages, result(`result-${prompts}`)).pipe(Effect.asVoid),
                setModel: () => Effect.void,
                setPermissionMode: () => Effect.void,
                interrupt: Effect.void,
                close: Queue.shutdown(messages),
              };
            }),
          forkSession: () => Effect.die("unused forkSession"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
    });
  const adapters = [
    yield* makeAdapter(ACCOUNT_A.instanceId),
    yield* makeAdapter(ACCOUNT_B.instanceId),
  ];
  const lookup = (
    instanceId: ProviderInstanceId,
  ): Effect.Effect<
    ProviderAdapterV2["Service"],
    ProviderAdapterRegistry.ProviderAdapterRegistryLookupError
  > => {
    const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
    return adapter === undefined
      ? Effect.fail(new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }))
      : Effect.succeed(adapter);
  };
  const registryLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: lookup,
      list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
      getMetadata: (instanceId) =>
        lookup(instanceId).pipe(
          Effect.map(() => ({
            driver: DRIVER,
            continuationKey: SHARED_KEY,
            enabled: true,
            capabilities: ClaudeProviderCapabilitiesV2,
          })),
        ),
    }),
  );
  return {
    registryLayer,
    opened,
    answerFirstPrompt: Deferred.await(firstPrompt).pipe(
      Effect.flatMap((messages) => Queue.offer(messages, result("result-1"))),
    ),
  };
});

describe("queued account switch through the Claude adapter", () => {
  it.live("resumes the adopted conversation instead of creating it again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const claude = yield* makeClaudeRegistry;
        const threadId = ThreadId.make("thread:account-switch:claude-queued");
        const nativeA = yield* runWithOrchestrator(
          "account-switch-claude-queued",
          claude,
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* createThread(threadId);
            yield* send(threadId, "first", ACCOUNT_A, { type: "start_immediately" });
            yield* runRunning(threadId, 1);
            yield* send(threadId, "follow-up", ACCOUNT_B, { type: "queue_after_active" });
            yield* claude.answerFirstPrompt;
            yield* runSettled(threadId, 2);
            const projection = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(
              projection.runs.map((run) => [run.providerInstanceId, run.status]),
              [
                [ACCOUNT_A.instanceId, "completed"],
                [ACCOUNT_B.instanceId, "completed"],
              ],
            );
            assert.lengthOf(projection.contextHandoffs, 0);
            return nativeIdOf(projection, projection.runs[0]?.providerThreadId);
          }),
        );
        assert.isNotNull(nativeA);
        assert.deepEqual(
          claude.opened.map(({ instanceId, options }) => [
            instanceId,
            options.resume,
            options.sessionId,
          ]),
          [
            [ACCOUNT_A.instanceId, undefined, nativeA],
            [ACCOUNT_B.instanceId, nativeA, undefined],
          ],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});
