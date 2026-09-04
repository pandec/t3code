// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
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

function claudeLine(id: number, outputTokens: number): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model: "claude-fable-5",
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
}) =>
  ServerConfig.layerTest(process.cwd(), { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
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
      Layer.succeed(HostProcessEnvironment, { GROK_HOME: NodePath.join(input.home, "grok") }),
    ),
  );

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

describe("UsageService", () => {
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
