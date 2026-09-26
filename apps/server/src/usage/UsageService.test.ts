// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";
import { decodeScanCache, encodeScanCache } from "./usageScanCache.ts";

/** The persisted scan cache is narrowed by `decodeScanCache`, so JSON is enough here. */
const decodeScanCacheDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Shaped after a real Claude Code assistant record. */
function claudeAssistantLine(messageId: string, timestamp: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    sessionId: "usage-service-test-session",
    cwd: "/tmp/project",
    message: {
      id: messageId,
      role: "assistant",
      model: "claude-fable-5",
      content: [{ type: "text" }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 128,
        cache_read_input_tokens: 64,
        output_tokens: 32,
      },
    },
  });
}

/**
 * Rate table lookups must never touch the network here. An empty document
 * leaves pricing "unavailable", which this suite does not assert on.
 */
const httpClientStub = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ),
  ),
);

it.layer(NodeServices.layer)("UsageService", (it) => {
  describe("concurrent scans", () => {
    it.effect("serialises overlapping readSummary calls and reuses the warmed cache", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;

        // Homes live under the config's scoped temp dir so they are cleaned up
        // with it.
        const claudeHome = path.join(config.baseDir, "claude-home");
        const codexHome = path.join(config.baseDir, "codex-home");
        const claudeTranscriptDir = path.join(claudeHome, "projects");
        const codexTranscriptDir = path.join(codexHome, "sessions");
        const claudeTranscriptPath = path.join(claudeTranscriptDir, "session.jsonl");
        const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
        yield* fileSystem.makeDirectory(claudeTranscriptDir, { recursive: true });
        yield* fileSystem.makeDirectory(codexTranscriptDir, { recursive: true });
        const canonicalClaudeTranscriptDir = yield* Effect.promise(() =>
          NodeFSP.realpath(claudeTranscriptDir),
        );

        // The suite runs on the test clock, so "now" is the epoch. Stamping
        // the record with the same instant the service will bucket against
        // keeps the window assertion independent of the wall clock, and the
        // file's real mtime is far newer than the window's mtime floor.
        const scannedAt = DateTime.formatIso(yield* DateTime.now);
        const today = UsageDay.make(scannedAt.slice(0, 10));
        yield* fileSystem.writeFileString(
          claudeTranscriptPath,
          `${claudeAssistantLine("msg_usage_1", scannedAt)}\n`,
        );

        const events: string[] = [];
        let scanCacheWrites = 0;
        const instrumentedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          exists: (target) =>
            Effect.gen(function* () {
              // The walk probes each provider root exactly once per scan, so
              // the Claude root marks that scan's walk beginning.
              if (target === canonicalClaudeTranscriptDir) events.push("scan:start");
              // Hand the scheduler an opportunity to run the other scan. If
              // nothing serialises them, both walks start before either ends.
              yield* Effect.yieldNow;
              return yield* fileSystem.exists(target);
            }),
          writeFileString: (target, contents, options) =>
            Effect.gen(function* () {
              if (target === scanCachePath) scanCacheWrites += 1;
              return yield* fileSystem.writeFileString(target, contents, options);
            }),
        });

        const usage = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, instrumentedFileSystem),
          Effect.provideService(HttpClient.HttpClient, httpClientStub),
          Effect.provide(
            ServerSettings.layerTest({
              providers: {
                claudeAgent: { homePath: claudeHome },
                codex: { homePath: codexHome, shadowHomePath: "" },
              },
            }),
          ),
        );

        const scan = (timeZone: string) =>
          usage.readSummary({ sinceDay: today, untilDay: today, timeZone }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                events.push("scan:end");
              }),
            ),
          );

        const [first, second] = yield* Effect.all([scan("UTC"), scan("Etc/UTC")], {
          concurrency: "unbounded",
        });

        // Neither walk overlaps the other: the second scan starts only after
        // the first has finished and persisted.
        assert.deepEqual(events, ["scan:start", "scan:end", "scan:start", "scan:end"]);

        // The scan is not vacuous: the transcript really was read.
        assert.isAbove(first.buckets.length, 0);
        assert.deepEqual(second.buckets, first.buckets);

        // Exactly one persist: the second scan found every file warm rather
        // than re-parsing them, and no dirty entry was cleared without landing
        // on disk.
        assert.equal(scanCacheWrites, 1);

        const persisted = decodeScanCache(
          yield* decodeScanCacheDocument(yield* fileSystem.readFileString(scanCachePath)),
        );
        assert.isTrue(persisted.has(path.join(canonicalClaudeTranscriptDir, "session.jsonl")));
      }).pipe(
        Effect.provide(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-usage-service-test-" }),
          ),
        ),
      ),
    );
  });

  describe("instance roots", () => {
    it.effect("enumerates legacy and explicit shared roots without scanning auth overlays", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const legacyClaudeHome = path.join(config.baseDir, "legacy-claude");
        const overriddenClaudeConfig = path.join(config.baseDir, "overridden-claude");
        const claudeShadowConfig = path.join(config.baseDir, "claude-shadow");
        const codexHome = path.join(config.baseDir, "codex");
        const codexShadowHome = path.join(config.baseDir, "codex-shadow");
        const claudeProjects = path.join(overriddenClaudeConfig, "projects");
        const claudeShadowProjects = path.join(claudeShadowConfig, "projects");
        const codexSessions = path.join(codexHome, "sessions");
        const codexShadowSessions = path.join(codexShadowHome, "sessions");

        yield* fileSystem.makeDirectory(path.join(legacyClaudeHome, "projects"), {
          recursive: true,
        });
        yield* fileSystem.makeDirectory(claudeProjects, { recursive: true });
        yield* fileSystem.makeDirectory(claudeShadowConfig, { recursive: true });
        yield* fileSystem.symlink(claudeProjects, claudeShadowProjects);
        yield* fileSystem.makeDirectory(codexSessions, { recursive: true });
        yield* fileSystem.makeDirectory(codexShadowHome, { recursive: true });
        yield* fileSystem.symlink(codexSessions, codexShadowSessions);

        const scannedAt = DateTime.formatIso(yield* DateTime.now);
        const today = UsageDay.make(scannedAt.slice(0, 10));
        yield* fileSystem.writeFileString(
          path.join(claudeProjects, "session.jsonl"),
          `${claudeAssistantLine("msg_instance", scannedAt)}\n`,
        );

        const usage = yield* UsageService.make.pipe(
          Effect.provideService(HttpClient.HttpClient, httpClientStub),
          Effect.provide(
            ServerSettings.layerTest({
              providers: {
                claudeAgent: { homePath: legacyClaudeHome },
                codex: { homePath: codexHome, shadowHomePath: "" },
              },
              providerInstances: {
                [ProviderInstanceId.make("claudeOverride")]: {
                  driver: "claudeAgent",
                  config: { homePath: "", shadowHomePath: claudeShadowConfig },
                  environment: [{ name: "CLAUDE_CONFIG_DIR", value: overriddenClaudeConfig }],
                },
                [ProviderInstanceId.make("claudeDuplicate")]: {
                  driver: "claudeAgent",
                  config: { homePath: "", shadowHomePath: claudeShadowConfig },
                  environment: [{ name: "CLAUDE_CONFIG_DIR", value: overriddenClaudeConfig }],
                },
                [ProviderInstanceId.make("claudeAlias")]: {
                  driver: "claudeAgent",
                  config: { homePath: claudeShadowConfig, shadowHomePath: "" },
                },
                [ProviderInstanceId.make("codexDuplicate")]: {
                  driver: "codex",
                  config: { homePath: codexHome, shadowHomePath: codexShadowHome },
                },
                [ProviderInstanceId.make("codexAlias")]: {
                  driver: "codex",
                  config: { homePath: codexShadowHome, shadowHomePath: "" },
                },
              },
            }),
          ),
        );

        const summary = yield* usage.readSummary({
          sinceDay: today,
          untilDay: today,
          timeZone: "UTC",
        });
        const claudeSources = summary.sources.filter(
          (source) => source.fingerprint.provider === "claude",
        );
        const codexSources = summary.sources.filter(
          (source) => source.fingerprint.provider === "codex",
        );
        const canonicalClaudeProjects = yield* Effect.promise(() =>
          NodeFSP.realpath(claudeProjects),
        );
        const canonicalCodexSessions = yield* Effect.promise(() => NodeFSP.realpath(codexSessions));

        assert.equal(claudeSources.length, 2);
        const overriddenSource = claudeSources.find(
          (source) => source.fingerprint.resolvedHomePath === canonicalClaudeProjects,
        );
        assert.isDefined(overriddenSource);
        assert.equal(overriddenSource?.status, "ok");
        assert.equal(codexSources.length, 1);
        assert.equal(codexSources[0]?.fingerprint.resolvedHomePath, canonicalCodexSessions);
        assert.equal(
          summary.buckets.reduce((records, bucket) => records + bucket.records, 0),
          1,
        );
      }).pipe(
        Effect.provide(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-usage-instances-test-" }),
          ),
        ),
      ),
    );
  });

  describe("source reporting", () => {
    it.effect("reports unreadable transcripts as a partial source and counts malformed rows", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;

        const claudeHome = path.join(config.baseDir, "claude-home");
        const codexHome = path.join(config.baseDir, "codex-home");
        const claudeTranscriptDir = path.join(claudeHome, "projects");
        const codexTranscriptDir = path.join(codexHome, "sessions");
        // Target of the unreadable transcript, kept outside the walked root so
        // it is not itself enumerated.
        const symlinkTarget = path.join(config.baseDir, "not-a-transcript");

        yield* fileSystem.makeDirectory(claudeTranscriptDir, { recursive: true });
        yield* fileSystem.makeDirectory(codexTranscriptDir, { recursive: true });
        yield* fileSystem.makeDirectory(symlinkTarget, { recursive: true });

        const scannedAt = DateTime.formatIso(yield* DateTime.now);
        const today = UsageDay.make(scannedAt.slice(0, 10));

        yield* fileSystem.writeFileString(
          path.join(claudeTranscriptDir, "good.jsonl"),
          `${claudeAssistantLine("msg_good", scannedAt)}\n`,
        );
        // Two lines advertise a usage payload but cannot be parsed into one.
        // They must be counted, not silently dropped.
        yield* fileSystem.writeFileString(
          path.join(claudeTranscriptDir, "damaged.jsonl"),
          [
            claudeAssistantLine("msg_damaged", scannedAt),
            '{"type":"assistant","message":{"usage":"not-an-object"}}',
            '{"type":"assistant","message":{"usage":null}}',
            "",
          ].join("\n"),
        );
        // A dangling-into-a-directory symlink lists as a file but fails to
        // open, which is exactly the "exists but unreadable" case.
        yield* fileSystem.symlink(
          symlinkTarget,
          path.join(claudeTranscriptDir, "unreadable.jsonl"),
        );

        const usage = yield* UsageService.make.pipe(
          Effect.provideService(HttpClient.HttpClient, httpClientStub),
          Effect.provide(
            ServerSettings.layerTest({
              providers: {
                claudeAgent: { homePath: claudeHome },
                codex: { homePath: codexHome, shadowHomePath: "" },
              },
            }),
          ),
        );

        const summary = yield* usage.readSummary({
          sinceDay: today,
          untilDay: today,
          timeZone: "UTC",
        });

        const claudeSource = summary.sources.find(
          (source) => source.fingerprint.provider === "claude",
        );
        assert.isDefined(claudeSource);
        assert.equal(claudeSource?.status, "partial");
        assert.equal(claudeSource?.scannedFiles, 2);
        // The unreadable file contributed nothing, so it is skipped like an
        // empty one — the status and message are what tell them apart.
        assert.equal(claudeSource?.skippedFiles, 1);
        assert.equal(claudeSource?.malformedRecords, 2);
        assert.include(claudeSource?.message ?? "", "1 transcript file could not be read");

        // A clean directory alongside a damaged one still reports as ok.
        const codexSource = summary.sources.find(
          (source) => source.fingerprint.provider === "codex",
        );
        assert.equal(codexSource?.status, "ok");
        assert.equal(codexSource?.malformedRecords, 0);
        assert.isNull(codexSource?.message ?? null);

        // The readable records still landed despite the damage.
        assert.isAbove(summary.buckets.length, 0);

        const firstBuckets = summary.buckets;
        const goodTranscript = path.join(claudeTranscriptDir, "good.jsonl");
        yield* Effect.promise(async () => {
          await NodeFSP.rm(goodTranscript);
          await NodeFSP.symlink(symlinkTarget, goodTranscript);
        });
        const withCachedReadFailure = yield* usage.readSummary({
          sinceDay: today,
          untilDay: today,
          timeZone: "UTC",
        });
        assert.deepStrictEqual(withCachedReadFailure.buckets, firstBuckets);
        const cachedFailureSource = withCachedReadFailure.sources.find(
          (source) => source.fingerprint.provider === "claude",
        );
        assert.equal(cachedFailureSource?.status, "partial");
        assert.include(cachedFailureSource?.message ?? "", "2 transcript files could not be read");
      }).pipe(
        Effect.provide(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-usage-source-test-" }),
          ),
        ),
      ),
    );
  });
});

const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function claudeLine(id: number, outputTokens: number, model = "claude-fable-5"): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

const setup = Effect.gen(function* () {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-service-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const transcriptDir = NodePath.join(home, "claude", "projects", "proj");
  yield* Effect.promise(() => NodeFSP.mkdir(transcriptDir, { recursive: true }));
  return {
    home,
    transcript: NodePath.join(transcriptDir, "session.jsonl"),
    settings: {
      providers: {
        claudeAgent: { homePath: NodePath.join(home, "claude") },
        codex: { homePath: NodePath.join(home, "codex") },
      },
    },
  };
});

const serviceLayers = (input: {
  readonly prefix: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly onRatesFetch?: () => void;
  /** Defaults to an unparsable document so every scan retries the fetch. */
  readonly ratesDocument?: unknown;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}) =>
  ServerConfig.layerTest(process.cwd(), { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostProcessPlatform, input.platform ?? "linux")),
    Layer.provideMerge(ServerSettings.layerTest(input.settings)),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            input.onRatesFetch?.();
            // Unparsable rates: every scan retries the fetch, which makes the
            // fetch count a boundary-level observation of how many scans ran.
            return HttpClientResponse.fromWeb(request, Response.json(input.ratesDocument ?? {}));
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcessEnvironment, {
        HOME: input.home,
        GROK_HOME: NodePath.join(input.home, "grok"),
        OPENCODE_DATA_DIR: NodePath.join(input.home, "opencode"),
        ANTIGRAVITY_DATA_DIR: NodePath.join(input.home, "antigravity"),
        XDG_CONFIG_HOME: NodePath.join(input.home, "config"),
        APPDATA: NodePath.join(input.home, "config"),
        ...input.environment,
      }),
    ),
  );

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

describe("UsageService", () => {
  it.live("does not read the macOS Cursor Keychain before account usage is enabled", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-cursor-keychain-disabled",
            home,
            settings,
            platform: "darwin",
            environment: {},
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const cursor = summary.sources.find((source) => source.fingerprint.provider === "cursor");
      assert.strictEqual(cursor?.status, "missing");
      assert.strictEqual(cursor?.action, "enableCursorKeychain");
    }).pipe(Effect.scoped),
  );

  it.live("ignores stale Cursor file logins when the active credential store differs", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      for (const [index, testCase] of [
        {
          platform: "darwin" as const,
          environment: { AGENT_CLI_CREDENTIAL_STORE: "memory" },
          authPath: [".cursor", "auth.json"],
        },
        {
          platform: "linux" as const,
          environment: { AGENT_CLI_CREDENTIAL_STORE: "memory" },
          authPath: ["config", "cursor", "auth.json"],
        },
        {
          platform: "linux" as const,
          environment: { CURSOR_API_KEY: "different-account" },
          authPath: ["config", "cursor", "auth.json"],
        },
      ].entries()) {
        const authPath = NodePath.join(home, ...testCase.authPath);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(authPath), { recursive: true });
          await NodeFSP.writeFile(
            authPath,
            encodeUnknownJsonString({ accessToken: "stale-token" }),
          );
        });
        const service = yield* UsageService.make.pipe(
          Effect.provide(
            serviceLayers({
              prefix: `usage-service-cursor-store-${index}`,
              home,
              settings,
              platform: testCase.platform,
              environment: testCase.environment,
            }),
          ),
        );
        const summary = yield* service.readSummary(WINDOW);
        const cursor = summary.sources.find((source) => source.fingerprint.provider === "cursor");
        assert.strictEqual(cursor?.status, "missing");
        assert.include(cursor?.message ?? "", "Cursor CLI login");
        assert.isFalse(summary.buckets.some((bucket) => bucket.provider === "cursor"));
      }
    }).pipe(Effect.scoped),
  );

  it.live(
    "includes OpenCode history but does not substitute desktop usage for an unavailable Cursor account",
    () =>
      Effect.gen(function* () {
        const { settings, home } = yield* setup;
        const root = NodePath.join(home, "opencode");
        const message = yield* encodeUnknownJson({
          id: "msg_1",
          sessionID: "session-1",
          role: "assistant",
          modelID: "example-model",
          time: { created: Date.parse("2026-08-01T10:00:00Z") },
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 20, write: 3 } },
        });
        const bubble = yield* encodeUnknownJson({
          type: 2,
          createdAt: "2026-08-01T10:00:00Z",
          modelInfo: { modelName: "example-model" },
          tokenCount: { inputTokens: 100, outputTokens: 20 },
        });
        yield* Effect.promise(async () => {
          const directory = NodePath.join(root, "storage", "message", "session-1");
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(directory, "msg_1.json"), message);
          const desktop = NodePath.join(home, "config", "Cursor", "User", "globalStorage");
          await NodeFSP.mkdir(desktop, { recursive: true });
          const db = new NodeSqlite.DatabaseSync(NodePath.join(desktop, "state.vscdb"));
          try {
            db.exec("CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
            db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
              "bubbleId:session:assistant",
              bubble,
            );
          } finally {
            db.close();
          }
        });
        const service = yield* UsageService.make.pipe(
          Effect.provide(serviceLayers({ prefix: "usage-service-opencode", home, settings })),
        );
        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(summary.buckets[0]?.provider, "opencode");
        assert.isFalse(summary.buckets.some((bucket) => bucket.provider === "cursor"));
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "cursor")?.status,
          "missing",
        );
        assert.strictEqual(
          summary.buckets[0]?.sourcePath,
          yield* Effect.promise(() => NodeFSP.realpath(root)),
        );
        assert.strictEqual(summary.buckets[0]?.totals.outputTokens, 7);
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "opencode")
            ?.distinctSessions,
          1,
        );
        assert.include(
          summary.sources.find((source) => source.fingerprint.provider === "cursor")?.message ?? "",
          "Cursor account history needs a Cursor CLI login",
        );
      }).pipe(Effect.scoped),
  );

  it.live("retains OpenCode history through read errors, cleanup, and restart", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const root = NodePath.join(home, "opencode");
      const database = NodePath.join(root, "opencode.db");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(root);
        const db = new NodeSqlite.DatabaseSync(database);
        try {
          db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
          db.prepare("INSERT INTO message VALUES (?, ?, ?)").run(
            "one",
            "session",
            encodeUnknownJsonString({
              role: "assistant",
              modelID: "example-model",
              time: { created: Date.parse("2026-08-01T10:00:00Z") },
              tokens: { input: 10, output: 5 },
            }),
          );
        } finally {
          db.close();
        }
      });
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(first), 5);
        yield* Effect.promise(() => NodeFSP.writeFile(database, "not a SQLite database"));
        const failed = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(failed.buckets, first.buckets);
        const source = failed.sources.find((source) => source.fingerprint.provider === "opencode");
        assert.strictEqual(source?.status, "partial");
        assert.strictEqual(source?.malformedRecords, 0);
        yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true }));
        const restarted = yield* UsageService.make;
        const retained = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(retained.buckets, first.buckets);
        assert.strictEqual(
          retained.sources.find((entry) => entry.fingerprint.provider === "opencode")?.status,
          "partial",
        );
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-opencode-retention", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("reports unreadable new reader sources as partial without cached history", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(home, "opencode"));
        await NodeFSP.writeFile(NodePath.join(home, "opencode", "opencode.db"), "broken");
        await NodeFSP.mkdir(NodePath.join(home, "antigravity"));
        await NodeFSP.writeFile(NodePath.join(home, "antigravity", "conversation.db"), "broken");
        await NodeFSP.mkdir(NodePath.join(home, "config", "cursor"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(home, "config", "cursor", "auth.json"), "broken");
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-reader-errors", home, settings })),
      );
      const summary = yield* service.readSummary(WINDOW);
      for (const provider of ["opencode", "antigravity", "cursor"]) {
        const source = summary.sources.find((entry) => entry.fingerprint.provider === provider);
        assert.strictEqual(source?.status, "partial");
        assert.strictEqual(source?.malformedRecords, 0);
      }
    }).pipe(Effect.scoped),
  );

  it.live("counts aliased OpenCode and Antigravity directories once", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const opencode = NodePath.join(home, "opencode-store");
      const opencodeAlias = NodePath.join(home, "opencode-alias");
      const conversations = NodePath.join(home, "antigravity-conversations");
      const antigravityA = NodePath.join(home, "antigravity-a");
      const antigravityB = NodePath.join(home, "antigravity-b");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(opencode);
        await NodeFSP.symlink(opencode, opencodeAlias, "junction");
        await NodeFSP.mkdir(conversations);
        await NodeFSP.mkdir(antigravityA);
        await NodeFSP.mkdir(antigravityB);
        await NodeFSP.symlink(
          conversations,
          NodePath.join(antigravityA, "conversations"),
          "junction",
        );
        await NodeFSP.symlink(
          conversations,
          NodePath.join(antigravityB, "conversations"),
          "junction",
        );
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-aliased-roots-test",
            home,
            settings,
            environment: {
              OPENCODE_DATA_DIR: `${opencode},${opencodeAlias}`,
              ANTIGRAVITY_DATA_DIR: `${antigravityA},${antigravityB}`,
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const sourcesFor = (provider: "opencode" | "antigravity") =>
        summary.sources.filter((source) => source.fingerprint.provider === provider);
      assert.strictEqual(sourcesFor("opencode").length, 1);
      assert.strictEqual(sourcesFor("antigravity").length, 1);
      assert.strictEqual(
        sourcesFor("opencode")[0]?.fingerprint.resolvedHomePath,
        yield* Effect.promise(() => NodeFSP.realpath(opencode)),
      );
      assert.strictEqual(
        sourcesFor("antigravity")[0]?.fingerprint.resolvedHomePath,
        yield* Effect.promise(() => NodeFSP.realpath(conversations)),
      );
    }).pipe(Effect.scoped),
  );

  it.live("reads configured and disabled accounts once across shared and aliased homes", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const codexHome = NodePath.join(home, "codex-account");
      const alias = NodePath.join(home, "codex-alias");
      const claudeHome = NodePath.join(home, "claude-account");
      const grokHome = NodePath.join(home, "grok-account");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        await NodeFSP.mkdir(NodePath.join(claudeHome, "projects"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(claudeHome, "projects", "session.jsonl"),
          claudeLine(2, 7),
        );
        await NodeFSP.mkdir(NodePath.join(codexHome, "sessions"), { recursive: true });
        await NodeFSP.symlink(codexHome, alias, "junction");
        await NodeFSP.writeFile(
          NodePath.join(codexHome, "sessions", "rollout.jsonl"),
          [
            { type: "session_meta", payload: { id: "codex-account-session" } },
            { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
            // A-B-A at one timestamp must preserve both equal A events.
            ...[11, 12, 11].map((outputTokens) => ({
              type: "event_msg",
              timestamp: "2026-08-01T10:00:00Z",
              payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 10, output_tokens: outputTokens } },
              },
            })),
          ]
            .map((line) => encodeUnknownJsonString(line))
            .join("\n") + "\n",
        );
        await NodeFSP.mkdir(NodePath.join(grokHome, "sessions", "session"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(grokHome, "sessions", "session", "updates.jsonl"),
          encodeUnknownJsonString({
            timestamp: Date.parse("2026-08-01T10:00:00Z") / 1000,
            method: "_x.ai/session/update",
            params: {
              sessionId: "grok-account-session",
              update: {
                sessionUpdate: "turn_completed",
                prompt_id: "prompt-1",
                usage: { inputTokens: 10, outputTokens: 13 },
              },
            },
          }) + "\n",
        );
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-accounts-test",
            home,
            settings: {
              ...settings,
              providerInstances: {
                [ProviderInstanceId.make("claude-work")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  enabled: false,
                  environment: [{ name: "CLAUDE_CONFIG_DIR", value: claudeHome, sensitive: false }],
                },
                [ProviderInstanceId.make("codex-work")]: {
                  driver: ProviderDriverKind.make("codex"),
                  environment: [{ name: "CODEX_HOME", value: codexHome, sensitive: false }],
                },
                [ProviderInstanceId.make("codex-alias")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: alias },
                },
                [ProviderInstanceId.make("codex-shadow")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: codexHome, shadowHomePath: NodePath.join(home, "shadow") },
                  environment: [
                    { name: "CODEX_HOME", value: NodePath.join(home, "ignored"), sensitive: false },
                  ],
                },
                [ProviderInstanceId.make("grok-work")]: {
                  driver: ProviderDriverKind.make("grok"),
                  environment: [{ name: "GROK_HOME", value: grokHome, sensitive: false }],
                },
              },
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(summary), 59);
      yield* Effect.promise(() =>
        NodeFSP.rename(
          NodePath.join(codexHome, "sessions", "rollout.jsonl"),
          NodePath.join(codexHome, "sessions", "moved.jsonl"),
        ),
      );
      const moved = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(moved.buckets, summary.buckets);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(codexHome, "sessions"), { recursive: true }),
      );
      const removed = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(removed.buckets, summary.buckets);

      const sources = summary.sources.filter((source) => source.status === "ok");
      assert.strictEqual(sources.length, 4);
      assert.strictEqual(
        sources.reduce((sum, source) => sum + source.scannedFiles, 0),
        4,
      );
      assert.strictEqual(
        sources.filter((source) => source.fingerprint.provider === "codex").length,
        1,
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "uses explicit account settings before environment and legacy homes, then refreshes them",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const configured = NodePath.join(home, "configured");
        const environmentHome = NodePath.join(home, "environment");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(transcript, claudeLine(1, 100));
          for (const [index, root] of [configured, environmentHome].entries()) {
            await NodeFSP.mkdir(NodePath.join(root, "projects"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(root, "projects", "session.jsonl"),
              claudeLine(index + 2, index + 7),
            );
          }
          await NodeFSP.mkdir(NodePath.join(configured, ".claude", "projects"), {
            recursive: true,
          });
          await NodeFSP.writeFile(
            NodePath.join(configured, ".claude", "projects", "wrong.jsonl"),
            claudeLine(4, 1000),
          );
        });
        yield* Effect.gen(function* () {
          const settingsService = yield* ServerSettings.ServerSettingsService;
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(first), 7);
          const canonicalConfiguredProjects = yield* Effect.promise(() =>
            NodeFSP.realpath(NodePath.join(configured, "projects")),
          );
          assert.include(
            first.sources.map((source) => source.fingerprint.resolvedHomePath),
            canonicalConfiguredProjects,
          );
          yield* settingsService.updateSettings({
            providerInstances: {
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: "" },
                environment: [
                  { name: "CLAUDE_CONFIG_DIR", value: environmentHome, sensitive: false },
                ],
              },
            },
          });
          const second = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(second), 8);
          const canonicalEnvironmentProjects = yield* Effect.promise(() =>
            NodeFSP.realpath(NodePath.join(environmentHome, "projects")),
          );
          assert.include(
            second.sources.map((source) => source.fingerprint.resolvedHomePath),
            canonicalEnvironmentProjects,
          );
        }).pipe(
          Effect.provide(
            serviceLayers({
              prefix: "usage-service-home-refresh-test",
              home,
              environment: { CLAUDE_CONFIG_DIR: NodePath.join(home, "host-ignored") },
              settings: {
                ...settings,
                providerInstances: {
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: { homePath: configured },
                    environment: [
                      { name: "CLAUDE_CONFIG_DIR", value: environmentHome, sensitive: false },
                    ],
                  },
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "uses inherited home variables when explicit default accounts have no home settings",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        const service = yield* UsageService.make.pipe(
          Effect.provide(
            serviceLayers({
              prefix: "usage-service-inherited-homes-test",
              home,
              environment: {
                CODEX_HOME: NodePath.join(home, "inherited-codex"),
                CLAUDE_CONFIG_DIR: NodePath.join(home, "claude"),
              },
              settings: {
                ...settings,
                providerInstances: {
                  [ProviderInstanceId.make("codex")]: {
                    driver: ProviderDriverKind.make("codex"),
                    config: {},
                  },
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: {},
                  },
                },
              },
            }),
          ),
        );
        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(summary), 5);
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "codex")?.fingerprint
            .resolvedHomePath,
          NodePath.join(home, "inherited-codex", "sessions"),
        );
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "grok")?.fingerprint
            .resolvedHomePath,
          NodePath.join(home, "grok", "sessions"),
        );
      }).pipe(Effect.scoped),
  );

  it.live("reprices unchanged transcripts when custom prices are added, edited, or removed", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const service = yield* UsageService.make;

        const original = yield* service.readSummary(WINDOW);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.strictEqual(original.buckets[0]?.unpricedRecords, 1);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const overridden = yield* service.readSummary(WINDOW);
        assert.closeTo(overridden.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
        assert.strictEqual(overridden.buckets[0]?.costSource, "modelPriced");
        assert.strictEqual(overridden.buckets[0]?.unpricedRecords, 0);
        assert.deepStrictEqual(overridden.buckets[0]?.totals, original.buckets[0]?.totals);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 16 },
          },
        });
        const edited = yield* service.readSummary(WINDOW);
        assert.closeTo(edited.buckets[0]?.costUsd ?? -1, 0.00012, 1e-12);

        yield* settingsService.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, original.buckets);
      }).pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-price-overrides-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("counts appended usage on a rescan of a grown transcript", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-grow-test", home, settings })),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(first), 5);

      yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
      const second = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(second), 12);
    }).pipe(Effect.scoped),
  );

  it.live("does not double-count a malformed tail when the file grows", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const malformedTail = '{"type":"assistant","message":{"usage":null}}';
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5) + malformedTail));

      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-tail-test", home, settings })),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(
        first.sources.find((source) => source.fingerprint.provider === "claude")?.malformedRecords,
        1,
      );

      yield* Effect.promise(() => NodeFSP.appendFile(transcript, "\n"));
      const second = yield* service.readSummary(WINDOW);
      const third = yield* service.readSummary(WINDOW);
      assert.strictEqual(
        second.sources.find((source) => source.fingerprint.provider === "claude")?.malformedRecords,
        1,
      );
      assert.strictEqual(
        third.sources.find((source) => source.fingerprint.provider === "claude")?.malformedRecords,
        1,
      );
    }).pipe(Effect.scoped),
  );

  it.live("reparses existing v4 transcripts for fast pricing while retaining deleted history", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const content = claudeLine(1, 5, "fast-model").replace(
        '"input_tokens":10',
        '"speed":"fast","input_tokens":10',
      );
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, content));
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const cachePath = NodePath.join(config.stateDir, "usage-scan-cache.json");
        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        const document = yield* Effect.promise(() => NodeFSP.readFile(cachePath, "utf8"));
        const encoded = encodeScanCache(decodeScanCache(yield* decodeScanCacheDocument(document)));
        const v4 = {
          ...encoded,
          version: 4,
          files: Object.fromEntries(
            Object.entries(encoded.files).map(([path, file]) => [
              path,
              {
                ...file,
                r: file.r.map((row) => row.slice(0, 10)),
                t: file.t.map((row) => row.slice(0, 10)),
              },
            ]),
          ),
        };
        for (const mode of ["unchanged", "grown", "deleted"] as const) {
          yield* Effect.promise(() => NodeFSP.writeFile(cachePath, encodeUnknownJsonString(v4)));
          if (mode === "grown") yield* Effect.promise(() => NodeFSP.appendFile(transcript, "{}\n"));
          if (mode === "deleted") yield* Effect.promise(() => NodeFSP.rm(transcript));
          const restarted = yield* UsageService.make;
          const summary = yield* restarted.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(summary), 5);
          assert.strictEqual(
            summary.buckets[0]?.costUsd,
            mode === "deleted" ? first.buckets[0]!.costUsd / 2 : first.buckets[0]!.costUsd,
          );
          const persisted = decodeScanCache(
            yield* decodeScanCacheDocument(
              yield* Effect.promise(() => NodeFSP.readFile(cachePath, "utf8")),
            ),
          );
          const cached = [...persisted.values()].find((file) => file.provider === "claude")!;
          assert.strictEqual(cached.records[0]?.fast, mode !== "deleted");
          assert.strictEqual(cached.requiresReparse, mode === "deleted" ? true : undefined);
        }
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, content));
        const restoredService = yield* UsageService.make;
        const restored = yield* restoredService.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, first.buckets);
      }).pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-v4-fast-migration",
            home,
            settings,
            ratesDocument: {
              "fast-model": {
                input_cost_per_token: 0.001,
                output_cost_per_token: 0.002,
                provider_specific_entry: { fast: 2 },
              },
            },
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "retains Cursor tier pricing and savings after restart when credentials cannot be read",
    () =>
      Effect.gen(function* () {
        const { settings, home } = yield* setup;
        const authPath = NodePath.join(home, "config", "cursor", "auth.json");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(authPath), { recursive: true });
          await NodeFSP.writeFile(authPath, "invalid credentials JSON");
        });
        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const source = "cursor-account:retained-account";
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const cache = encodeScanCache(
            new Map([
              [
                source,
                {
                  provider: "cursor",
                  size: 0,
                  mtimeMs: now,
                  malformedRecords: 0,
                  tailMalformedRecords: 0,
                  tailRecords: [],
                  position: { resumeOffset: 0, guardLength: 0, guardHash: 0, codexState: null },
                  records: [
                    {
                      provider: "cursor",
                      model: "display-name",
                      rateModel: "tiered-rate",
                      timestampMs: Date.parse("2026-08-01T10:00:00Z"),
                      sessionId: "one",
                      fast: false,
                      reportedCostUsd: null,
                      dedupeKey: "one",
                      totals: {
                        uncachedInputTokens: 10,
                        cachedInputTokens: 100,
                        cacheCreationTokens: 0,
                        outputTokens: 5,
                        reasoningTokens: 0,
                      },
                    },
                  ],
                },
              ],
            ]),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(config.stateDir, "usage-scan-cache.json"),
              encodeUnknownJsonString({
                ...cache,
                sources: { [`cursor\0${authPath}`]: { dir: source, volumeId: "retained-account" } },
              }),
            ),
          );
          const service = yield* UsageService.make;
          const summary = yield* service.readSummary(WINDOW);
          const bucket = summary.buckets.find((entry) => entry.provider === "cursor")!;
          assert.strictEqual(bucket.costSource, "modelPriced");
          assert.closeTo(bucket.costUsd, 0.03, 1e-10);
          assert.closeTo(bucket.cacheSavingsUsd, 0.09, 1e-10);
          assert.strictEqual(
            summary.sources.find((entry) => entry.fingerprint.provider === "cursor")?.status,
            "partial",
          );
          const restarted = yield* UsageService.make;
          assert.deepStrictEqual((yield* restarted.readSummary(WINDOW)).buckets, summary.buckets);
        }).pipe(
          Effect.provide(
            serviceLayers({
              prefix: "usage-cursor-tier-retention",
              home,
              settings,
              ratesDocument: {
                "tiered-rate": {
                  input_cost_per_token: 0.001,
                  output_cost_per_token: 0.002,
                  cache_read_input_token_cost: 0.0001,
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live("preserves saved tokens, costs and sessions after transcript cleanup and restart", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const alias = NodePath.join(home, "claude-alias");
      yield* Effect.promise(() =>
        NodeFSP.symlink(NodePath.join(home, "claude"), alias, "junction"),
      );
      const content = claudeLine(1, 5);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, content));
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(first), 5);
        assert.isAbove(first.buckets[0]?.costUsd ?? 0, 0);

        yield* Effect.promise(() => NodeFSP.rm(transcript));
        const deleted = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(deleted.buckets, first.buckets);
        assert.strictEqual(
          deleted.sources.find((source) => source.fingerprint.provider === "claude")?.status,
          "partial",
        );

        const restarted = yield* UsageService.make;
        const restored = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, first.buckets);
        assert.deepStrictEqual(restored.sources, deleted.sources);

        // A moved transcript must not count the saved usage twice.
        yield* Effect.promise(() => NodeFSP.writeFile(transcript + ".jsonl", content));
        const moved = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(moved.buckets, first.buckets);
        assert.strictEqual(
          moved.sources.find((source) => source.fingerprint.provider === "claude")
            ?.distinctSessions,
          1,
        );

        const replacementProjects = NodePath.join(home, "replacement-projects");
        yield* Effect.promise(() => NodeFSP.mkdir(replacementProjects));
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(home, "claude", "projects"), { recursive: true }),
        );
        const afterRootCleanup = yield* UsageService.make;
        const missingRoot = yield* afterRootCleanup.readSummary(WINDOW);
        const firstClaudeSource = first.sources.find(
          (source) => source.fingerprint.provider === "claude",
        );
        const missingClaudeSource = missingRoot.sources.find(
          (source) => source.fingerprint.provider === "claude",
        );
        assert.deepStrictEqual(missingRoot.buckets, first.buckets);
        assert.strictEqual(missingClaudeSource?.distinctSessions, 1);
        assert.strictEqual(missingClaudeSource?.status, "partial");
        assert.deepStrictEqual(missingClaudeSource?.fingerprint, firstClaudeSource?.fingerprint);
        yield* Effect.promise(async () => {
          const projects = NodePath.join(home, "claude", "projects");
          await NodeFSP.rename(replacementProjects, projects);
          await NodeFSP.writeFile(NodePath.join(projects, "new.jsonl"), claudeLine(2, 7));
        });
        const recreated = yield* afterRootCleanup.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(recreated), 12);
        assert.deepStrictEqual(
          recreated.sources.find((source) => source.fingerprint.provider === "claude")?.fingerprint,
          firstClaudeSource?.fingerprint,
        );

        const merged = mergeUsage(
          [
            {
              environmentId: EnvironmentId.make("cleanup-test"),
              label: "test",
              summary: recreated,
            },
            {
              environmentId: EnvironmentId.make("other-environment"),
              label: "before cleanup",
              summary: first,
            },
          ],
          missingRoot.contractVersion,
        );
        assert.strictEqual(merged.outputTokens, 12);
        assert.strictEqual(merged.sessions, 1);
        assert.strictEqual(merged.costUsd, recreated.buckets[0]?.costUsd);

        const outsideWindow = yield* restarted.readSummary({
          ...WINDOW,
          sinceDay: UsageDay.make("2026-08-02"),
        });
        assert.deepStrictEqual(outsideWindow.buckets, []);
        assert.strictEqual(outsideWindow.sources[0]?.distinctSessions, 0);
      }).pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-cleanup-test",
            home,
            settings: { providers: { ...settings.providers, claudeAgent: { homePath: alias } } },
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("does not share an in-flight scan after custom prices change", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const fileSystem = yield* FileSystem.FileSystem;
        const canonicalClaudeProjects = yield* Effect.promise(() =>
          NodeFSP.realpath(NodePath.join(home, "claude", "projects")),
        );
        const firstScanStarted = yield* Deferred.make<void>();
        const releaseRates = yield* Deferred.make<void>();
        let homeProbes = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            exists: (path) =>
              fileSystem.exists(path).pipe(
                Effect.tap(() => {
                  if (path !== canonicalClaudeProjects) return Effect.void;
                  homeProbes += 1;
                  return homeProbes === 1
                    ? Deferred.succeed(firstScanStarted, undefined)
                    : Effect.void;
                }),
              ),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Deferred.await(releaseRates).pipe(
                Effect.as(HttpClientResponse.fromWeb(request, Response.json({}))),
              ),
            ),
          ),
        );

        const first = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(firstScanStarted);
        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const second = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.succeed(releaseRates, undefined);

        const original = yield* Fiber.join(first);
        const updated = yield* Fiber.join(second);
        assert.strictEqual(homeProbes, 2);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.closeTo(updated.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
      }).pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-price-race-test", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("shares one scan between concurrent identical requests", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-flight-test",
            home,
            settings,
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const [first, second] = yield* Effect.all(
        [service.readSummary(WINDOW), service.readSummary(WINDOW)],
        { concurrency: 2 },
      );
      assert.deepStrictEqual(first, second);
      assert.strictEqual(ratesFetches, 1);

      // A later request is fresh work again, not a stale cached answer.
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 2);
    }).pipe(Effect.scoped),
  );

  it.live("refetches a rate table inside its TTL only when the client asks", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));

      let ratesFetches = 0;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-rates-refresh-test",
            home,
            settings,
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
            onRatesFetch: () => {
              ratesFetches += 1;
            },
          }),
        ),
      );

      const first = yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);
      assert.strictEqual(first.pricing.status, "fresh");

      // Inside the daily TTL a plain rescan keeps the cached table.
      yield* TestClock.adjust(Duration.minutes(2));
      yield* service.readSummary(WINDOW);
      assert.strictEqual(ratesFetches, 1);

      // An explicit refresh fetches again so a newly listed model gets priced.
      // A burst of refreshes shares that one fetch.
      const [refreshed] = yield* Effect.all([service.refreshRates, service.refreshRates], {
        concurrency: 2,
      });
      assert.strictEqual(ratesFetches, 2);
      assert.strictEqual(refreshed.status, "fresh");
      assert.strictEqual(refreshed.knownModels, 1);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("does not orphan an in-flight scan when its first caller is interrupted", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({ prefix: "usage-service-interruption-test", home, settings }),
        ),
      );

      let orphanedAt: number | undefined;
      for (let interruptAt = 1; interruptAt <= 31; interruptAt += 1) {
        const tasks: Array<() => void> = [];
        const dispatcher: Scheduler.SchedulerDispatcher = {
          scheduleTask: (task) => tasks.push(task),
          flush: () => {
            let task: (() => void) | undefined;
            while ((task = tasks.shift()) !== undefined) task();
          },
        };

        let requestFiber: Fiber.Fiber<unknown, unknown> | undefined;
        let requestChecks = 0;
        const scheduler: Scheduler.Scheduler = {
          executionMode: "async",
          makeDispatcher: () => dispatcher,
          shouldYield: (fiber) => {
            if (fiber !== requestFiber) return false;
            requestChecks += 1;
            if (requestChecks !== interruptAt) return false;
            fiber.interruptUnsafe();
            return true;
          },
        };

        // Each candidate needs a distinct key because the broken case leaves
        // its entry in the service's private in-flight map. The invalid window
        // keeps the real scan synchronous once its detached fiber starts.
        const input: UsageSummaryInput = {
          ...WINDOW,
          sinceDay: UsageDay.make("2026-09-01"),
          untilDay: UsageDay.make(`2026-08-${String(interruptAt).padStart(2, "0")}`),
        };
        const first = yield* service
          .readSummary(input)
          .pipe(
            Effect.exit,
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkChild,
          );
        requestFiber = first;
        yield* Effect.yieldNow;
        dispatcher.flush();

        const second = yield* service.readSummary(input).pipe(
          Effect.match({
            onFailure: (error) => error.reason,
            onSuccess: () => "success" as const,
          }),
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        dispatcher.flush();
        const secondExit = second.pollUnsafe();
        if (secondExit === undefined) {
          second.interruptUnsafe();
          orphanedAt = interruptAt;
          break;
        }
        if (Exit.isFailure(secondExit)) {
          assert.fail("the matching request fiber was interrupted");
        }
        assert.strictEqual(secondExit.value, "invalidWindow");
      }

      assert.isUndefined(
        orphanedAt,
        `interruption left the next matching request pending at scheduler check ${orphanedAt}`,
      );
    }).pipe(Effect.scoped),
  );
});
