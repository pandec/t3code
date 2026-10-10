/**
 * Durable per-file scan cache.
 *
 * Transcripts are append-only and a file that has not changed can never yield
 * different usage, so parsed records are keyed by `(size, mtime)` and reused.
 * Without this every server restart re-parses the whole window: roughly 3.5s
 * for a 30-day scan here, against ~11ms to reload this cache.
 *
 * Caching *per file* rather than per day is deliberate. It is timezone
 * independent, so changing the reporting zone does not invalidate anything, and
 * it keeps cross-file de-duplication exact: cached entries are de-duplicated
 * within their own file only, and the aggregator still applies the global
 * dedupe pass over the small surviving key set.
 *
 * @module usageScanCache
 */
import { UsageProviderKind } from "@t3tools/contracts";
import type {
  TranscriptUsageFormat,
  UsageRecord,
  UsageSpeed,
} from "@t3tools/provider-core/server/usage";
import * as Schema from "effect/Schema";

import { GUARD_LENGTH, type TranscriptParsePosition } from "./usageTranscriptReader.ts";

// v2: Codex fork-copy suppression changed what a file parses to, so v1
// entries would keep serving double-counted records forever.
// v3 was independently used by the fork for malformed-record counts and by
// upstream for incremental parse positions, so neither v3 shape is compatible.
// v4 was used by both again: the fork's carries incremental state with
// completed/tail malformed counts, upstream's adds Claude fast mode instead.
// v5 was used by both a third time: the fork's adds fast mode and `rateModel`
// to its v4, upstream's replaces fast mode with Codex service tiers.
// v6 carries all of it. `decodeScanCache` migrates every v4 and v5 layout.
const USAGE_SCAN_CACHE_VERSION = 6 as const;
const OLDEST_MIGRATED_VERSION = 4;

/**
 * Each cache version writes its own file in the state directory. An older
 * server sharing that directory cannot read a newer cache and would replace
 * it, dropping saved usage for deleted transcripts. Separate files keep both.
 * When its own file is missing, this server migrates the files older builds
 * wrote: the fork's v4/v5 and upstream's v4 share the unversioned name, and
 * upstream's v5 has its own.
 */
export const SCAN_CACHE_FILE_NAME = "usage-scan-cache-v6.json";
export const LEGACY_SCAN_CACHE_FILE_NAMES = [
  "usage-scan-cache.json",
  "usage-scan-cache-v5.json",
] as const;

/** Serialised as the index into this list. Index 0 and 1 match the legacy `fast` flag. */
const SPEEDS: readonly UsageSpeed[] = ["standard", "fast", "ultrafast"];

export interface CachedFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly provider: UsageProviderKind;
  /** Records from newline-terminated lines, up to `position.resumeOffset`. */
  readonly records: readonly UsageRecord[];
  /** Malformed usage-bearing newline-terminated lines up to the resume offset. */
  readonly malformedRecords: number;
  /**
   * Records from a trailing segment the writer had not newline-terminated at
   * parse time. Kept apart from `records` because an incremental parse
   * re-reads that segment and would otherwise double count it.
   */
  readonly tailRecords: readonly UsageRecord[];
  /** Malformed usage-bearing content in the unconsumed trailing segment. */
  readonly tailMalformedRecords: number;
  readonly position: TranscriptParsePosition;
  /** Migrated history is a fallback until its transcript can be parsed in full. */
  readonly requiresReparse?: true;
}

export type ScanCache = Map<string, CachedFile>;

/**
 * Row layout for the serialised form. Positional and interned rather than
 * object-per-record: on a 30-day window that is the difference between a file
 * measured in tens of megabytes and one under six.
 */
type SerializedRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
  speed: number,
  rateModelIndex: number | null,
];

interface SerializedFile {
  readonly reparse?: true;
  readonly s: number;
  readonly m: number;
  readonly p: UsageProviderKind;
  readonly r: readonly SerializedRecord[];
  /** Completed and trailing malformed usage-bearing line counts. */
  readonly x: number;
  readonly tx: number;
  /** Tail records; see `CachedFile.tailRecords`. */
  readonly t: readonly SerializedRecord[];
  /** Parse position: resume offset, guard length, guard hash. */
  readonly o: number;
  readonly gl: number;
  readonly gh: number;
  /** The format's encoded reducer state at `o`; `null` for stateless formats. */
  readonly cs: unknown;
}

interface SerializedCache {
  readonly version: number;
  readonly models: readonly string[];
  readonly sessions: readonly string[];
  readonly files: Readonly<Record<string, SerializedFile>>;
}

/** Model and session strings, each stored once and referenced by index. */
interface InternTables {
  readonly models: string[];
  readonly sessions: string[];
  readonly modelIndex: Map<string, number>;
  readonly sessionIndex: Map<string, number>;
}

function makeInternTables(): InternTables {
  return { models: [], sessions: [], modelIndex: new Map(), sessionIndex: new Map() };
}

function intern(table: string[], index: Map<string, number>, value: string): number {
  const existing = index.get(value);
  if (existing !== undefined) return existing;
  const next = table.length;
  table.push(value);
  index.set(value, next);
  return next;
}

function serializeFile(entry: CachedFile, tables: InternTables): SerializedFile {
  const serializeRecord = (record: UsageRecord): SerializedRecord => [
    record.timestampMs,
    intern(tables.models, tables.modelIndex, record.model),
    intern(tables.sessions, tables.sessionIndex, record.sessionId),
    record.totals.uncachedInputTokens,
    record.totals.cachedInputTokens,
    record.totals.cacheCreationTokens,
    record.totals.outputTokens,
    record.totals.reasoningTokens,
    record.dedupeKey,
    record.reportedCostUsd,
    SPEEDS.indexOf(record.speed),
    record.rateModel === undefined
      ? null
      : intern(tables.models, tables.modelIndex, record.rateModel),
  ];
  return {
    ...(entry.requiresReparse ? { reparse: true as const } : {}),
    s: entry.size,
    m: entry.mtimeMs,
    p: entry.provider,
    r: entry.records.map(serializeRecord),
    x: entry.malformedRecords,
    t: entry.tailRecords.map(serializeRecord),
    tx: entry.tailMalformedRecords,
    o: entry.position.resumeOffset,
    gl: entry.position.guardLength,
    gh: entry.position.guardHash,
    cs: entry.position.state,
  };
}

/** Serialises the cache, interning the repeated model and session strings. */
export function encodeScanCache(cache: ScanCache): SerializedCache {
  const tables = makeInternTables();
  const files: Record<string, SerializedFile> = {};
  for (const [path, entry] of cache) files[path] = serializeFile(entry, tables);
  return {
    version: USAGE_SCAN_CACHE_VERSION,
    models: tables.models,
    sessions: tables.sessions,
    files,
  };
}

/**
 * Returns a function that serialises the cache to JSON text, re-encoding only
 * the entries that changed since its last call. Call it once per persist.
 *
 * Writes the same document as `encodeScanCache`. Most entries never change
 * between scans, and encoding all of them made each persist cost close to a
 * second on a large cache. Entries are replaced, never mutated, when their file
 * changes, so an entry's JSON is memoised by identity. The intern tables only
 * grow, so a memoised entry's indexes stay valid; a pruned entry can leave an
 * unused string behind until the next process start.
 */
export function makeScanCacheWriter(): (
  cache: ScanCache,
  extra: Readonly<Record<string, unknown>>,
) => string {
  const tables = makeInternTables();
  const fragments = new WeakMap<CachedFile, string>();
  return (cache, extra) => {
    const files: string[] = [];
    for (const [path, entry] of cache) {
      let fragment = fragments.get(entry);
      if (fragment === undefined) {
        fragment = JSON.stringify(serializeFile(entry, tables));
        fragments.set(entry, fragment);
      }
      files.push(`${JSON.stringify(path)}:${fragment}`);
    }
    // Encoded after the files, which may have added to the intern tables.
    const head = JSON.stringify({
      ...extra,
      version: USAGE_SCAN_CACHE_VERSION,
      models: tables.models,
      sessions: tables.sessions,
    });
    return `${head.slice(0, -1)},"files":{${files.join(",")}}}`;
  };
}

function isRecordArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

const isProviderKind = Schema.is(UsageProviderKind);

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The entry layouts this build reads, named for the build that wrote them.
 * Fork entries always carry malformed counts (`x`, `tx`); upstream's never do.
 */
type EntryLayout = "current" | "forkV5" | "forkV4" | "upstreamV5" | "upstreamV4";

function entryLayout(version: number, entry: Partial<SerializedFile>): EntryLayout | null {
  const fork = entry.x !== undefined || entry.tx !== undefined;
  if (version === USAGE_SCAN_CACHE_VERSION) return "current";
  if (version === 5) return fork ? "forkV5" : "upstreamV5";
  if (version === 4) return fork ? "forkV4" : "upstreamV4";
  return null;
}

/** Shortest row each layout writes; the columns after it are absent. */
const ROW_LENGTH: Record<EntryLayout, number> = {
  current: 12,
  forkV5: 12,
  forkV4: 10,
  upstreamV5: 11,
  upstreamV4: 11,
};

/**
 * Rebuilds the cache from a parsed document, migrating older layouts.
 *
 * Migrated entries keep their records, because the transcript may be gone,
 * but most must re-parse while their file still exists: upstream layouts never
 * counted malformed records, fork v4 predates fast mode, and only v6 and
 * upstream v5 Codex entries know their service tier. Those carry
 * `requiresReparse` until a full parse replaces them.
 *
 * Anything malformed yields an empty cache rather than an error: a corrupt
 * cache should cost one cold scan, never a broken page. `formats` validates the
 * persisted reducer state of stateful transcript formats; entries of providers
 * without a transcript format are kept, since scan readers cache records too.
 */
export function decodeScanCache(
  document: unknown,
  formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
): ScanCache {
  const cache: ScanCache = new Map();
  const isValidState = makeStateValidator(formats);
  if (typeof document !== "object" || document === null) return cache;

  const root = document as Partial<SerializedCache>;
  const version = root.version;
  if (
    typeof version !== "number" ||
    version < OLDEST_MIGRATED_VERSION ||
    version > USAGE_SCAN_CACHE_VERSION
  ) {
    return cache;
  }
  if (!isRecordArray(root.models) || !isRecordArray(root.sessions)) return cache;
  if (typeof root.files !== "object" || root.files === null) return cache;

  // The intern tables must be all strings: a numeric entry would pass the
  // undefined guard below, land in a record's model, and crash the aggregate
  // at lookupRate. A corrupt table rejects the whole cache.
  if (!root.models.every((value) => typeof value === "string")) return cache;
  if (!root.sessions.every((value) => typeof value === "string")) return cache;
  const models = root.models as readonly string[];
  const sessions = root.sessions as readonly string[];

  // Any corrupt row disqualifies the whole entry. Keeping the survivors
  // under the original (size, mtime) would read as a valid warm hit and the
  // file would never be re-parsed, silently losing the dropped rows' usage.
  const decodeRecords = (
    rows: readonly unknown[],
    provider: UsageProviderKind,
    layout: EntryLayout,
  ): UsageRecord[] | null => {
    const records: UsageRecord[] = [];
    for (const row of rows) {
      if (!isRecordArray(row) || row.length < ROW_LENGTH[layout]) return null;
      const [
        timestampMs,
        modelIndex,
        sessionIndex,
        uncached,
        cached,
        cacheCreation,
        output,
        reasoning,
        dedupeKey,
        reportedCostUsd,
        speedIndex,
        rateModelIndex,
      ] = row as SerializedRecord;

      // Fork v4 predates fast mode. A legacy `fast` flag (0 or 1) is the
      // speed index it maps to; only v6 and upstream v5 record ultrafast.
      const speed =
        layout === "forkV4"
          ? "standard"
          : typeof speedIndex === "number" &&
              (speedIndex <= 1 || layout === "current" || layout === "upstreamV5")
            ? SPEEDS[speedIndex]
            : undefined;
      const hasRateModel = layout === "current" || layout === "forkV5";
      const rateModel =
        hasRateModel && typeof rateModelIndex === "number" ? models[rateModelIndex] : undefined;
      if (hasRateModel && rateModelIndex !== null && rateModel === undefined) return null;
      const model = typeof modelIndex === "number" ? models[modelIndex] : undefined;
      if (
        typeof timestampMs !== "number" ||
        !Number.isFinite(timestampMs) ||
        model === undefined ||
        !Number.isFinite(uncached) ||
        !Number.isFinite(cached) ||
        !Number.isFinite(cacheCreation) ||
        !Number.isFinite(output) ||
        !Number.isFinite(reasoning) ||
        speed === undefined
      ) {
        return null;
      }

      records.push({
        provider,
        timestampMs,
        model,
        ...(rateModel === undefined ? {} : { rateModel }),
        sessionId: (typeof sessionIndex === "number" ? sessions[sessionIndex] : undefined) ?? "",
        totals: {
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheCreationTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: reasoning,
        },
        reportedCostUsd: typeof reportedCostUsd === "number" ? reportedCostUsd : null,
        speed,
        dedupeKey: typeof dedupeKey === "string" ? dedupeKey : null,
      });
    }
    return records;
  };

  for (const [path, raw] of Object.entries(root.files)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Partial<SerializedFile>;
    const layout = entryLayout(version, entry);
    if (layout === null) continue;
    if (typeof entry.s !== "number" || typeof entry.m !== "number") continue;
    if (!isProviderKind(entry.p)) continue;
    if (!isRecordArray(entry.r) || !isRecordArray(entry.t)) continue;
    const countsMalformed = layout === "current" || layout === "forkV5" || layout === "forkV4";
    if (countsMalformed && (!isCount(entry.x) || !isCount(entry.tx))) continue;
    // Position fields feed byte offsets and a Buffer allocation in the reader,
    // so anything outside their real ranges must reject the entry: a bogus
    // guard length would otherwise fail every parse of the file, silently
    // dropping its usage instead of costing the documented cold re-parse.
    if (
      typeof entry.o !== "number" ||
      !Number.isSafeInteger(entry.o) ||
      entry.o < 0 ||
      typeof entry.gl !== "number" ||
      !Number.isSafeInteger(entry.gl) ||
      entry.gl < 0 ||
      entry.gl > GUARD_LENGTH ||
      entry.gl > entry.o ||
      typeof entry.gh !== "number" ||
      !Number.isFinite(entry.gh)
    ) {
      continue;
    }

    const requiresReparse =
      entry.reparse === true ||
      !countsMalformed ||
      layout === "forkV4" ||
      // Fork v5 Codex state has no service tier, so its records all priced standard.
      (layout === "forkV5" && entry.p === "codex");
    // A migrated position is never resumed: a full parse replaces the entry.
    const migrated = layout !== "current" && requiresReparse;
    // A corrupt state disqualifies the entry: resuming with it would attach
    // appended usage to the wrong model or tier, or replay fork-copied history.
    if (!migrated && !isValidState(entry.p, entry.cs)) continue;

    const provider = entry.p;
    const records = decodeRecords(entry.r, provider, layout);
    const tailRecords = decodeRecords(entry.t, provider, layout);
    if (records === null || tailRecords === null) continue;

    cache.set(path, {
      ...(requiresReparse ? { requiresReparse: true as const } : {}),
      size: entry.s,
      mtimeMs: entry.m,
      provider,
      records,
      malformedRecords: countsMalformed ? (entry.x ?? 0) : 0,
      tailRecords,
      tailMalformedRecords: countsMalformed ? (entry.tx ?? 0) : 0,
      position: migrated
        ? { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null }
        : {
            resumeOffset: entry.o,
            guardLength: entry.gl,
            guardHash: entry.gh,
            state: entry.cs,
          },
    });
  }

  return cache;
}

/**
 * Whether a persisted reducer state is valid for its provider: `null`, or one
 * the provider's transcript format schema accepts. Providers without a
 * transcript format (scan readers such as OpenCode and Cursor) keep their
 * retained records but never carry state.
 */
function makeStateValidator(
  formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
): (provider: UsageProviderKind, value: unknown) => boolean {
  const validators = new Map(
    [...formats].flatMap(([provider, format]) =>
      format.state === undefined ? [] : [[provider, Schema.is(format.state.schema)] as const],
    ),
  );
  return (provider, value) => value === null || (validators.get(provider)?.(value) ?? false);
}

/** Keeps saved usage after transcript cleanup, until the reporting retention expires. */
export function pruneScanCache(cache: ScanCache, retentionCutoffMs: number): number {
  let removed = 0;
  for (const [path, entry] of cache) {
    if (entry.mtimeMs < retentionCutoffMs) {
      cache.delete(path);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Within-file de-duplication, applied before an entry is cached.
 *
 * Callers stitching an incremental parse together pass one `seen` set across
 * the line and tail record batches so the whole file stays deduplicated as a
 * unit; the set is mutated in place.
 */
export function dedupeWithinFile(
  records: readonly UsageRecord[],
  seen: Set<string> = new Set(),
): readonly UsageRecord[] {
  const kept: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    kept.push(record);
  }
  return kept;
}
