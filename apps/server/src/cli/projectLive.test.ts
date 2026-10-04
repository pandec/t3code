// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentHttpApi,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import { HttpServer } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

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
import {
  captureStdout,
  makeConfig,
  makeTestAuthLayer,
  parseJson,
  runCli,
} from "./liveServerTestKit.ts";
import { ProjectActionServerUnsupportedError } from "./project.ts";

/** Persists a runtime-state file for `baseDir` naming `port` and `pid`. */
const persistRuntimeState = (baseDir: string, port: number, pid?: number) =>
  Effect.gen(function* () {
    const config = yield* makeConfig(baseDir);
    const state = yield* makePersistedServerRuntimeState({ config, port });
    yield* persistServerRuntimeState({
      path: config.serverRuntimeStatePath,
      state: pid === undefined ? state : { ...state, pid },
    });
    return config;
  });

/** The projects the offline project service sees for `config`. */
const offlineProjects = (config: ServerConfig.ServerConfig["Service"]) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    return (yield* projects.snapshot).projects.filter((project) => project.deletedAt === null);
  }).pipe(
    Effect.provide(
      ProjectServiceLayerLive.pipe(
        Layer.provideMerge(ProjectEnrichmentService.layer),
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        Layer.provideMerge(ProjectFaviconResolver.layer),
        Layer.provideMerge(T3ProjectFileLoader.layer),
        Layer.provideMerge(WorkspacePaths.layer),
        Layer.provideMerge(SqlitePersistence.layerConfig),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "None")),
      ),
    ),
  );

/** A server that answers every request with 503: alive, but unresponsive. */
const withUnavailableServer = <A, E, R>(run: (port: number) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((_request, response) => {
        response.writeHead(503).end();
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      return typeof address === "object" && address !== null
        ? run(address.port)
        : Effect.die("Expected a TCP address");
    },
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

const testAuthLayer = makeTestAuthLayer("project-cli-live-test");

class ProjectCliHttpApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.orchestration)
  .add(EnvironmentHttpApi.groups.projects)
  .add(EnvironmentHttpApi.groups.settings) {}

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
  options?: {
    readonly conditionalProjectSettingsScriptUpdates?: boolean;
    /** Mutations commit, then fail as a declared internal error (HTTP 500). */
    readonly failAfterCommit?: boolean;
  },
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
        Ref.update(mutationCount, (count) => count + 1).pipe(
          Effect.andThen(effect),
          Effect.tap(() =>
            options?.failAfterCommit === true
              ? Effect.fail(
                  new ServerRuntimeStartup.ServerRuntimeStartupError({
                    mode: "web",
                    host: null,
                    port: 0,
                    cause: "read after commit failed",
                  }),
                )
              : Effect.void,
          ),
        ),
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

  it.effect("marks a declared internal error after the mutation as an unknown outcome", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("internal-error");
      yield* withLiveServer(
        baseDir,
        ({ mutationCount }) =>
          Effect.gen(function* () {
            const output = parseJson<{
              readonly error: { readonly code: string; readonly outcome?: string };
            }>(
              yield* captureStdout([
                "project",
                "add",
                workspaceRoot,
                "--json",
                "--base-dir",
                baseDir,
              ]),
            );
            assert.deepEqual(output.error, {
              ...output.error,
              code: "CliOrchestrationOutcomeUnknownError",
              outcome: "unknown",
            });
            assert.equal(yield* Ref.get(mutationCount), 1);
          }),
        { failAfterCommit: true },
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

  it.effect("fails instead of writing offline behind an alive but unresponsive server", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("unresponsive");
      yield* withUnavailableServer((port) =>
        Effect.gen(function* () {
          // The runtime state names this test process, which is alive.
          const config = yield* persistRuntimeState(baseDir, port);
          const error = yield* runCli([
            "project",
            "add",
            workspaceRoot,
            "--base-dir",
            baseDir,
          ]).pipe(Effect.flip);
          assert.notInstanceOf(error, CliOrchestrationServerUnavailableError);
          assert.isTrue(NodeFS.existsSync(config.serverRuntimeStatePath));
          assert.deepEqual(yield* offlineProjects(config), []);
        }),
      );
    }),
  );

  it.effect("clears a dead server's runtime state and adds the project offline", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot } = makeDirs("dead-pid");
      const closedPort = yield* withUnavailableServer((port) => Effect.succeed(port));
      const exited = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]);
      const config = yield* persistRuntimeState(baseDir, closedPort, exited.pid);
      const added = parseJson<{ readonly projectId: string; readonly action: string }>(
        yield* captureStdout(["project", "add", workspaceRoot, "--json", "--base-dir", baseDir]),
      );
      assert.equal(added.action, "added");
      assert.isFalse(NodeFS.existsSync(config.serverRuntimeStatePath));
      assert.deepEqual(
        (yield* offlineProjects(config)).map((project) => project.id),
        [ProjectId.make(added.projectId)],
      );
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
