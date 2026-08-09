import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ProviderInstanceId, UsageDay } from "@t3tools/contracts";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { make as makeUsageService } from "./UsageService.ts";
import { decodeScanCache } from "./usageScanCache.ts";

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
              if (target === claudeTranscriptDir) events.push("scan:start");
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

        const usage = yield* makeUsageService.pipe(
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

        const scan = usage.readSummary({ sinceDay: today, untilDay: today, timeZone: "UTC" }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              events.push("scan:end");
            }),
          ),
        );

        const [first, second] = yield* Effect.all([scan, scan], { concurrency: "unbounded" });

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
        assert.isTrue(persisted.has(claudeTranscriptPath));
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

        const usage = yield* makeUsageService.pipe(
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

        assert.equal(claudeSources.length, 2);
        const overriddenSource = claudeSources.find(
          (source) => source.fingerprint.resolvedHomePath === claudeProjects,
        );
        assert.isDefined(overriddenSource);
        assert.equal(overriddenSource?.status, "ok");
        assert.isFalse(
          claudeSources.some(
            (source) => source.fingerprint.resolvedHomePath === claudeShadowProjects,
          ),
        );
        assert.equal(codexSources.length, 1);
        assert.equal(codexSources[0]?.fingerprint.resolvedHomePath, codexSessions);
        assert.notEqual(codexSources[0]?.fingerprint.resolvedHomePath, codexShadowSessions);
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

        const usage = yield* makeUsageService.pipe(
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
