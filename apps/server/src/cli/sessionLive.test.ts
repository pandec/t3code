// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP, Git and filesystem boundaries.
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
  EnvironmentSessionImportError,
  type ExecutionEnvironmentDescriptor,
  ProviderDriverKind,
  ProviderInstanceId,
  type SessionImportPayload,
  ThreadId,
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
import { sanitizeGitRepositoryEnvironment } from "../git/Utils.ts";
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
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  captureStdout,
  makeConfig,
  makeTestAuthLayer,
  parseJson,
  runCli,
} from "./liveServerTestKit.ts";
import { SessionCliServerUnsupportedError } from "./session.ts";

const testAuthLayer = makeTestAuthLayer("session-cli-live-test");
const codexSessionId = "019dcef1-5a56-7250-b50e-d62b129552f4";
const codexFileName = `rollout-2026-07-25T08-09-10-${codexSessionId}.jsonl`;
const importedThreadId = ThreadId.make("import:codex:session");

class SessionCliHttpApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.orchestration)
  .add(EnvironmentHttpApi.groups.projects)
  .add(EnvironmentHttpApi.groups.sessionImport)
  .add(EnvironmentHttpApi.groups.providers) {}

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
 * A live server with the real project routes, a Codex catalog instance whose
 * import home is `codexHome`, and a session-import route that records each
 * payload: the first import succeeds, later ones report "already-imported".
 */
const withLiveServer = <A, E, R>(
  input: { readonly baseDir: string; readonly codexHome: string },
  run: (server: {
    readonly imports: Ref.Ref<ReadonlyArray<SessionImportPayload>>;
  }) => Effect.Effect<A, E, R>,
  options?: { readonly sessionImport?: boolean },
) =>
  Effect.gen(function* () {
    const config = yield* makeConfig(input.baseDir);
    const imports = yield* Ref.make<ReadonlyArray<SessionImportPayload>>([]);
    const descriptor: ExecutionEnvironmentDescriptor = {
      environmentId: EnvironmentId.make("session-cli-live-test"),
      label: "Session CLI test",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        providerCatalog: true,
        ...(options?.sessionImport === false ? {} : { sessionImport: true }),
      },
    };
    const metadataLayer = HttpApiBuilder.group(EnvironmentHttpApi, "metadata", (handlers) =>
      handlers.handle("descriptor", () => Effect.succeed(descriptor)),
    );
    const providersLayer = HttpApiBuilder.group(EnvironmentHttpApi, "providers", (handlers) =>
      handlers.handle("catalog", () =>
        Effect.succeed({
          instances: [
            {
              instanceId: ProviderInstanceId.make("codex"),
              driverKind: ProviderDriverKind.make("codex"),
              displayName: "Codex",
              enabled: true,
              importCapable: true,
              home: input.codexHome,
              models: [{ slug: "gpt-5.6-sol", name: "GPT 5.6 Sol", optionDescriptors: [] }],
            },
          ],
        }),
      ),
    );
    const sessionImportLayer = HttpApiBuilder.group(
      EnvironmentHttpApi,
      "sessionImport",
      (handlers) =>
        handlers
          .handle("candidates", () =>
            Effect.succeed({
              candidates: [
                {
                  instanceId: ProviderInstanceId.make("codex"),
                  provider: ProviderDriverKind.make("codex"),
                  providerDisplayName: "Codex",
                  nativeSessionId: codexSessionId,
                  name: null,
                  preview: "Fix the build",
                  messageCount: 2,
                  updatedAt: "2026-07-25T08:09:10.000Z",
                  linkedThread: null,
                },
              ],
            }),
          )
          .handle("importSession", (args) =>
            Ref.getAndUpdate(imports, (previous) => [...previous, args.payload]).pipe(
              Effect.flatMap((previous) =>
                previous.length === 0
                  ? Effect.succeed({ threadId: importedThreadId })
                  : Effect.fail(
                      new EnvironmentSessionImportError({
                        code: "session_import_error",
                        reason: "already-imported",
                        detail: "already attached",
                        existingThreadId: importedThreadId,
                      }),
                    ),
              ),
            ),
          )
          .handle("forkThread", () => Effect.die("unused")),
    );
    const startupLayer = Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, {
      awaitCommandReady: Effect.void,
      markHttpListening: Effect.void,
      enqueueCommand: (effect) => effect,
    });
    const projectServiceLayer = ProjectServiceLayerLive.pipe(
      Layer.provideMerge(ProjectEnrichmentService.layer),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(ProjectFaviconResolver.layer),
      Layer.provideMerge(T3ProjectFileLoader.layer),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(SqlitePersistence.layerConfig),
    );
    const routesLayer = HttpApiBuilder.layer(SessionCliHttpApi).pipe(
      Layer.provide(
        Layer.mergeAll(
          metadataLayer,
          shellHttpApiLayer,
          projectHttpApiLayer.pipe(Layer.provide(startupLayer)),
          providersLayer,
          sessionImportLayer,
        ),
      ),
      Layer.provide(testAuthLayer),
    );
    const appLayer = HttpRouter.serve(routesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
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
      return yield* run({ imports });
    }).pipe(Effect.provide(appLayer), Effect.scoped);
  });

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
    env: sanitizeGitRepositoryEnvironment(),
  });

/** A repository with one commit on `main` and a local `feature/handover` branch. */
const makeFixture = (label: string) => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-session-live-${label}-`)),
  );
  const baseDir = NodePath.join(root, "state");
  const codexHome = NodePath.join(root, "codex-home");
  const repo = NodePath.join(root, "repo");
  NodeFS.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, [
    "-c",
    "user.name=T3 Test",
    "-c",
    "user.email=t3@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  git(repo, ["branch", "feature/handover"]);
  const transcript = NodePath.join(root, codexFileName);
  NodeFS.writeFileSync(
    transcript,
    [
      `{"timestamp":"2026-07-25T08:09:10.000Z","type":"session_meta","payload":{"id":"${codexSessionId}","cwd":"/source/machine/repo"}}`,
      '{"type":"turn_context","payload":{"model":"gpt-5.6-sol","cwd":"/source/machine/repo"}}',
      '{"type":"response_item","payload":{"text":"mentions /source/machine/repo in prose"}}',
    ].join("\n"),
  );
  return { baseDir, codexHome, repo, transcript };
};

it.layer(NodeServices.layer)("session CLI against a running server", (it) => {
  it.effect(
    "auto-adds the repository, places a retargeted rollout in a standard worktree, and is retry-safe",
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture("import");
        yield* withLiveServer(fixture, ({ imports }) =>
          Effect.gen(function* () {
            const args = [
              "session",
              "import",
              "--file",
              fixture.transcript,
              "--project",
              fixture.repo,
              "--worktree-branch",
              "feature/handover",
              "--title",
              "Handed over",
              "--json",
              "--base-dir",
              fixture.baseDir,
            ];
            const imported = parseJson<{
              readonly threadId: string;
              readonly action: string;
              readonly projectId: string;
              readonly placedPath: string;
              readonly retargetedCwdFields: number;
              readonly worktreePath: string;
            }>(yield* captureStdout(args));
            const worktreePath = NodePath.join(
              fixture.baseDir,
              "worktrees",
              "repo",
              "feature-handover",
            );
            const placedPath = NodePath.join(
              fixture.codexHome,
              "sessions",
              "2026",
              "07",
              "25",
              codexFileName,
            );
            assert.equal(imported.action, "imported");
            assert.equal(imported.threadId, importedThreadId);
            assert.equal(imported.worktreePath, worktreePath);
            assert.equal(imported.placedPath, placedPath);
            assert.equal(imported.retargetedCwdFields, 2);
            assert.equal(
              git(worktreePath, ["branch", "--show-current"]).toString().trim(),
              "feature/handover",
            );

            // Recorded cwds move to the worktree; prose mentions stay verbatim.
            const placed = NodeFS.readFileSync(placedPath, "utf8");
            assert.include(placed, `"cwd":"${worktreePath}"`);
            assert.notInclude(placed, '"cwd":"/source/machine/repo"');
            assert.include(placed, "mentions /source/machine/repo in prose");

            const [payload] = yield* Ref.get(imports);
            assert.deepEqual(payload, {
              projectId: payload!.projectId,
              instanceId: ProviderInstanceId.make("codex"),
              nativeSessionId: codexSessionId,
              title: "Handed over",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.6-sol",
              },
              worktree: { branch: "feature/handover", worktreePath },
            });
            assert.equal(imported.projectId, payload!.projectId);

            // The repository became a project, so candidates resolve it by path.
            const candidates = parseJson<{
              readonly projectId: string;
              readonly candidates: ReadonlyArray<{ readonly nativeSessionId: string }>;
            }>(
              yield* captureStdout([
                "session",
                "candidates",
                "--project",
                fixture.repo,
                "--json",
                "--base-dir",
                fixture.baseDir,
              ]),
            );
            assert.equal(candidates.projectId, payload!.projectId);
            assert.deepEqual(
              candidates.candidates.map((candidate) => candidate.nativeSessionId),
              [codexSessionId],
            );

            // A retry finds the identical file in place and reports the existing thread.
            const retried = parseJson(yield* captureStdout(args));
            assert.deepEqual(retried, { threadId: importedThreadId, action: "already-imported" });
            assert.equal((yield* Ref.get(imports)).length, 2);
          }),
        );
      }),
  );

  it.effect("refuses to import on a server without session import", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("unsupported");
      yield* withLiveServer(
        fixture,
        ({ imports }) =>
          Effect.gen(function* () {
            const error = yield* runCli([
              "session",
              "import",
              "--file",
              fixture.transcript,
              "--project",
              fixture.repo,
              "--base-dir",
              fixture.baseDir,
            ]).pipe(Effect.flip);
            assert.instanceOf(error, SessionCliServerUnsupportedError);
            assert.equal(error.capability, "sessionImport");
            assert.isFalse(NodeFS.existsSync(fixture.codexHome));
            assert.equal((yield* Ref.get(imports)).length, 0);
          }),
        { sessionImport: false },
      );
    }),
  );
});
