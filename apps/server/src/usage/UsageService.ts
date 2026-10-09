/**
 * UsageService - scans provider transcripts and returns priced usage buckets.
 *
 * The scan reads native session files and databases, including work driven
 * outside T3 Code. Cursor's local records provide only partial coverage.
 *
 * JSONL transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed, and a file that merely grew resumes
 * from its cached parse position so only the appended bytes are read.
 * OpenCode's SQLite reader queries the live database each scan so WAL writes
 * remain visible. Antigravity databases are memoised in memory while the
 * database and its WAL keep the same `(size, mtime, ctime)`.
 *
 * Cursor's account API is slow, so its source answers from a cache and marks
 * itself `refreshing` while a background refresh runs; `awaitRefresh` waits
 * for that refresh instead. See `cursorAccountCache`.
 *
 * @module UsageService
 */
import * as NodeOS from "node:os";

import {
  ClaudeSettings,
  CodexSettings,
  USAGE_CONTRACT_VERSION,
  type ServerSettings as ServerSettingsValue,
  type UsageProviderKind,
  type UsageSource,
  type UsagePricing,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/http";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeConfigDirPath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import { readOpenCodeUsage } from "./opencodeUsageReader.ts";
import { makeAntigravityUsageCache, readAntigravityUsage } from "./antigravityUsageReader.ts";
import {
  CURSOR_ACCOUNT_CACHE_FILE_NAME,
  CURSOR_ACCOUNT_TTL_MS,
  cursorFetchRange,
  decodeCursorAccountCaches,
  encodeCursorAccountCaches,
  isCursorCacheFresh,
  mergeCursorFetch,
  type CursorAccountCache,
  type CursorCredentialSource,
} from "./cursorAccountCache.ts";
import * as CursorUsageReader from "./cursorUsageReader.ts";
import { resolveModelAliases, UsageAggregator } from "./usageAggregation.ts";
import { createOverrideRateTable, parseRateTable, type RateTable } from "./usagePricing.ts";
import {
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
} from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  LEGACY_SCAN_CACHE_FILE_NAMES,
  makeScanCacheWriter,
  pruneScanCache,
  SCAN_CACHE_FILE_NAME,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

/** An explicit refresh ignores the TTL, but not a table fetched this recently. */
const RATES_REFRESH_FLOOR_MS = 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The longest window the UI offers, 90 days, plus its `MTIME_SLACK_MS`, rounded
 * up. Older entries are pruned.
 */
const CACHE_RETENTION_DAYS = 92;

const CURSOR_ACCOUNT_READ_ERROR = "Cursor account usage could not be read.";

/** Transcripts parsed at once. More gains little once the disk stays busy. */
const TRANSCRIPT_READ_CONCURRENCY = 4;

/** On-disk shape of the rate snapshot. */
const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);

/** The scan cache is narrowed by hand in `usageScanCache`, so JSON is enough here. */
const ScanCacheJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeUsageRecordKey = Schema.encodeSync(ScanCacheJson);
const CachedSource = Schema.Struct({ dir: Schema.String, volumeId: Schema.String });

/** Whether `a` read a later state of its file than `b`. Transcripts only grow. */
function isLaterRead(a: CachedFile, b: CachedFile): boolean {
  return a.mtimeMs > b.mtimeMs || (a.mtimeMs === b.mtimeMs && a.size > b.size);
}

/**
 * Codex sessions with records in more than one file, such as a rollout that
 * moved after it was read. Only these need cross-file dedupe keys: within one
 * file the occurrence count already keeps every key unique, so keying the rest
 * would only build and hash a string for each of their records.
 */
function sharedCodexSessions(
  files: readonly { readonly records: readonly UsageRecord[] }[],
): ReadonlySet<string> {
  const firstFile = new Map<string, number>();
  const shared = new Set<string>();
  for (const [index, file] of files.entries()) {
    let previous = "";
    for (const { provider, sessionId } of file.records) {
      if (provider !== "codex" || sessionId === previous || sessionId.length === 0) continue;
      previous = sessionId;
      const first = firstFile.get(sessionId);
      if (first === undefined) firstFile.set(sessionId, index);
      else if (first !== index) shared.add(sessionId);
    }
  }
  return shared;
}
const decodeCachedSources = Schema.decodeUnknownOption(
  Schema.Struct({ sources: Schema.Record(Schema.String, CachedSource) }),
);

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    /** Refetches the rate table ahead of its TTL. See `ensureRates`. */
    readonly refreshRates: Effect.Effect<UsagePricing>;
  }
>()("t3/usage/UsageService") {}

const EMPTY_PRICING: UsagePricing = {
  status: "unavailable",
  source: LITELLM_RATES_URL,
  fetchedAt: null,
  knownModels: 0,
};

/** Empty summary, for suites that only need the RPC surface to resolve. */
const layerTest = Layer.succeed(
  UsageService,
  UsageService.of({
    readSummary: (input) =>
      Effect.succeed({
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: [],
        sources: [],
        pricing: EMPTY_PRICING,
        scanDurationMs: 0,
      }),
    refreshRates: Effect.succeed(EMPTY_PRICING),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const cursorAccountReader = yield* CursorUsageReader.CursorAccountReader;

  const fileCache: ScanCache = new Map();
  const antigravityCache = makeAntigravityUsageCache();
  const sourceCache = new Map<string, typeof CachedSource.Type>();
  let cacheDirty = false;
  /**
   * One scan at a time.
   *
   * `fileCache` and `cacheDirty` are plain mutable state shared by every
   * caller, and a scan interleaves at each `yield*`. Two concurrent scans over
   * the same window would each walk and re-parse the very files the other is
   * populating the cache with. Cursor account refreshes and cache writes run
   * detached and never take this lock, so a scan awaiting a refresh cannot
   * deadlock on it.
   */
  const scanMutex = yield* Semaphore.make(1);
  /** Cursor account caches by credential source. */
  const cursorCaches = new Map<string, CursorAccountCache>();
  let cursorCacheDirty = false;
  /**
   * The last failed refresh per credential source, standing for a TTL so a
   * client refetching a broken login does not refetch Cursor each time. A
   * `null` error means there is no login: no source to report. Fork: `missing`
   * keeps a missing login apart from an unreadable one, which reports partial,
   * and `accountKey` keeps the identity of an account whose usage failed.
   */
  const cursorFailures = new Map<
    string,
    {
      readonly atMs: number;
      readonly error: string | null;
      readonly missing: boolean;
      readonly accountKey: string | null;
    }
  >();
  /** The refresh in flight per credential source, which every read joins. */
  const cursorRefreshes = new Map<string, Deferred.Deferred<void>>();
  const isWithinDirectory = (filePath: string, dir: string) => {
    const relative = path.relative(dir, filePath);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, SCAN_CACHE_FILE_NAME);
  const legacyScanCachePaths = LEGACY_SCAN_CACHE_FILE_NAMES.map((name) =>
    path.join(config.stateDir, name),
  );
  const cursorCachePath = path.join(config.stateDir, CURSOR_ACCOUNT_CACHE_FILE_NAME);
  const writeCacheFile = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsagePricing["status"] = "unavailable";
  // One fetch at a time. A burst of refreshes from several clients waits on
  // the first fetch and then sees a table young enough to skip its own.
  const ratesLock = yield* Semaphore.make(1);

  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source: LITELLM_RATES_URL,
    fetchedAt:
      ratesFetchedAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
    knownModels: rates.size,
  });

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing. `force` refetches inside the TTL so a model that
   * LiteLLM added since the last fetch gets priced now.
   */
  const loadRates = Effect.fn("UsageService.loadRates")(function* (force: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return;

    if (ratesFetchedAtMs === null) {
      const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
        Effect.flatMap((raw) => decodeRatesCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk !== null) {
        const parsed = parseRateTable(fromDisk.document);
        if (parsed.size > 0) {
          rates = parsed;
          ratesFetchedAtMs = fromDisk.fetchedAtMs;
          ratesStatus = "cached";
          if (now - fromDisk.fetchedAtMs < maxAgeMs) return;
        }
      }
    }

    const fetched = yield* httpClient.get(LITELLM_RATES_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(10_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fetched === null) {
      // The refresh failed; whatever we are serving is now past its TTL and
      // must not keep claiming to be fresh.
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    const parsed = parseRateTable(fetched);
    if (parsed.size === 0) return;

    rates = parsed;
    ratesFetchedAtMs = now;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched }).pipe(
      Effect.flatMap((contents) => writeCacheFile(ratesCachePath, contents)),
      Effect.ignoreCause,
    );
  });

  const ensureRates = (force: boolean) => ratesLock.withPermit(loadRates(force));

  const refreshRates = ensureRates(true).pipe(
    Effect.map(pricing),
    Effect.withSpan("UsageService.refreshRates"),
  );

  interface TranscriptDir {
    readonly provider: UsageProviderKind;
    readonly dir: string;
    readonly volumeId: string;
    /** Restricts the walk to one filename; Grok keeps unrelated logs alongside. */
    readonly fileName?: string | undefined;
  }

  const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
  const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

  // A settings failure must surface as an error. Swallowing it would silently
  // discard custom rates and configured transcript homes.
  const readSettings = settingsService.getSettings.pipe(
    Effect.catchCause(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Server settings could not be read.",
          cause: Cause.squash(cause),
        }),
    ),
  );

  /** Resolves every configured provider instance to its transcript roots. */
  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* (
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
  ) {
    const roots = new Map<string, TranscriptDir>();
    const addRoot = Effect.fn(function* (
      provider: UsageProviderKind,
      root: string,
      fileName?: string,
    ) {
      const directory = path.resolve(root);
      const sourceKey = `${provider}\0${directory}`;
      const previous = sourceCache.get(sourceKey);
      const resolved = yield* fileSystem
        .realPath(directory)
        .pipe(Effect.orElseSucceed(() => previous?.dir ?? directory));
      const currentVolumeId = yield* Effect.promise(() => readDirectoryVolumeId(resolved));
      const hasRetainedHistory = fileCache
        .entries()
        .some(
          ([filePath, entry]) =>
            entry.provider === provider &&
            entry.mtimeMs >= retentionCutoffMs &&
            entry.records.length + entry.tailRecords.length > 0 &&
            isWithinDirectory(filePath, resolved),
        );
      const volumeId =
        previous?.dir === resolved && (hasRetainedHistory || currentVolumeId.length === 0)
          ? previous.volumeId || currentVolumeId
          : currentVolumeId;
      if (previous?.dir !== resolved || previous.volumeId !== volumeId) {
        sourceCache.set(sourceKey, { dir: resolved, volumeId });
        cacheDirty = true;
      }
      if (!roots.has(`${provider}\0${resolved}`)) {
        roots.set(`${provider}\0${resolved}`, { provider, dir: resolved, volumeId, fileName });
      }
    });

    const instances = deriveProviderInstanceConfigMap(settings);
    for (const instance of Object.values(instances)) {
      const environment = mergeProviderInstanceEnvironment(instance.environment, hostEnvironment);
      if (instance.driver === "claudeAgent") {
        const config = yield* decodeClaudeSettings(instance.config ?? {}).pipe(
          Effect.mapError(
            (cause) =>
              new UsageReadError({
                reason: "scanFailed",
                detail: "Claude provider settings could not be decoded.",
                cause: Cause.fail(cause),
              }),
          ),
        );
        const configDir = yield* resolveClaudeConfigDirPath(
          { homePath: config.homePath },
          environment,
        );
        // Shadow config dirs link `projects` back to this shared config dir.
        // Walking both paths would enumerate the same transcripts twice.
        yield* addRoot("claude", path.join(configDir, "projects"));
      } else if (instance.driver === "codex") {
        const config = yield* decodeCodexSettings(instance.config ?? {}).pipe(
          Effect.mapError(
            (cause) =>
              new UsageReadError({
                reason: "scanFailed",
                detail: "Codex provider settings could not be decoded.",
                cause: Cause.fail(cause),
              }),
          ),
        );
        const layout = yield* resolveCodexHomeLayout(config, environment);
        // Auth overlays link `sessions` into the shared home. The effective
        // home is credential-local, not an additional transcript source.
        yield* addRoot("codex", path.join(layout.sharedHomePath, "sessions"));
      } else if (instance.driver === "grok") {
        // Grok Settings only expose the binary path, so the home comes from the
        // environment: the instance's own `GROK_HOME` if it sets one, else the
        // host's, else `~/.grok`. Resolving per instance matches how the Grok
        // driver itself locates session files (see XAiAcpExtension).
        // Empty/whitespace GROK_HOME must fall back: coalescing alone would scan cwd.
        const grokEnvironment = mergeProviderInstanceEnvironment(
          instance.environment,
          hostEnvironment,
        );
        const grokHomeEnv = grokEnvironment["GROK_HOME"]?.trim() ?? "";
        // Same precedence the Claude and Codex roots use: an explicit home
        // wins, then the instance's own HOME, then the server's. An instance
        // that only overrides HOME still writes under it, so scanning the
        // server's home would report that instance as having no usage.
        const grokEnvironmentHome = grokEnvironment["HOME"]?.trim() ?? "";
        const grokHome =
          grokHomeEnv.length > 0
            ? path.resolve(expandHomePath(grokHomeEnv))
            : grokEnvironmentHome.length > 0
              ? path.join(path.resolve(grokEnvironmentHome), ".grok")
              : path.join(NodeOS.homedir(), ".grok");
        // Grok stores turn records in `updates.jsonl`; its sibling logs are
        // large and carry no usage, so the walk is pinned to that one name.
        yield* addRoot("grok", path.join(grokHome, "sessions"), "updates.jsonl");
      }
    }

    return [...roots.values()];
  });

  /**
   * Loads the persisted scan and Cursor account caches exactly once per process.
   *
   * `Effect.cached` makes concurrent first readers await the same load rather
   * than each seeing a "loaded" flag set before the read finished and cold
   * scanning against an empty cache.
   */
  const ensureScanCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const readDocument = (filePath: string) =>
        fileSystem.readFileString(filePath).pipe(
          Effect.flatMap((raw) => decodeScanCacheFile(raw)),
          Effect.catchCause(() => Effect.succeed(null)),
        );
      for (const [key, cache] of decodeCursorAccountCaches(yield* readDocument(cursorCachePath))) {
        cursorCaches.set(key, cache);
      }
      const current = yield* readDocument(scanCachePath);
      // Without a cache of its own, migrate whatever older builds left. Both
      // legacy files can exist; where both saved one transcript, the later
      // read wins.
      const documents =
        current === null ? yield* Effect.forEach(legacyScanCachePaths, readDocument) : [current];
      for (const document of documents) {
        if (document === null) continue;
        // Write the migrated cache to its own file on the next scan.
        if (document !== current) cacheDirty = true;
        for (const [path, entry] of decodeScanCache(document)) {
          const existing = fileCache.get(path);
          if (existing === undefined || isLaterRead(entry, existing)) fileCache.set(path, entry);
        }
        const sources = decodeCachedSources(document);
        if (Option.isSome(sources)) {
          for (const [key, source] of Object.entries(sources.value.sources))
            if (!sourceCache.has(key)) sourceCache.set(key, source);
        }
      }
    }),
  );

  const writeScanCache = makeScanCacheWriter();
  // Scans with different windows can finish together; serializing the writes
  // keeps an older snapshot from landing after a newer one.
  const persistLock = yield* Semaphore.make(1);

  // Each dirty flag is cleared before encoding, so a change while the write is
  // in flight marks it dirty again. A failed write restores the flag, so the
  // next persist retries instead of leaving disk stale. A cache we cannot
  // write is a slower next start, not a failed read.
  const persistCaches = Effect.gen(function* () {
    if (cacheDirty) {
      cacheDirty = false;
      yield* Effect.sync(() =>
        writeScanCache(fileCache, { sources: Object.fromEntries(sourceCache) }),
      ).pipe(
        Effect.flatMap((contents) => writeCacheFile(scanCachePath, contents)),
        Effect.catchCause(() =>
          Effect.sync(() => {
            cacheDirty = true;
          }),
        ),
      );
    }
    if (cursorCacheDirty) {
      cursorCacheDirty = false;
      yield* Effect.sync(() => encodeCursorAccountCaches(cursorCaches)).pipe(
        Effect.flatMap((contents) => writeCacheFile(cursorCachePath, contents)),
        Effect.catchCause(() =>
          Effect.sync(() => {
            cursorCacheDirty = true;
          }),
        ),
      );
    }
  }).pipe(persistLock.withPermit, Effect.withSpan("UsageService.persistCaches"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  /** Writes dirty caches in the background, after the summary that dirtied them answers. */
  const schedulePersist = Effect.forkDetach(persistCaches).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  /** Waits for every write scheduled so far, as a restart would need. */
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  // A write still running when the service shuts down finishes first, so the
  // next start does not lose the last scan.
  yield* Effect.addFinalizer(() => awaitPersisted);

  /** What one transcript contributed to the scan. */
  interface FileScanResult {
    readonly records: readonly UsageRecord[];
    readonly malformedRecords: number;
    /**
     * The file exists but could not be read. Distinct from an empty result:
     * the scan is understated by however much this file held, and the source
     * has to report that rather than call it "no usage".
     */
    readonly unreadable: boolean;
  }

  /**
   * Parses one transcript, reusing the cached result when it is unchanged.
   *
   * A file that only grew re-parses from the cached position, so an actively
   * written multi-hundred-megabyte rollout costs its appended bytes per scan
   * rather than a full re-read. The reader verifies the position's guard bytes
   * and silently restarts from byte 0 when they no longer match.
   *
   * A fresh parse comes back as `update` for the caller to cache, with the
   * entry it was built from. Reads run concurrently, and the caller stores
   * updates in walk order rather than completion order: saved records of
   * deleted transcripts aggregate in cache order, where the first copy of a
   * duplicate wins.
   */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
  ): Effect.Effect<
    FileScanResult & {
      readonly update?: { readonly entry: CachedFile; readonly replaces: CachedFile | undefined };
    }
  > =>
    Effect.gen(function* () {
      const cached = fileCache.get(filePath);
      // Provider is part of the identity: if both providers were ever pointed
      // at one directory, a hit parsed by the other parser must not be reused.
      if (
        cached &&
        !cached.requiresReparse &&
        cached.size === size &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === provider
      ) {
        return {
          records:
            cached.tailRecords.length === 0
              ? cached.records
              : [...cached.records, ...cached.tailRecords],
          malformedRecords: cached.malformedRecords + cached.tailMalformedRecords,
          unreadable: false,
        };
      }

      // Only a strictly grown file may resume. Same size with a new mtime, or
      // a shrunken file, means rewritten content; re-parse it whole.
      const resumeFrom =
        cached !== undefined &&
        !cached.requiresReparse &&
        cached.provider === provider &&
        size > cached.size
          ? cached.position
          : undefined;

      const parsed = yield* Effect.promise(() =>
        readTranscriptRecords(filePath, provider, resumeFrom),
      );
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      // Migrated history (requiresReparse) is exactly this fallback; the flag
      // only stops it from serving warm hits or resuming a parse.
      if (parsed === null) {
        return {
          records: cached?.provider === provider ? [...cached.records, ...cached.tailRecords] : [],
          malformedRecords:
            cached?.provider === provider
              ? cached.malformedRecords + cached.tailMalformedRecords
              : 0,
          unreadable: true,
        };
      }

      // One seen set spans the cached base, the new lines, and the tail so a
      // resumed parse dedupes exactly like a full one. The previous tail is not
      // part of the base because the reader deliberately re-reads it.
      const resumedFromCache = parsed.resumed && cached !== undefined;
      const baseRecords = resumedFromCache ? cached.records : [];
      const seen = new Set<string>();
      const records = dedupeWithinFile([...baseRecords, ...parsed.records], seen);
      const tailRecords = dedupeWithinFile(parsed.tailRecords, seen);
      const malformedRecords =
        (resumedFromCache ? cached.malformedRecords : 0) + parsed.malformedRecords;

      return {
        records: tailRecords.length === 0 ? records : [...records, ...tailRecords],
        malformedRecords: malformedRecords + parsed.tailMalformedRecords,
        unreadable: false,
        update: {
          entry: {
            size,
            mtimeMs,
            provider,
            records,
            malformedRecords,
            tailRecords,
            tailMalformedRecords: parsed.tailMalformedRecords,
            position: parsed.position,
          },
          replaces: cached,
        },
      };
    });

  /** One provider directory's walk and parse, before rates are involved. */
  interface ScannedFile extends FileScanResult {
    readonly path: string;
  }

  interface ScannedDir {
    readonly provider: UsageProviderKind;
    readonly dir: string;
    readonly volumeId: string;
    readonly hostId?: string;
    readonly status?: UsageSource["status"];
    readonly message?: string;
    readonly action?: UsageSource["action"];
    /** Parsed records per file, or `null` when the directory does not exist. */
    readonly files: readonly ScannedFile[] | null;
    /** Answered from a cache while a refresh runs. */
    readonly refreshing?: true;
  }

  // These readers report read errors only, not malformed-record counts.
  const cacheReaderFiles = (
    provider: UsageProviderKind,
    files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[],
    unreadable: boolean,
    now: number,
  ): ScannedFile[] =>
    files.map((file) => {
      const cached = fileCache.get(file.path);
      const recordsByKey = new Map<string, UsageRecord>();
      for (const record of [
        ...(cached?.provider === provider ? [...cached.records, ...cached.tailRecords] : []),
        ...file.records,
      ]) {
        recordsByKey.set(record.dedupeKey ?? encodeUsageRecordKey(record), record);
      }
      const records = [...recordsByKey.values()];
      fileCache.set(file.path, {
        provider,
        size: 0,
        mtimeMs: now,
        records,
        malformedRecords: 0,
        tailRecords: [],
        tailMalformedRecords: 0,
        position: { resumeOffset: 0, guardLength: 0, guardHash: 0, codexState: null },
      });
      cacheDirty = true;
      return { path: file.path, records, malformedRecords: 0, unreadable };
    });

  const readerSource = Effect.fnUntraced(function* (
    provider: UsageProviderKind,
    root: string,
    candidate = root,
  ) {
    const key = `${provider}\0${root}`;
    const previous = sourceCache.get(key);
    const dir = yield* fileSystem
      .realPath(candidate)
      .pipe(Effect.orElseSucceed(() => previous?.dir ?? candidate));
    const currentVolumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
    const volumeId =
      previous !== undefined && previous.dir === dir
        ? previous.volumeId || currentVolumeId
        : currentVolumeId;
    if (previous === undefined || previous.dir !== dir || previous.volumeId !== volumeId) {
      sourceCache.set(key, { dir, volumeId });
      cacheDirty = true;
    }
    return { dir, volumeId };
  });

  /**
   * Walks and parses one transcript root. Returns `null` when another root
   * already claimed the same filesystem identity (`seenRootIdentities`).
   */
  const scanTranscriptDir = Effect.fn("UsageService.scanTranscriptDir")(function* (
    source: TranscriptDir,
    windowStartMs: number,
    seenRootIdentities: Set<string>,
  ) {
    const { provider, dir, volumeId, fileName } = source;
    const exists = yield* fileSystem
      .exists(dir)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    if (!exists) return { provider, dir, volumeId, files: null } satisfies ScannedDir;
    if (volumeId.length > 0) {
      const rootIdentity = `${provider}\0${volumeId}`;
      if (seenRootIdentities.has(rootIdentity)) return null;
      seenRootIdentities.add(rootIdentity);
    }
    const files = yield* Effect.promise(() =>
      listTranscriptFiles(dir, windowStartMs, fileName === undefined ? undefined : { fileName }),
    );
    // A cold parse waits on disk reads, so a few files in flight read
    // close to twice as fast. Results keep walk order.
    const read = yield* Effect.forEach(
      files,
      (file) =>
        readFileRecords(file.path, file.size, file.mtimeMs, provider).pipe(
          Effect.map((result) => ({ path: file.path, ...result })),
        ),
      { concurrency: TRANSCRIPT_READ_CONCURRENCY },
    );
    const parsedFiles = read.map(({ update, ...file }): ScannedFile => {
      if (update === undefined) return file;
      // A scan of another window may have cached its own read of this file
      // meanwhile. Then keep whichever read saw the later file, so a slower
      // scan never replaces newer usage with older.
      const current = fileCache.get(file.path);
      if (
        current === update.replaces ||
        current === undefined ||
        !isLaterRead(current, update.entry)
      ) {
        fileCache.set(file.path, update.entry);
        cacheDirty = true;
      }
      return file;
    });
    return { provider, dir, volumeId, files: parsedFiles } satisfies ScannedDir;
  });

  /** Fetches what one account cache is missing, then persists it if anything changed. */
  const refreshCursorAccount = Effect.fn("UsageService.refreshCursorAccount")(function* (
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const fetchMissing = (cache: CursorAccountCache | undefined) => {
      const range = cursorFetchRange(cache, retentionStartMs, nowMs);
      return cursorAccountReader
        .read(credential, range.sinceMs, range.untilMs)
        .pipe(Effect.map((result) => ({ range, result })));
    };
    let base = cursorCaches.get(credentialKey);
    let fetched = yield* fetchMissing(base);
    // Another login's history replaces the cached account's, even if reading it fails.
    if (
      base !== undefined &&
      fetched.result.accountKey !== null &&
      fetched.result.accountKey !== base.accountKey
    ) {
      cursorCaches.delete(credentialKey);
      cursorCacheDirty = true;
      base = undefined;
      fetched = yield* fetchMissing(base);
    }
    const { range, result } = fetched;
    if (result.missing || result.error !== null || result.accountKey === null) {
      cursorFailures.set(credentialKey, {
        atMs: nowMs,
        error: result.missing || result.error !== null ? result.error : CURSOR_ACCOUNT_READ_ERROR,
        missing: result.missing,
        accountKey: result.accountKey,
      });
      yield* schedulePersist;
      return;
    }
    const merged = mergeCursorFetch(
      base,
      result.accountKey,
      range,
      result.records,
      nowMs,
      retentionStartMs,
    );
    cursorCaches.set(credentialKey, merged.cache);
    cursorFailures.delete(credentialKey);
    // An unchanged edge is not worth rewriting the file for: after a restart
    // the cache just refetches a slightly wider edge.
    if (merged.changed) {
      cursorCacheDirty = true;
      yield* schedulePersist;
    }
  });

  /** Joins the refresh in flight, or starts one. */
  const startCursorRefresh = (
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) =>
    // Enrollment and fork are atomic, so an interrupted caller cannot leave a
    // registered refresh that nothing will finish.
    Effect.uninterruptible(
      Effect.gen(function* () {
        const current = cursorRefreshes.get(credentialKey);
        if (current !== undefined) return current;
        const done = Deferred.makeUnsafe<void>();
        cursorRefreshes.set(credentialKey, done);
        // Detached: a departing client must not cancel a fetch later reads reuse.
        // It never takes `scanMutex`, so a scan awaiting it cannot deadlock.
        yield* refreshCursorAccount(credential, credentialKey, retentionStartMs).pipe(
          Effect.catchCause(() =>
            Clock.currentTimeMillis.pipe(
              Effect.map((atMs) =>
                cursorFailures.set(credentialKey, {
                  atMs,
                  error: CURSOR_ACCOUNT_READ_ERROR,
                  missing: false,
                  accountKey: null,
                }),
              ),
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              cursorRefreshes.delete(credentialKey);
              return Deferred.succeed(done, undefined);
            }),
          ),
          Effect.forkDetach,
        );
        return done;
      }),
    );

  /**
   * The Cursor account source. A cache inside its TTL, or a refresh that failed
   * inside it, answers directly. Otherwise a refresh starts: `awaitRefresh`
   * waits for it, and anything else answers from the cache marked `refreshing`.
   */
  const cursorAccountSource = Effect.fn("UsageService.cursorAccountSource")(function* (
    credential: CursorCredentialSource,
    authPath: string,
    windowStartMs: number,
    retentionStartMs: number,
    awaitRefresh: boolean,
  ) {
    // No saved login means there is no account source to report, not a setup error.
    if (
      typeof credential === "string" &&
      !(yield* fileSystem.exists(credential).pipe(Effect.orElseSucceed(() => true)))
    ) {
      return null;
    }
    const credentialKey = typeof credential === "string" ? credential : "keychain";
    const nowMs = yield* Clock.currentTimeMillis;
    const recentFailure = cursorFailures.get(credentialKey);
    let refreshing = false;
    if (
      (recentFailure === undefined || nowMs - recentFailure.atMs >= CURSOR_ACCOUNT_TTL_MS) &&
      !isCursorCacheFresh(cursorCaches.get(credentialKey), nowMs)
    ) {
      const refresh = yield* startCursorRefresh(credential, credentialKey, retentionStartMs);
      if (awaitRefresh) yield* Deferred.await(refresh);
      else refreshing = true;
    }

    const cache = cursorCaches.get(credentialKey);
    const failure = refreshing ? undefined : cursorFailures.get(credentialKey);
    const failureMessage = failure === undefined ? undefined : failure.error;
    if (failureMessage === null) return null;
    // Fork: the account identity outlives a failed read, as it did before the
    // account cache existed.
    const identityKey = `cursor\0${authPath}`;
    if (cache === undefined) {
      // Fork: account history saved by builds before the account cache lives in
      // the scan cache. Report it under its stable identity, as retained
      // history rather than a fetched range, until a refresh succeeds.
      const legacy = sourceCache.get(identityKey);
      const accountKey =
        failure?.missing === true
          ? null
          : (failure?.accountKey ??
            (legacy?.dir.startsWith("cursor-account:") === true ? legacy.volumeId : null));
      if (accountKey !== null) {
        const source = `cursor-account:${accountKey}`;
        if (legacy?.dir !== source || legacy.volumeId !== accountKey) {
          sourceCache.set(identityKey, { dir: source, volumeId: accountKey });
          cacheDirty = true;
        }
        const retained = fileCache.get(source);
        return {
          provider: "cursor",
          dir: source,
          hostId: "cursor.com",
          volumeId: accountKey,
          files:
            retained?.provider === "cursor"
              ? [
                  {
                    path: source,
                    records: [...retained.records, ...retained.tailRecords].filter(
                      (record) => record.timestampMs >= windowStartMs,
                    ),
                    malformedRecords: 0,
                    unreadable: false,
                  },
                ]
              : [],
          ...(refreshing
            ? { refreshing: true }
            : { status: "partial", message: failureMessage ?? CURSOR_ACCOUNT_READ_ERROR }),
        } satisfies ScannedDir;
      }
      return {
        provider: "cursor",
        dir: authPath,
        volumeId: yield* Effect.promise(() => readDirectoryVolumeId(authPath)),
        // Never combine a local fallback with another server's account-wide history.
        ...(refreshing
          ? { files: [], refreshing: true }
          : {
              files: null,
              // Fork: an unreadable saved login is partial, not missing.
              ...(failure?.missing === true ? {} : { status: "partial" }),
              message: failureMessage ?? CURSOR_ACCOUNT_READ_ERROR,
            }),
      } satisfies ScannedDir;
    }
    // The same account includes CLI and desktop history from every machine.
    // A stable remote fingerprint prevents connected environments counting it twice.
    const source = `cursor-account:${cache.accountKey}`;
    const identity = sourceCache.get(identityKey);
    if (identity?.dir !== source || identity.volumeId !== cache.accountKey) {
      sourceCache.set(identityKey, { dir: source, volumeId: cache.accountKey });
      cacheDirty = true;
    }
    return {
      provider: "cursor",
      dir: source,
      hostId: "cursor.com",
      volumeId: cache.accountKey,
      files: [
        {
          path: source,
          records: cache.records.filter((record) => record.timestampMs >= windowStartMs),
          malformedRecords: 0,
          unreadable: false,
        },
      ],
      ...(failureMessage === undefined
        ? { status: "ok" }
        : { status: "partial", message: failureMessage }),
      ...(refreshing ? { refreshing: true } : {}),
    } satisfies ScannedDir;
  });

  const collectDirs = Effect.fn("UsageService.collectDirs")(function* (
    windowStartMs: number,
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
    awaitRefresh: boolean,
  ) {
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so the scan stays context-free.
    const dirs = yield* resolveTranscriptDirs(settings, retentionCutoffMs).pipe(
      Effect.provideService(Path.Path, path),
    );
    // Shared by every source kind; identities are provider-scoped.
    const seenRootIdentities = new Set<string>();

    const now = yield* Clock.currentTimeMillis;
    const home = NodeOS.homedir();
    const envRoots = (key: string, defaults: readonly string[]) => {
      const roots = hostEnvironment[key]
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      return [
        ...new Set(
          (roots?.length ? roots : defaults).map((root) => path.resolve(expandHomePath(root))),
        ),
      ];
    };
    const dataHome = hostEnvironment["XDG_DATA_HOME"]?.trim();

    const transcripts = Effect.gen(function* () {
      const scanned: ScannedDir[] = [];
      for (const dir of dirs) {
        const result = yield* scanTranscriptDir(dir, windowStartMs, seenRootIdentities);
        if (result !== null) scanned.push(result);
      }
      return scanned;
    });

    const openCode = Effect.gen(function* () {
      const scanned: ScannedDir[] = [];
      for (const root of envRoots("OPENCODE_DATA_DIR", [
        path.join(
          dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(home, ".local", "share"),
          "opencode",
        ),
      ])) {
        const { dir, volumeId } = yield* readerSource("opencode", root);
        const identity = `opencode\0${volumeId || dir}`;
        if (seenRootIdentities.has(identity)) continue;
        seenRootIdentities.add(identity);
        const result = yield* Effect.promise(() => readOpenCodeUsage(dir, windowStartMs)).pipe(
          Effect.catchCause(() => Effect.succeed({ files: [], missing: false, error: true })),
        );
        scanned.push({
          provider: "opencode",
          dir,
          volumeId,
          files:
            result.missing && !result.error
              ? null
              : cacheReaderFiles("opencode", result.files, result.error, now),
          status: result.error ? "partial" : "ok",
          ...(result.error ? { message: "Some OpenCode history could not be read." } : {}),
        });
      }
      return scanned;
    });

    const antigravity = Effect.gen(function* () {
      const antigravityRoots = envRoots("ANTIGRAVITY_DATA_DIR", [
        ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map((name) =>
          path.join(home, ".gemini", name),
        ),
        path.join(home, ".config", "antigravity"),
      ]);
      const antigravityDirs = new Map<string, string>();
      for (const root of antigravityRoots) {
        const nested = path.join(root, "conversations");
        const candidate = (yield* fileSystem.exists(nested).pipe(Effect.orElseSucceed(() => false)))
          ? nested
          : root;
        const { dir, volumeId } = yield* readerSource("antigravity", root, candidate);
        const identity = `antigravity\0${volumeId || dir}`;
        if (seenRootIdentities.has(identity)) continue;
        seenRootIdentities.add(identity);
        antigravityDirs.set(dir, volumeId);
      }
      const result = yield* Effect.promise(() =>
        readAntigravityUsage([...antigravityDirs.keys()], windowStartMs, antigravityCache),
      ).pipe(
        Effect.catchCause(() => Effect.succeed({ files: [], errors: [...antigravityDirs.keys()] })),
      );
      const scanned: ScannedDir[] = [];
      for (const [dir, volumeId] of antigravityDirs) {
        const exists = yield* fileSystem
          .exists(dir)
          .pipe(Effect.catchCause(() => Effect.succeed(false)));
        const failed = result.errors.some(
          (error) => error === dir || error.startsWith(`${dir}${path.sep}`),
        );
        scanned.push({
          provider: "antigravity",
          dir,
          volumeId,
          files:
            !exists && !failed
              ? null
              : cacheReaderFiles(
                  "antigravity",
                  result.files.filter((file) => file.root === dir),
                  failed,
                  now,
                ),
          status: failed ? "partial" : "ok",
          ...(failed ? { message: "Some Antigravity history could not be read." } : {}),
        });
      }
      return scanned;
    });

    const cursor = Effect.gen(function* () {
      const cursorUserHome =
        (platform === "win32" ? hostEnvironment["USERPROFILE"] : hostEnvironment["HOME"]) || home;
      const configHome = hostEnvironment["XDG_CONFIG_HOME"]?.trim();
      const cursorHome =
        platform === "darwin"
          ? path.join(cursorUserHome, "Library", "Application Support")
          : platform === "win32"
            ? hostEnvironment["APPDATA"] || path.join(cursorUserHome, "AppData", "Roaming")
            : configHome && path.isAbsolute(configHome)
              ? configHome
              : path.join(cursorUserHome, ".config");
      const cursorAuthPath =
        platform === "darwin"
          ? path.join(cursorUserHome, ".cursor", "auth.json")
          : path.join(cursorHome, platform === "win32" ? "Cursor" : "cursor", "auth.json");
      const credentialStore = hostEnvironment["AGENT_CLI_CREDENTIAL_STORE"];
      const loginUnavailable =
        Boolean(hostEnvironment["CURSOR_AUTH_TOKEN"]?.trim()) ||
        Boolean(hostEnvironment["CURSOR_API_KEY"]?.trim()) ||
        credentialStore === "memory";
      const useKeychain = platform === "darwin" && credentialStore !== "file";
      if (useKeychain && !loginUnavailable && !settings.cursorKeychainUsageEnabled) {
        return [
          {
            provider: "cursor",
            dir: cursorAuthPath,
            volumeId: "",
            files: null,
            message: "Cursor account usage is off on this environment.",
            action: "enableCursorKeychain",
          } satisfies ScannedDir,
        ];
      }
      if (loginUnavailable) {
        return [
          {
            provider: "cursor",
            dir: cursorAuthPath,
            volumeId: yield* Effect.promise(() => readDirectoryVolumeId(cursorAuthPath)),
            files: null,
            message: "Cursor account history needs a Cursor CLI login on this server.",
          } satisfies ScannedDir,
        ];
      }
      const source = yield* cursorAccountSource(
        useKeychain ? { kind: "keychain" } : cursorAuthPath,
        cursorAuthPath,
        windowStartMs,
        retentionCutoffMs,
        awaitRefresh,
      );
      return source === null ? [] : [source];
    });

    // Independent sources scan together. Transcript directories go one at a
    // time, so open files stay at `TRANSCRIPT_READ_CONCURRENCY`. The result
    // keeps this order, since aggregation keeps the first copy of a duplicate.
    const [transcriptDirs, openCodeDirs, antigravityDirs, cursorDirs] = yield* Effect.all(
      [transcripts, openCode, antigravity, cursor],
      { concurrency: "unbounded" },
    );
    const scanned: readonly ScannedDir[] = [
      ...transcriptDirs,
      ...openCodeDirs,
      ...antigravityDirs,
      ...cursorDirs,
    ];
    return scanned;
  });

  const scanSummary = Effect.fn("UsageService.scanSummary")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
  ) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage requires valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage window must be greater than zero and at most 24 hours",
        });
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureScanCacheLoaded;

    const hostId = NodeOS.hostname();
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    const retentionCutoffMs = startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    // Pricing only matters once records are aggregated, so the rate table
    // loads while transcripts stream instead of gating them: a cold rates
    // fetch on a slow network no longer delays the scan by its own timeout.
    const [, scannedDirs] = yield* Effect.all(
      [
        ensureRates(false),
        collectDirs(windowStartMs, settings, retentionCutoffMs, input.awaitRefresh === true),
      ],
      { concurrency: 2 },
    );

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
      modelAliases: resolveModelAliases(settings.usageModelAliases),
    });

    const sources: UsageSource[] = [];
    // Lexically distinct configured paths can still resolve to one directory
    // through symlinks. Keep only one source per provider and filesystem root.
    const seenRootIdentities = new Set<string>();

    // Cleanup may remove transcripts, but the usage we already saved still
    // contributes to its source through the normal aggregation and dedupe
    // path. Like the walk, skip files last written before the window: they
    // cannot hold records inside it.
    const retainedSinceMs = Math.max(windowStartMs, retentionCutoffMs);
    const filesByDir = scannedDirs.map(({ provider, dir, volumeId, files }) => {
      if (volumeId.length > 0) {
        const rootIdentity = `${provider}\0${volumeId}`;
        if (seenRootIdentities.has(rootIdentity)) return null;
        seenRootIdentities.add(rootIdentity);
      }
      const retainedFiles: ScannedFile[] = [...(files ?? [])];
      const livePaths = new Set(retainedFiles.map((file) => file.path));
      let retainedMissingFiles = 0;
      for (const [filePath, entry] of fileCache) {
        if (
          entry.provider !== provider ||
          entry.mtimeMs < retainedSinceMs ||
          livePaths.has(filePath) ||
          !isWithinDirectory(filePath, dir)
        )
          continue;
        retainedMissingFiles += 1;
        retainedFiles.push({
          path: filePath,
          records: [...entry.records, ...entry.tailRecords],
          malformedRecords: entry.malformedRecords + entry.tailMalformedRecords,
          unreadable: false,
        });
      }
      return { files: retainedFiles, retainedMissingFiles };
    });
    const sharedSessions = sharedCodexSessions(filesByDir.flatMap((dir) => dir?.files ?? []));

    for (const [
      index,
      { provider, dir, volumeId, files, status, message, action, refreshing, hostId: sourceHostId },
    ] of scannedDirs.entries()) {
      const retained = filesByDir[index];
      if (!retained) continue;
      const { retainedMissingFiles } = retained;
      let scannedFiles = 0;
      let skippedFiles = 0;
      let unreadableFiles = 0;
      let malformedRecords = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();

      for (const file of retained.files) {
        if (provider !== "grok") malformedRecords += file.malformedRecords;
        if (file.unreadable) {
          unreadableFiles += 1;
          if (file.records.length === 0) {
            skippedFiles += 1;
            continue;
          }
        }
        if (file.records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        const codexEventOccurrences = new Map<string, number>();
        for (const record of file.records) {
          let usageRecord = record;
          if (record.provider === "codex" && sharedSessions.has(record.sessionId)) {
            // Match moved rollout copies without collapsing repeated equal events
            // within one rollout (timestamps can have only second precision).
            // Only sessions seen in several files can have a copy to match.
            const key = encodeUsageRecordKey([
              record.provider,
              record.sessionId,
              record.timestampMs,
              record.model,
              record.totals,
            ]);
            const occurrence = (codexEventOccurrences.get(key) ?? 0) + 1;
            codexEventOccurrences.set(key, occurrence);
            usageRecord = { ...record, dedupeKey: key + ":" + occurrence };
          }
          // Only sessions contributing in-window count; the mtime slack can
          // admit boundary files whose records fall outside the range.
          if (aggregator.add(usageRecord, dir) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
      }

      sources.push({
        fingerprint: { hostId: sourceHostId ?? hostId, provider, resolvedHomePath: dir, volumeId },
        // Files that exist but would not open mean the totals below are a
        // floor, not a figure. Saying "ok" here would present an undercount as
        // a complete answer.
        status:
          unreadableFiles > 0 || status === "partial" || retainedMissingFiles > 0
            ? "partial"
            : files === null && scannedFiles === 0
              ? "missing"
              : (status ?? "ok"),
        scannedFiles,
        skippedFiles,
        malformedRecords,
        distinctSessions: sessionIds.size,
        ...(action ? { action } : {}),
        message:
          message ??
          (unreadableFiles > 0
            ? `${unreadableFiles} transcript ${unreadableFiles === 1 ? "file" : "files"} could not be read; saved usage is retained, but newer usage may be missing.`
            : retainedMissingFiles > 0
              ? "Some history is no longer available. Retained usage is shown from cache."
              : files === null
                ? "No transcript directory on this environment."
                : null),
        ...(refreshing ? { refreshing } : {}),
      });
    }

    const pruned = pruneScanCache(fileCache, retentionCutoffMs);
    if (pruned > 0) cacheDirty = true;

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      pricing: pricing(),
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  /**
   * In-flight scans are keyed by window and usage settings, so identical
   * requests (the usage page open on two clients at once) share one result.
   * The global mutex still serializes different keys because every scan
   * mutates the same file cache and dirty flag.
   */
  const inflightScans = new Map<string, Deferred.Deferred<UsageSummary, UsageReadError>>();

  const scanKey = (input: UsageSummaryInput, settings: ServerSettingsValue): string =>
    JSON.stringify([
      input.timeZone,
      input.sinceDay,
      input.untilDay,
      input.resolution ?? "day",
      input.sinceTime ?? null,
      input.untilTime ?? null,
      settings.usagePriceOverrides,
      settings.usageModelAliases,
      settings.cursorKeychainUsageEnabled,
      // A waiting read must never share a scan that answers with `refreshing`.
      input.awaitRefresh === true,
    ]);

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    const settings = yield* readSettings;
    const key = scanKey(input, settings);
    const deferred = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = inflightScans.get(key);
        if (existing !== undefined) return existing;

        // Enrollment and detached-fiber creation must be atomic. Otherwise a
        // canceled first caller can leave a Deferred with no scan to finish it.
        const created = Deferred.makeUnsafe<UsageSummary, UsageReadError>();
        inflightScans.set(key, created);
        // Detached so one departing client cannot tear the scan out from under
        // the fibers awaiting it; a finished scan warms the cache either way.
        // The cache write is registered before the waiters resume, so they
        // can await it, but its fiber starts after they have the summary.
        yield* scanMutex
          .withPermits(1)(scanSummary(input, settings))
          .pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => inflightScans.delete(key)).pipe(
                Effect.andThen(Exit.isSuccess(exit) ? schedulePersist : Effect.void),
                Effect.andThen(Deferred.done(created, exit)),
              ),
            ),
            Effect.forkDetach,
          );
        return created;
      }),
    );
    // Waiting stays interruptible. The detached scan continues for other
    // callers and still warms the cache if this caller leaves.
    return yield* Deferred.await(deferred);
  });

  // `awaitPersisted` is outside the service interface: tests use it to restart
  // against what a previous instance wrote.
  return { readSummary, refreshRates, awaitPersisted } as const;
});

export const layer = Layer.effect(UsageService, make);
