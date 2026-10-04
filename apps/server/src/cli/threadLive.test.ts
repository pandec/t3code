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
  type ExecutionEnvironmentDescriptor,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2RpcSchemas,
  type OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as ServerConfig from "../config.ts";
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

// The four orchestration RPCs the thread CLI calls, as the server declares
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
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot, {
    payload: OrchestrationV2RpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationV2RpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
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
}

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
  },
  run: (record: Ref.Ref<ServerRecord>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const config = yield* makeConfig(baseDir);
    const record = yield* Ref.make<ServerRecord>({ commands: [], launches: [] });
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
    ];
    const shellFor = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) => ({
      schemaVersion: 1,
      snapshotSequence: 11,
      projects: [input.project],
      threads,
      archivedThreads: [],
    });
    const unused = Effect.die("unused");
    const httpLayer = Layer.mergeAll(
      HttpApiBuilder.group(EnvironmentHttpApi, "metadata", (handlers) =>
        handlers.handle("descriptor", () => Effect.succeed(descriptor)),
      ),
      HttpApiBuilder.group(EnvironmentHttpApi, "orchestration", (handlers) =>
        handlers
          .handle("shellSnapshot", () => Effect.succeed(shellFor(activeThreads)))
          .handle("threadSnapshot", () => unused)
          .handle("threadBoundedSnapshot", () => unused)
          .handle("threadHistoryPage", () => unused),
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
      [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: () =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 11,
          projects: [],
          threads: [makeTestThreadShell(archivedThreadId, { archivedAt: now })],
        }),
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

const launchResult = (launch: OrchestrationV2ThreadLaunchInput) => {
  const threadId = launch.threadId ?? ThreadId.make("unknown");
  const { pendingRuntimeRequest: _pending, ...thread } = makeTestThreadShell(threadId);
  return {
    threadId,
    resumed: false,
    projection: {
      thread: {
        ...thread,
        title: launch.title,
        lastVisitedAt: null,
      },
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
    },
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
});
