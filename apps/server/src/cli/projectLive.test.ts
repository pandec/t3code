// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthAdministrativeScopes,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  ProjectId,
} from "@t3tools/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import { HttpServer } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import { ProjectServiceLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import { projectHttpApiLayer } from "../project/http.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { settingsHttpApiLayer } from "../settingsHttp.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  CliOrchestrationConflictError,
  CliOrchestrationServerUnavailableError,
  updateLiveServerSettings,
} from "./orchestration.ts";
import { ProjectActionServerUnsupportedError } from "./project.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(CliRuntimeLayer));

/** Runs a CLI invocation and returns its last stdout line. */
const captureStdout = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* Command.runWith(cli, { version: "0.0.0" })(args);
    return (
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      ""
    );
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer)));

const parseJson = <A>(output: string): A => JSON.parse(output) as A;

const makeConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otelEnvironment: OtelEnvironment.none,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfig.ServerConfig["Service"];
  });

class ProjectCliHttpApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.orchestration)
  .add(EnvironmentHttpApi.groups.projects)
  .add(EnvironmentHttpApi.groups.settings) {}

const testAuthLayer = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
  Effect.provideService(httpEffect, EnvironmentAuthenticatedPrincipal, {
    sessionId: AuthSessionId.make("project-cli-live-test"),
    subject: "project-cli-live-test",
    method: "bearer-access-token",
    scopes: new Set(AuthAdministrativeScopes),
  }),
);

/** Serves the shell from the real project service; threads are irrelevant here. */
const shellHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projects = yield* ProjectService.ProjectService;
    return handlers
      .handle("shellSnapshot", () =>
        projects.snapshot.pipe(
          Effect.map((snapshot) => ({
            schemaVersion: 1,
            snapshotSequence: 0,
            threads: [],
            archivedThreads: [],
            projects: snapshot.projects
              .filter((project) => project.deletedAt === null)
              .map(({ deletedAt: _deletedAt, ...project }) => project),
          })),
          Effect.orDie,
        ),
      )
      .handle("threadSnapshot", () => Effect.die("unused"))
      .handle("threadBoundedSnapshot", () => Effect.die("unused"))
      .handle("threadHistoryPage", () => Effect.die("unused"));
  }),
);

/**
 * Runs `run` against a minimal live server for `baseDir`: the real project
 * mutation and settings routes, a shell route backed by the same project
 * service, and a runtime-state file the CLI discovers.
 */
const withLiveServer = <A, E, R>(
  baseDir: string,
  run: (input: {
    readonly origin: string;
    readonly mutationCount: Ref.Ref<number>;
  }) => Effect.Effect<A, E, R>,
  options?: { readonly conditionalProjectSettingsScriptUpdates?: boolean },
) =>
  Effect.gen(function* () {
    const config = yield* makeConfig(baseDir);
    const mutationCount = yield* Ref.make(0);
    const descriptor: ExecutionEnvironmentDescriptor = {
      environmentId: EnvironmentId.make("project-cli-live-test"),
      label: "Project CLI test",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        ...(options?.conditionalProjectSettingsScriptUpdates === false
          ? {}
          : { conditionalProjectSettingsScriptUpdates: true }),
      },
    };
    const metadataLayer = HttpApiBuilder.group(EnvironmentHttpApi, "metadata", (handlers) =>
      handlers.handle("descriptor", () => Effect.succeed(descriptor)),
    );
    const startupLayer = Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, {
      awaitCommandReady: Effect.void,
      markHttpListening: Effect.void,
      enqueueCommand: (effect) =>
        Ref.update(mutationCount, (count) => count + 1).pipe(Effect.andThen(effect)),
    });
    const projectServiceLayer = ProjectServiceLayerLive.pipe(
      Layer.provideMerge(ProjectEnrichmentService.layer),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(ProjectFaviconResolver.layer),
      Layer.provideMerge(T3ProjectFileLoader.layer),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(SqlitePersistence.layerConfig),
    );
    const routesLayer = HttpApiBuilder.layer(ProjectCliHttpApi).pipe(
      Layer.provide(
        Layer.mergeAll(
          metadataLayer,
          shellHttpApiLayer,
          projectHttpApiLayer.pipe(Layer.provide(startupLayer)),
          settingsHttpApiLayer,
        ),
      ),
      Layer.provide(testAuthLayer),
    );
    const appLayer = HttpRouter.serve(routesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(ServerSettingsModule.layerTest({ projectSettingsFolded: true })),
      Layer.provideMerge(projectServiceLayer),
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
      return yield* run({ origin: `http://127.0.0.1:${address.port}`, mutationCount });
    }).pipe(Effect.provide(appLayer), Effect.scoped);
  });

const makeDirs = (label: string) => ({
  baseDir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-project-live-${label}-`)),
  workspaceRoot: NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), `t3-project-live-${label}-workspace-`),
  ),
});

it.layer(NodeServices.layer)("project CLI against a running server", (it) => {
  it.effect("routes add, rename, and remove through the running server", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("mutations");
      yield* withLiveServer(baseDir, ({ mutationCount }) =>
        Effect.gen(function* () {
          const added = parseJson<{ readonly projectId: string; readonly action: string }>(
            yield* captureStdout([
              "project",
              "add",
              workspaceRoot,
              "--title",
              "Alpha",
              "--json",
              "--base-dir",
              baseDir,
            ]),
          );
          assert.equal(added.action, "added");
          yield* runCli(["project", "rename", workspaceRoot, "Beta", "--base-dir", baseDir]);

          const listed = parseJson<{
            readonly mode: string;
            readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
          }>(yield* captureStdout(["project", "list", "--json", "--base-dir", baseDir]));
          assert.equal(listed.mode, "live");
          assert.deepEqual(
            listed.projects.map((project) => [project.id, project.title]),
            [[added.projectId, "Beta"]],
          );

          yield* runCli(["project", "remove", added.projectId, "--base-dir", baseDir]);
          const projects = yield* ProjectService.ProjectService;
          assert.deepEqual(
            (yield* projects.snapshot).projects.filter((project) => project.deletedAt === null),
            [],
          );
          assert.equal(yield* Ref.get(mutationCount), 3);
        }),
      );
    }),
  );

  it.effect("edits project actions with compare-and-set against live settings", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("actions");
      yield* withLiveServer(baseDir, ({ origin }) =>
        Effect.gen(function* () {
          yield* runCli(["project", "add", workspaceRoot, "--base-dir", baseDir]);
          yield* runCli([
            "project",
            "action",
            "add",
            workspaceRoot,
            "--id",
            "setup",
            "--name",
            "Setup",
            "--command",
            "bun install",
            "--run-on-worktree-create",
            "--base-dir",
            baseDir,
          ]);
          const added = parseJson<{
            readonly projectAction: { readonly id: string };
            readonly clearedRunOnWorktreeCreate: ReadonlyArray<string>;
          }>(
            yield* captureStdout([
              "project",
              "action",
              "add",
              workspaceRoot,
              "--id",
              "install-ios",
              "--name",
              "Install iOS",
              "--command",
              "bun run ios",
              "--run-on-worktree-create",
              "--json",
              "--base-dir",
              baseDir,
            ]),
          );
          assert.equal(added.projectAction.id, "install-ios");
          assert.deepEqual(added.clearedRunOnWorktreeCreate, ["setup"]);

          const listed = parseJson<{
            readonly mode: string;
            readonly projectId: string;
            readonly actions: ReadonlyArray<{
              readonly id: string;
              readonly runOnWorktreeCreate: boolean;
            }>;
          }>(
            yield* captureStdout([
              "project",
              "action",
              "list",
              workspaceRoot,
              "--json",
              "--base-dir",
              baseDir,
            ]),
          );
          assert.equal(listed.mode, "live");
          assert.deepEqual(
            listed.actions.map((action) => [action.id, action.runOnWorktreeCreate]),
            [
              ["setup", false],
              ["install-ios", true],
            ],
          );

          // A write based on a stale read must be rejected, not applied.
          const conflict = yield* updateLiveServerSettings(origin, "test-token", {
            projectScriptUpdate: {
              projectId: ProjectId.make(listed.projectId),
              expectedScripts: [],
              scripts: [],
            },
          }).pipe(Effect.flip);
          assert.instanceOf(conflict, CliOrchestrationConflictError);

          yield* runCli([
            "project",
            "action",
            "update",
            workspaceRoot,
            "install-ios",
            "--command",
            "bun run ios:local",
            "--base-dir",
            baseDir,
          ]);
          yield* runCli([
            "project",
            "action",
            "remove",
            workspaceRoot,
            "setup",
            "--base-dir",
            baseDir,
          ]);

          const settings = yield* (yield* ServerSettingsModule.ServerSettingsService).getSettings;
          assert.deepEqual(
            settings.projectSettingsOverrides[
              ProjectId.make(listed.projectId)
            ]?.defaultProjectScripts?.map((action) => [action.id, action.command]),
            [["install-ios", "bun run ios:local"]],
          );
        }),
      );
    }),
  );

  it.effect("refuses action edits on servers without conditional settings updates", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("capability");
      yield* withLiveServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            yield* runCli(["project", "add", workspaceRoot, "--base-dir", baseDir]);
            const error = yield* runCli([
              "project",
              "action",
              "add",
              workspaceRoot,
              "--name",
              "Test",
              "--command",
              "bun test",
              "--base-dir",
              baseDir,
            ]).pipe(Effect.flip);
            assert.instanceOf(error, ProjectActionServerUnsupportedError);
            assert.equal(error.serverVersion, "0.0.0-test");
          }),
        { conditionalProjectSettingsScriptUpdates: false },
      );
    }),
  );

  it.effect("reports live server status as JSON", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("status");
      yield* withLiveServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCli(["project", "add", workspaceRoot, "--base-dir", baseDir]);
          const status = parseJson<{
            readonly running: boolean;
            readonly pid: number;
            readonly projectCount: number;
            readonly threadCount: number;
          }>(yield* captureStdout(["status", "--json", "--base-dir", baseDir]));
          assert.isTrue(status.running);
          assert.equal(status.pid, process.pid);
          assert.equal(status.projectCount, 1);
          assert.equal(status.threadCount, 0);
        }),
      );
    }),
  );
});

it.layer(NodeServices.layer)("project CLI without a running server", (it) => {
  it.effect.each([
    ["project", "list"],
    ["project", "action", "list", "/tmp"],
    ["project", "action", "add", "/tmp", "--name", "Test", "--command", "bun test"],
  ])("requires a running server for %s %s", (args) =>
    Effect.gen(function* () {
      const { baseDir } = makeDirs("offline");
      const error = yield* runCli([...args, "--base-dir", baseDir]).pipe(Effect.flip);
      assert.instanceOf(error, CliOrchestrationServerUnavailableError);
    }),
  );

  it.effect("reports a stopped server as JSON", () =>
    Effect.gen(function* () {
      const { baseDir } = makeDirs("stopped");
      const output = yield* captureStdout(["status", "--json", "--base-dir", baseDir]);
      assert.deepEqual(parseJson(output), { running: false });
    }),
  );
});
