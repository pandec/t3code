// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  EnvironmentHttpApi,
  EnvironmentId,
  EnvironmentResourceNotFoundError,
  type ExecutionEnvironmentDescriptor,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ScheduleThreadArchiveInput,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2RpcSchemas,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadArchiveError,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationV2ThreadShell,
  CommandId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";

import * as ServerConfig from "../config.ts";
import {
  selectHistoryPageFromCursor,
  selectRecentTimelineWindow,
} from "../orchestration-v2/threadHistoryPaging.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { settingsHttpApiLayer } from "../settingsHttp.ts";
import {
  captureStdout,
  makeConfig,
  makeTestAuthLayer,
  makeTestThreadShell,
  parseJson,
} from "./liveServerTestKit.ts";

const now = DateTime.makeUnsafe("2026-10-04T10:00:00.000Z");
const projectId = ProjectId.make("project-thread-cli");
const activeThreadId = ThreadId.make("thread-active");
const archivedThreadId = ThreadId.make("thread-archived");
const unpinnedThreadId = ThreadId.make("thread-unpinned");
const waitThreadId = ThreadId.make("thread-wait");
const waitRunId = RunId.make("run-wait");
/** The bounded snapshot read of this thread fails with an undeclared error. */
const brokenThreadId = ThreadId.make("thread-broken");
const questionRequestId = RuntimeRequestId.make("request-question");
const approvalRequestId = RuntimeRequestId.make("request-approval");

// The orchestration RPCs the thread CLI calls, as the server declares
// them; requests travel by tag, so the CLI's full WsRpcGroup client talks to it.
const ThreadCliRpcGroup = RpcGroup.make(
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
    payload: OrchestrationV2RpcSchemas.dispatchCommand.input,
    success: OrchestrationV2RpcSchemas.dispatchCommand.output,
    error: Schema.Union([OrchestrationV2DispatchCommandError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.launchThread, {
    payload: OrchestrationV2RpcSchemas.launchThread.input,
    success: OrchestrationV2RpcSchemas.launchThread.output,
    error: Schema.Union([OrchestrationV2ThreadLaunchError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.scheduleThreadArchive, {
    payload: OrchestrationV2RpcSchemas.scheduleThreadArchive.input,
    success: OrchestrationV2RpcSchemas.scheduleThreadArchive.output,
    error: Schema.Union([OrchestrationV2ThreadArchiveError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.cancelThreadArchive, {
    payload: OrchestrationV2RpcSchemas.cancelThreadArchive.input,
    success: OrchestrationV2RpcSchemas.cancelThreadArchive.output,
    error: Schema.Union([OrchestrationV2ThreadArchiveError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
    payload: OrchestrationV2RpcSchemas.getThreadProjection.input,
    success: OrchestrationV2RpcSchemas.getThreadProjection.output,
    error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {
    payload: OrchestrationV2RpcSchemas.subscribeShell.input,
    success: OrchestrationV2RpcSchemas.subscribeShell.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  }),
);

class ThreadCliHttpApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.orchestration)
  .add(EnvironmentHttpApi.groups.settings) {}

interface ServerRecord {
  readonly commands: Array<OrchestrationV2Command>;
  readonly launches: Array<OrchestrationV2ThreadLaunchInput>;
  readonly archiveSchedules: Array<OrchestrationV2ScheduleThreadArchiveInput>;
}

/** The archive scheduler refuses a worktree removal for this thread. */
const blockedWorktreeThreadId = unpinnedThreadId;
/** The archive scheduler commits, then fails its status read (an undeclared defect). */
const archiveReadFailsThreadId = ThreadId.make("thread-archive-read-fails");
const archivedRunId = RunId.make("run-archived");

/**
 * Runs `run` against a minimal live server: HTTP shell, descriptor, settings
 * and WebSocket-ticket routes, plus the orchestration RPCs on `/ws`, which
 * record what the CLI sent.
 */
const withThreadServer = <A, E, R>(
  baseDir: string,
  input: {
    readonly project: OrchestrationProjectShell;
    readonly rejectCommandType?: OrchestrationV2Command["type"];
    readonly extraThreads?: ReadonlyArray<OrchestrationV2ThreadShell>;
    /** Streamed after the shell subscription's snapshot. */
    readonly shellUpdates?: ReadonlyArray<OrchestrationV2ShellStreamItem>;
    readonly projection?: OrchestrationV2ThreadProjection;
    /** Timeline served for `archivedThreadId` by the bounded snapshot and history routes. */
    readonly timeline?: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  },
  run: (record: Ref.Ref<ServerRecord>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const config = yield* makeConfig(baseDir);
    const record = yield* Ref.make<ServerRecord>({
      commands: [],
      launches: [],
      archiveSchedules: [],
    });
    const descriptor: ExecutionEnvironmentDescriptor = {
      environmentId: EnvironmentId.make("thread-cli-live-test"),
      label: "Thread CLI test",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadPinning: true,
        threadPinReorder: true,
        threadCustomGroups: true,
        threadCustomGroupCreation: true,
      },
    };
    const activeThreads = [
      makeTestThreadShell(activeThreadId, {
        pinnedAt: now,
        pinOrderKey: "m",
      }),
      makeTestThreadShell(unpinnedThreadId),
      ...(input.extraThreads ?? []),
    ];
    const shellFor = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) => ({
      schemaVersion: 1,
      snapshotSequence: 11,
      projects: [input.project],
      threads,
      archivedThreads: [],
    });
    const unused = Effect.die("unused");
    const timelineFor = (threadId: ThreadId) =>
      threadId === archivedThreadId ? (input.timeline ?? []) : null;
    const threadNotFound = Effect.fail(
      new EnvironmentResourceNotFoundError({
        code: "not_found",
        reason: "thread_not_found",
        traceId: "thread-cli-live-test",
      }),
    );
    const httpLayer = Layer.mergeAll(
      HttpApiBuilder.group(EnvironmentHttpApi, "metadata", (handlers) =>
        handlers.handle("descriptor", () => Effect.succeed(descriptor)),
      ),
      HttpApiBuilder.group(EnvironmentHttpApi, "orchestration", (handlers) =>
        handlers
          .handle("shellSnapshot", () => Effect.succeed(shellFor(activeThreads)))
          .handle("threadSnapshot", () => unused)
          .handle("threadBoundedSnapshot", ({ params }) => {
            const projection = input.projection;
            if (projection !== undefined && params.threadId === projection.thread.id) {
              // The questions sit before the newest window: only paging finds them.
              return Effect.succeed({
                snapshotSequence: 11,
                projection: { ...projection, turnItems: [], visibleTurnItems: [] },
                historyCursor: "cursor-before-window",
                hasMoreHistory: true,
                latestLocalTurnOrdinal: null,
              });
            }
            if (params.threadId === brokenThreadId) return unused;
            const items = timelineFor(params.threadId);
            if (items === null) return threadNotFound;
            const window = selectRecentTimelineWindow({ items, snapshotSequence: 11 });
            const archived = emptyProjection(params.threadId, "Archived");
            return Effect.succeed({
              snapshotSequence: 11,
              projection: {
                ...archived,
                thread: {
                  ...archived.thread,
                  archivedAt: now,
                  archiveRequest: {
                    requestId: CommandId.make("archive-request"),
                    runId: archivedRunId,
                    worktreePath: null,
                    requestedAt: "2026-10-04T09:30:00.000Z",
                    status: "completed" as const,
                  },
                },
                visibleTurnItems: window.items,
              },
              historyCursor: window.nextCursor,
              hasMoreHistory: window.hasMoreHistory,
              latestLocalTurnOrdinal: null,
            });
          })
          .handle("threadHistoryPage", ({ params, query }) => {
            const projection = input.projection;
            if (projection !== undefined && params.threadId === projection.thread.id) {
              return Effect.succeed({
                snapshotSequence: 11,
                items: projection.turnItems.map((item, position) => ({
                  position,
                  visibility: "local" as const,
                  sourceThreadId: item.threadId,
                  sourceItemId: item.id,
                  item,
                })),
                nextCursor: null,
                hasMoreHistory: false,
              });
            }
            const items = timelineFor(params.threadId);
            if (items === null) return threadNotFound;
            return Effect.succeed({
              snapshotSequence: 11,
              ...selectHistoryPageFromCursor({ items, cursor: query.cursor, snapshotSequence: 11 }),
            });
          }),
      ),
      HttpApiBuilder.group(EnvironmentHttpApi, "auth", (handlers) =>
        handlers
          .handle("webSocketTicket", () =>
            Effect.succeed({ ticket: "thread-cli-ticket", expiresAt: now }),
          )
          .handle("session", () => unused)
          .handle("browserSession", () => unused)
          .handle("token", () => unused)
          .handle("pairingCredential", () => unused)
          .handle("pairingLinks", () => unused)
          .handle("revokePairingLink", () => unused)
          .handle("clients", () => unused)
          .handle("revokeClient", () => unused)
          .handle("revokeOtherClients", () => unused),
      ),
      settingsHttpApiLayer,
    );
    const rpcHandlers = ThreadCliRpcGroup.toLayer({
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(record, (current) => ({
            ...current,
            commands: [...current.commands, command],
          }));
          if (command.type === input.rejectCommandType) {
            return yield* new OrchestrationV2DispatchCommandError({
              commandId: command.commandId,
              commandType: command.type,
              message: "Failed to dispatch orchestration V2 command",
              detail: "Thread is busy.",
            });
          }
          return { sequence: 42 };
        }),
      [ORCHESTRATION_V2_WS_METHODS.launchThread]: (launch) =>
        Effect.gen(function* () {
          yield* Ref.update(record, (current) => ({
            ...current,
            launches: [...current.launches, launch],
          }));
          return launchResult(launch);
        }),
      [ORCHESTRATION_V2_WS_METHODS.scheduleThreadArchive]: (schedule) =>
        Effect.gen(function* () {
          yield* Ref.update(record, (current) => ({
            ...current,
            archiveSchedules: [...current.archiveSchedules, schedule],
          }));
          if (schedule.threadId === archiveReadFailsThreadId) {
            return yield* Effect.die(new Error("status read failed after dispatch"));
          }
          if (schedule.removeWorktree === true && schedule.threadId === blockedWorktreeThreadId) {
            return yield* new OrchestrationV2ThreadArchiveError({
              threadId: schedule.threadId,
              message: "The thread's worktree is detached.",
            });
          }
          // Idle test threads archive at once.
          return {
            archivedAt: now,
            request: {
              requestId: schedule.commandId ?? CommandId.make("server-archive"),
              runId: null,
              worktreePath: null,
              requestedAt: "2026-10-04T10:00:00.000Z",
              status: "completed" as const,
            },
          };
        }),
      [ORCHESTRATION_V2_WS_METHODS.cancelThreadArchive]: () =>
        Effect.succeed({ archivedAt: null, request: null }),
      [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: ({ threadId }) =>
        input.projection === undefined
          ? Effect.fail(
              new OrchestrationV2GetThreadProjectionError({
                threadId,
                message: "Failed to load the thread projection.",
              }),
            )
          : Effect.succeed(input.projection),
      [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
        Stream.fromEffect(
          Ref.get(record).pipe(
            Effect.map((current) => ({
              kind: "snapshot" as const,
              snapshot: {
                ...shellFor([
                  ...activeThreads,
                  ...current.launches.map((launch) =>
                    makeTestThreadShell(launch.threadId ?? ThreadId.make("unknown"), {
                      title: launch.title,
                      ...(launch.customGroupId == null
                        ? {}
                        : { customGroupId: launch.customGroupId }),
                      status: "preparing",
                    }),
                  ),
                ]),
                snapshotSequence: 12,
              },
            })),
          ),
        ).pipe(
          Stream.concat(
            Stream.fromIterable<OrchestrationV2ShellStreamItem>(input.shellUpdates ?? []),
          ),
        ),
    });
    const routesLayer = Layer.mergeAll(
      HttpApiBuilder.layer(ThreadCliHttpApi).pipe(
        Layer.provide(httpLayer),
        Layer.provide(makeTestAuthLayer("thread-cli-live-test")),
      ),
      RpcServer.layerHttp({ group: ThreadCliRpcGroup, path: "/ws", protocol: "websocket" }).pipe(
        Layer.provide(rpcHandlers),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    const appLayer = HttpRouter.serve(routesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(
        ServerSettingsModule.layerTest({
          threadGroups: [
            {
              id: "group-inbox",
              name: "📨 Inbox",
              orderKey: "a",
              revision: "0000000000000001:edit",
              deleted: false,
            },
          ],
        }),
      ),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, "None")),
    );

    return yield* Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address)) {
        return assert.fail(`Expected a TCP address, got ${String(address)}`);
      }
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        state: yield* makePersistedServerRuntimeState({ config, port: address.port }),
      });
      return yield* run(record);
    }).pipe(Effect.provide(appLayer), Effect.scoped);
  });

const emptyProjection = (threadId: ThreadId, title: string): OrchestrationV2ThreadProjection => {
  const { pendingRuntimeRequest: _pending, ...thread } = makeTestThreadShell(threadId);
  return {
    thread: { ...thread, title, lastVisitedAt: null },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  };
};

const launchResult = (launch: OrchestrationV2ThreadLaunchInput) => {
  const threadId = launch.threadId ?? ThreadId.make("unknown");
  return { threadId, resumed: false, projection: emptyProjection(threadId, launch.title) };
};

/** A thread projection with one pending question and one pending approval. */
const questionProjection = (threadId: ThreadId): OrchestrationV2ThreadProjection => {
  const base = emptyProjection(threadId, "Questions");
  const questionNodeId = NodeId.make("node-question");
  const pending = {
    providerTurnId: null,
    nativeRequestRef: null,
    status: "pending" as const,
    responseCapability: {
      type: "live" as const,
      providerSessionId: ProviderSessionId.make("session-live"),
    },
    createdAt: now,
    resolvedAt: null,
  };
  return {
    ...base,
    runtimeRequests: [
      { ...pending, id: questionRequestId, nodeId: questionNodeId, kind: "user_input" },
      { ...pending, id: approvalRequestId, nodeId: NodeId.make("node-approval"), kind: "command" },
    ],
    turnItems: [
      {
        id: TurnItemId.make("item-question"),
        threadId,
        runId: null,
        nodeId: questionNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "user_input_request",
        requestId: questionRequestId,
        questions: [
          {
            id: "ship",
            header: "Ship",
            question: "Ship it?",
            options: [{ label: "Yes", description: "Ship now", value: "yes" }],
          },
        ],
      },
    ],
  };
};

const makeDirs = (label: string) => ({
  baseDir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-thread-live-${label}-`)),
  workspaceRoot: NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), `t3-thread-live-${label}-workspace-`),
  ),
});

const makeProject = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: projectId,
  title: "Thread CLI",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-04T09:00:00.000Z",
  updatedAt: "2026-10-04T09:00:00.000Z",
});

it.layer(NodeServices.layer)("thread CLI against a running server", (it) => {
  it.effect("sends to an archived thread as a user message the server resolves", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("send");
      yield* withThreadServer(baseDir, { project: makeProject(workspaceRoot) }, (record) =>
        Effect.gen(function* () {
          const output = parseJson<{
            readonly threadId: string;
            readonly sequence: number;
            readonly action: string;
          }>(
            yield* captureStdout([
              "thread",
              "send",
              archivedThreadId,
              "--message",
              "  pick this back up  ",
              "--json",
              "--base-dir",
              baseDir,
            ]),
          );
          assert.deepEqual(
            { threadId: output.threadId, sequence: output.sequence, action: output.action },
            { threadId: archivedThreadId, sequence: 42, action: "started" },
          );
          const [command] = (yield* Ref.get(record)).commands;
          assert.strictEqual(command?.type, "message.dispatch");
          if (command?.type !== "message.dispatch") return;
          assert.deepEqual(
            {
              threadId: command.threadId,
              text: command.text,
              createdBy: command.createdBy,
              deliveryIntent: command.deliveryIntent,
              dispatchMode: command.dispatchMode,
            },
            {
              threadId: archivedThreadId,
              text: "pick this back up",
              createdBy: "user",
              deliveryIntent: "auto",
              dispatchMode: { type: "start_immediately" },
            },
          );
        }),
      );
    }),
  );

  it.effect(
    "reads one archived thread, not the archive, and never dispatches on a failed read",
    () =>
      Effect.gen(function* () {
        const { baseDir, workspaceRoot } = makeDirs("archived-read");
        yield* withThreadServer(baseDir, { project: makeProject(workspaceRoot) }, (record) =>
          Effect.gen(function* () {
            const status = parseJson<{
              readonly archivedAt: string | null;
              readonly archiveRequest: {
                readonly turnId: string | null;
                readonly removeWorktree: boolean;
                readonly status: string;
              } | null;
            }>(
              yield* captureStdout([
                "thread",
                "archive",
                archivedThreadId,
                "--status",
                "--json",
                "--base-dir",
                baseDir,
              ]),
            );
            assert.strictEqual(status.archivedAt, "2026-10-04T10:00:00.000Z");
            assert.deepEqual(
              status.archiveRequest && {
                turnId: status.archiveRequest.turnId,
                removeWorktree: status.archiveRequest.removeWorktree,
                status: status.archiveRequest.status,
              },
              { turnId: archivedRunId, removeWorktree: false, status: "completed" },
            );

            const send = (threadId: string) =>
              captureStdout([
                "thread",
                "send",
                threadId,
                "--message",
                "hello",
                "--json",
                "--base-dir",
                baseDir,
              ]).pipe(
                Effect.map((output) =>
                  parseJson<{
                    readonly error: { readonly code: string; readonly outcome?: string };
                  }>(output),
                ),
              );
            const missing = yield* send("thread-missing");
            assert.strictEqual(missing.error.code, "ThreadCliNotFoundError");
            const broken = yield* send(brokenThreadId);
            assert.notStrictEqual(broken.error.code, "CliOrchestrationOutcomeUnknownError");
            assert.notProperty(broken.error, "outcome");
            assert.lengthOf((yield* Ref.get(record)).commands, 0);
          }),
        );
      }),
  );

  it.effect("schedules archives through the archive scheduler and surfaces its refusal", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("archive");
      yield* withThreadServer(
        baseDir,
        {
          project: makeProject(workspaceRoot),
          extraThreads: [makeTestThreadShell(archiveReadFailsThreadId)],
        },
        (record) =>
          Effect.gen(function* () {
            const archive = (threadId: string, ...flags: ReadonlyArray<string>) =>
              captureStdout([
                "thread",
                "archive",
                threadId,
                ...flags,
                "--json",
                "--base-dir",
                baseDir,
              ]).pipe(Effect.map((output) => parseJson<Record<string, unknown>>(output)));
            const refused = yield* archive(blockedWorktreeThreadId, "--remove-worktree");
            const refusal = refused.error as { readonly code: string; readonly message: string };
            assert.deepEqual(
              { code: refusal.code, message: refusal.message },
              {
                code: "CliOrchestrationCommandRejectedError",
                message: "The thread's worktree is detached.",
              },
            );
            assert.notProperty(refusal, "outcome");
            const unknown = (yield* archive(archiveReadFailsThreadId, "--after-turn")).error as {
              readonly code: string;
              readonly outcome?: string;
            };
            assert.deepEqual(
              { code: unknown.code, outcome: unknown.outcome },
              { code: "CliOrchestrationOutcomeUnknownError", outcome: "unknown" },
            );
            const archived = yield* archive(activeThreadId, "--after-turn");
            const [refusedSchedule, , schedule] = (yield* Ref.get(record)).archiveSchedules;
            assert.deepEqual(
              {
                threadId: refusedSchedule?.threadId,
                removeWorktree: refusedSchedule?.removeWorktree,
              },
              { threadId: blockedWorktreeThreadId, removeWorktree: true },
            );
            assert.deepEqual(archived, {
              threadId: activeThreadId,
              action: "archived",
              requestId: schedule?.commandId,
            });
            assert.deepEqual(
              { afterTurn: schedule?.afterTurn, removeWorktree: schedule?.removeWorktree },
              { afterTurn: true, removeWorktree: undefined },
            );
            // Neither went through a raw thread.archive.schedule command.
            assert.lengthOf((yield* Ref.get(record)).commands, 0);
          }),
      );
    }),
  );

  it.effect("interrupts the active run and holds its queued follow-ups", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("interrupt");
      const runningThread = makeTestThreadShell(waitThreadId, {
        status: "running",
        activeRunId: waitRunId,
        latestRunId: waitRunId,
        activityRunStatus: "running",
      });
      yield* withThreadServer(
        baseDir,
        { project: makeProject(workspaceRoot), extraThreads: [runningThread] },
        (record) =>
          Effect.gen(function* () {
            const output = parseJson<{ readonly action: string }>(
              yield* captureStdout([
                "thread",
                "interrupt",
                waitThreadId,
                "--json",
                "--base-dir",
                baseDir,
              ]),
            );
            assert.strictEqual(output.action, "interrupt-requested");
            const [command] = (yield* Ref.get(record)).commands;
            assert.strictEqual(command?.type, "run.interrupt");
            if (command?.type !== "run.interrupt") return;
            assert.deepEqual(
              { threadId: command.threadId, runId: command.runId, holdQueue: command.holdQueue },
              { threadId: waitThreadId, runId: waitRunId, holdQueue: true },
            );
          }),
      );
    }),
  );

  it.effect("reports a message-mode question as not blocking in status and list", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("message-mode");
      const asking = makeTestThreadShell(waitThreadId, {
        status: "completed",
        latestRunId: waitRunId,
        pendingRuntimeRequest: { id: questionRequestId, kind: "user_input", createdAt: now },
      });
      const projection = questionProjection(waitThreadId);
      yield* withThreadServer(
        baseDir,
        {
          project: makeProject(workspaceRoot),
          extraThreads: [asking],
          projection: {
            ...projection,
            runtimeRequests: projection.runtimeRequests.map((request) => ({
              ...request,
              responseCapability: { type: "message" as const },
            })),
          },
        },
        () =>
          Effect.gen(function* () {
            const status = parseJson<{ readonly hasPendingBlockingUserInput: boolean }>(
              yield* captureStdout([
                "thread",
                "status",
                waitThreadId,
                "--json",
                "--base-dir",
                baseDir,
              ]),
            );
            assert.isFalse(status.hasPendingBlockingUserInput);
            const listed = parseJson<{
              readonly threads: ReadonlyArray<{
                readonly id: string;
                readonly hasPendingUserInput: boolean;
                readonly hasPendingBlockingUserInput: boolean;
              }>;
            }>(yield* captureStdout(["thread", "list", "--json", "--base-dir", baseDir]));
            const entry = listed.threads.find((thread) => thread.id === waitThreadId);
            assert.deepEqual(
              entry && {
                pending: entry.hasPendingUserInput,
                blocking: entry.hasPendingBlockingUserInput,
              },
              { pending: true, blocking: false },
            );
          }),
      );
    }),
  );

  it.effect("reports a failed projection read as a request error, not an unknown outcome", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("read-error");
      yield* withThreadServer(baseDir, { project: makeProject(workspaceRoot) }, (record) =>
        Effect.gen(function* () {
          const output = parseJson<{
            readonly error: { readonly code: string; readonly outcome?: string };
          }>(
            yield* captureStdout([
              "thread",
              "input",
              "respond",
              activeThreadId,
              questionRequestId,
              "--answers-json",
              '{"ship":"yes"}',
              "--json",
              "--base-dir",
              baseDir,
            ]),
          );
          assert.strictEqual(output.error.code, "CliOrchestrationRequestError");
          assert.notProperty(output.error, "outcome");
          assert.lengthOf((yield* Ref.get(record)).commands, 0);
        }),
      );
    }),
  );

  it.effect("pages an archived thread's transcript with reasoning over the history routes", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("messages");
      // 12 turns exceed the 10-turn bounded window, so the read pages once.
      const timeline = Array.from({ length: 12 }, (_, index) => {
        const turn = index + 1;
        const base = {
          threadId: archivedThreadId,
          runId: RunId.make(`run-${turn}`),
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed" as const,
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        };
        return [
          {
            ...base,
            id: TurnItemId.make(`user-${turn}`),
            type: "user_message" as const,
            createdBy: "user" as const,
            creationSource: "web" as const,
            messageId: MessageId.make(`message-${turn}`),
            inputIntent: "turn_start" as const,
            text: `question ${turn}`,
            attachments: [],
          },
          {
            ...base,
            id: TurnItemId.make(`reasoning-${turn}`),
            type: "reasoning" as const,
            text: `thinking ${turn}`,
            streaming: false,
          },
        ];
      })
        .flat()
        .map((item, position) => ({
          position,
          visibility: "local" as const,
          sourceThreadId: archivedThreadId,
          sourceItemId: item.id,
          item,
        }));
      yield* withThreadServer(baseDir, { project: makeProject(workspaceRoot), timeline }, () =>
        Effect.gen(function* () {
          const output = parseJson<{
            readonly archived: boolean;
            readonly machine: { readonly environmentLabel: string | null };
            readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
            readonly hasMoreOlder: boolean;
          }>(
            yield* captureStdout([
              "thread",
              "messages",
              archivedThreadId,
              "--role",
              "reasoning",
              "--json",
              "--base-dir",
              baseDir,
            ]),
          );
          assert.isTrue(output.archived);
          assert.strictEqual(output.machine.environmentLabel, "Thread CLI test");
          assert.deepEqual(
            output.messages.map((message) => message.text),
            Array.from({ length: 12 }, (_, index) => `thinking ${index + 1}`),
          );
          assert.isFalse(output.hasMoreOlder);

          const missing = parseJson<{ readonly error: { readonly code: string } }>(
            yield* captureStdout([
              "thread",
              "messages",
              "thread-missing",
              "--json",
              "--base-dir",
              baseDir,
            ]),
          );
          assert.strictEqual(missing.error.code, "CliOrchestrationThreadNotFoundError");
        }),
      );
    }),
  );

  it.effect("reports a declared rejection without an unknown outcome", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("reject");
      yield* withThreadServer(
        baseDir,
        { project: makeProject(workspaceRoot), rejectCommandType: "thread.unpin" },
        (record) =>
          Effect.gen(function* () {
            const output = parseJson<{
              readonly error: { readonly code: string; readonly message: string };
            }>(
              yield* captureStdout([
                "thread",
                "unpin",
                activeThreadId,
                "--json",
                "--base-dir",
                baseDir,
              ]),
            );
            assert.deepEqual(output.error.code, "CliOrchestrationCommandRejectedError");
            assert.strictEqual(output.error.message, "Thread is busy.");
            assert.notProperty(output.error, "outcome");
            assert.strictEqual((yield* Ref.get(record)).commands[0]?.type, "thread.unpin");
          }),
      );
    }),
  );

  it.effect("launches a grouped thread in the checkout and reports the shell sequence", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("new");
      yield* withThreadServer(baseDir, { project: makeProject(workspaceRoot) }, (record) =>
        Effect.gen(function* () {
          const output = parseJson<{
            readonly threadId: string;
            readonly createCommandId: string;
            readonly commandId: string;
            readonly sequence: number;
            readonly group: { readonly id: string; readonly name: string } | null;
            readonly workspace: { readonly mode: string };
          }>(
            yield* captureStdout([
              "thread",
              "new",
              "--project",
              projectId,
              "--message",
              "Inspect the failing tests",
              "--group",
              "Inbox",
              "--checkout",
              "--json",
              "--base-dir",
              baseDir,
            ]),
          );
          const [launch] = (yield* Ref.get(record)).launches;
          assert.isDefined(launch);
          if (launch === undefined) return;
          assert.deepEqual(
            {
              threadId: launch.threadId,
              projectId: launch.projectId,
              title: launch.title,
              generateTitle: launch.generateTitle,
              customGroupId: launch.customGroupId,
              workspaceStrategy: launch.workspaceStrategy,
              text: launch.initialMessage?.text,
            },
            {
              threadId: ThreadId.make(output.threadId),
              projectId,
              title: "Inspect the failing tests",
              generateTitle: true,
              customGroupId: "group-inbox",
              workspaceStrategy: { type: "root" },
              text: "Inspect the failing tests",
            },
          );
          assert.strictEqual(output.createCommandId, launch.commandId);
          assert.strictEqual(output.commandId, `${launch.commandId}:initial-message`);
          assert.strictEqual(output.sequence, 12);
          assert.deepEqual(output.group, { id: "group-inbox", name: "📨 Inbox" });
          assert.strictEqual(output.workspace.mode, "checkout");
        }),
      );
    }),
  );

  it.effect("pins above the arranged pinned run and skips a no-op pin", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("pin");
      yield* withThreadServer(baseDir, { project: makeProject(workspaceRoot) }, (record) =>
        Effect.gen(function* () {
          const pin = (threadId: ThreadId) =>
            captureStdout(["thread", "pin", threadId, "--json", "--base-dir", baseDir]).pipe(
              Effect.map((output) => parseJson<{ readonly action: string }>(output).action),
            );
          assert.strictEqual(yield* pin(activeThreadId), "unchanged");
          assert.strictEqual(yield* pin(unpinnedThreadId), "pinned");
          const commands = (yield* Ref.get(record)).commands;
          assert.lengthOf(commands, 1);
          const [command] = commands;
          assert.strictEqual(command?.type, "thread.pin");
          if (command?.type !== "thread.pin") return;
          assert.strictEqual(command.threadId, unpinnedThreadId);
          assert.isTrue(command.orderKey !== undefined && command.orderKey < "m");
        }),
      );
    }),
  );
  it.effect("waits over the live shell stream until the run and its agents finish", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("wait");
      const runningThread = makeTestThreadShell(waitThreadId, {
        status: "running",
        activeRunId: waitRunId,
        latestRunId: waitRunId,
        activityRunStatus: "running",
      });
      const settledThread = makeTestThreadShell(waitThreadId, {
        status: "completed",
        latestRunId: waitRunId,
        latestRunCompletedAt: now,
      });
      yield* withThreadServer(
        baseDir,
        {
          project: makeProject(workspaceRoot),
          extraThreads: [runningThread],
          shellUpdates: [
            {
              kind: "thread.updated",
              sequence: 13,
              location: "active",
              thread: {
                ...settledThread,
                pendingBackgroundTasks: [{ taskId: "sub", kind: "subagent" }],
              },
            },
            { kind: "thread.updated", sequence: 14, location: "active", thread: settledThread },
          ],
        },
        () =>
          Effect.gen(function* () {
            const wait = (...flags: ReadonlyArray<string>) =>
              captureStdout([
                "thread",
                "wait",
                waitThreadId,
                ...flags,
                "--json",
                "--base-dir",
                baseDir,
              ]).pipe(
                Effect.map((output) =>
                  parseJson<{
                    readonly outcome: string;
                    readonly observedSequence: number;
                    readonly backgroundLiveness: string | null;
                    readonly turn?: { readonly turnId: string; readonly state: string };
                  }>(output),
                ),
              );
            const plain = yield* wait();
            assert.deepEqual(
              {
                outcome: plain.outcome,
                sequence: plain.observedSequence,
                liveness: plain.backgroundLiveness,
                turn: plain.turn && { turnId: plain.turn.turnId, state: plain.turn.state },
              },
              {
                outcome: "completed",
                sequence: 13,
                liveness: "working",
                turn: { turnId: waitRunId, state: "completed" },
              },
            );
            const drained = yield* wait("--drain");
            assert.deepEqual(
              { outcome: drained.outcome, sequence: drained.observedSequence },
              { outcome: "completed", sequence: 14 },
            );
          }),
      );
    }),
  );

  it.effect("lists and answers only a pending question", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("input");
      yield* withThreadServer(
        baseDir,
        { project: makeProject(workspaceRoot), projection: questionProjection(activeThreadId) },
        (record) =>
          Effect.gen(function* () {
            const listed = parseJson<{
              readonly requests: ReadonlyArray<{
                readonly id: string;
                readonly responseMode: string;
                readonly questions: ReadonlyArray<{
                  readonly prompt: string;
                  readonly options: ReadonlyArray<{ readonly id: string }>;
                  readonly allowCustomAnswer: boolean;
                  readonly multiSelect: boolean;
                }>;
              }>;
            }>(
              yield* captureStdout([
                "thread",
                "input",
                "list",
                activeThreadId,
                "--json",
                "--base-dir",
                baseDir,
              ]),
            );
            // The approval is not a question, so only the question is listed.
            assert.deepEqual(
              listed.requests.map((request) => ({
                id: request.id,
                responseMode: request.responseMode,
                questions: request.questions.map((question) => ({
                  prompt: question.prompt,
                  optionIds: question.options.map((option) => option.id),
                  allowCustomAnswer: question.allowCustomAnswer,
                  multiSelect: question.multiSelect,
                })),
              })),
              [
                {
                  id: questionRequestId,
                  responseMode: "blocking",
                  questions: [
                    {
                      prompt: "Ship it?",
                      optionIds: ["yes"],
                      allowCustomAnswer: true,
                      multiSelect: false,
                    },
                  ],
                },
              ],
            );

            const respond = (requestId: string) =>
              captureStdout([
                "thread",
                "input",
                "respond",
                activeThreadId,
                requestId,
                "--answers-json",
                '{"ship":"yes"}',
                "--json",
                "--base-dir",
                baseDir,
              ]);
            const refused = parseJson<{ readonly error: { readonly code: string } }>(
              yield* respond(approvalRequestId),
            );
            assert.strictEqual(refused.error.code, "ThreadCliInputRequestNotPendingError");
            assert.lengthOf((yield* Ref.get(record)).commands, 0);

            const answered = parseJson<{ readonly action: string; readonly sequence: number }>(
              yield* respond(questionRequestId),
            );
            assert.deepEqual(
              { action: answered.action, sequence: answered.sequence },
              { action: "response-requested", sequence: 42 },
            );
            const [command] = (yield* Ref.get(record)).commands;
            if (command?.type !== "runtime-request.respond") {
              return assert.fail(`Expected a runtime-request.respond, got ${command?.type}`);
            }
            assert.deepEqual(
              {
                threadId: command.threadId,
                requestId: command.requestId,
                answers: command.answers,
              },
              { threadId: activeThreadId, requestId: questionRequestId, answers: { ship: "yes" } },
            );
          }),
      );
    }),
  );
});
