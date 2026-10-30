import { UsageProviderKind } from "@t3tools/contracts";
import type {
  TranscriptUsageFormat,
  UsageRecord,
  UsageSpeed,
} from "@t3tools/provider-core/server/usage";
import * as Schema from "effect/Schema";

import { CLAUDE_SYNTHETIC_MODEL } from "../provider/Drivers/claudeUsage.ts";
import { GUARD_LENGTH, type TranscriptParsePosition } from "./usageTranscriptReader.ts";

// v3-v10 were each used by both the fork and upstream with incompatible layouts; v11 carries all of
// the fork's changes. Fork entries always carry malformed counts (`x`, `tx`) and upstream's never
// do, which tells the shared versions apart. `decodeScanCache` migrates every v4-v10 cache.
const USAGE_SCAN_CACHE_VERSION = 11 as const;
const OLDEST_MIGRATED_VERSION = 4;

/**
 * Each cache version writes its own file, so an older server sharing the state dir cannot replace a
 * newer cache and drop saved usage. Without its own file, this server migrates older builds' files:
 * fork v4/v5 and upstream v4 share the unversioned name, upstream v5 has its own, v6-v10 share theirs.
 */
export const SCAN_CACHE_FILE_NAME = "usage-scan-cache-v11.json";
export const LEGACY_SCAN_CACHE_FILE_NAMES = [
  "usage-scan-cache.json",
  "usage-scan-cache-v5.json",
  "usage-scan-cache-v6.json",
  "usage-scan-cache-v7.json",
  "usage-scan-cache-v8.json",
  "usage-scan-cache-v9.json",
  "usage-scan-cache-v10.json",
] as const;

/** Serialised as the index into this list. Index 0 and 1 match the legacy `fast` flag. */
const SPEEDS: readonly UsageSpeed[] = ["standard", "fast", "ultrafast"];

export interface CachedFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly provider: UsageProviderKind;
  readonly records: readonly UsageRecord[];
  /** Malformed usage-bearing newline-terminated lines up to the resume offset. */
  readonly malformedRecords: number;
  /** Unterminated tail records stay separate because incremental parsing rereads them. */
  readonly tailRecords: readonly UsageRecord[];
  /** Malformed usage-bearing content in the unconsumed trailing segment. */
  readonly tailMalformedRecords: number;
  readonly position: TranscriptParsePosition;
  /** Migrated history is a fallback until its transcript can be parsed in full. */
  readonly requiresReparse?: true;
}

export type ScanCache = Map<string, CachedFile>;

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
  /** `1` for a provisional record. Trailing unset columns are omitted. */
  provisional?: 0 | 1,
  oneHourCacheCreationTokens?: number,
  unresolvedServiceTierTurnId?: string,
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
  readonly t: readonly SerializedRecord[];
  /** Upstream's whole-file malformed count, read only from its layouts. */
  readonly mr?: number;
  readonly o: number;
  readonly gl: number;
  readonly gh: number;
  readonly cs: unknown;
}

interface SerializedCache {
  readonly version: number;
  readonly models: readonly string[];
  readonly sessions: readonly string[];
  readonly files: Readonly<Record<string, SerializedFile>>;
}

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
  const serializeRecord = (record: UsageRecord): SerializedRecord => {
    const row: [...SerializedRecord] = [
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
    const oneHour = record.oneHourCacheCreationTokens ?? 0;
    const turnId = record.unresolvedServiceTierTurnId;
    if (record.provisional || oneHour > 0 || turnId !== undefined) {
      row.push(record.provisional ? 1 : 0);
    }
    if (oneHour > 0 || turnId !== undefined) row.push(oneHour);
    if (turnId !== undefined) row.push(turnId);
    return row;
  };
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

/** Memoizes immutable entries by identity; growing intern tables preserve indexes, retaining unused strings until restart. */
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
type EntryLayout =
  | "current"
  | "forkV10"
  | "forkV9"
  | "forkV8"
  | "forkV7"
  | "forkV6"
  | "forkV5"
  | "forkV4"
  | "upstreamV10"
  | "upstreamV9"
  | "upstreamV8"
  | "upstreamV7"
  | "upstreamV6"
  | "upstreamV5"
  | "upstreamV4";

function entryLayout(version: number, entry: Partial<SerializedFile>): EntryLayout | null {
  if (version === USAGE_SCAN_CACHE_VERSION) return "current";
  const fork = entry.x !== undefined || entry.tx !== undefined;
  if (version === 10) return fork ? "forkV10" : "upstreamV10";
  if (version === 9) return fork ? "forkV9" : "upstreamV9";
  if (version === 8) return fork ? "forkV8" : "upstreamV8";
  if (version === 7) return fork ? "forkV7" : "upstreamV7";
  if (version === 6) return fork ? "forkV6" : "upstreamV6";
  if (version === 5) return fork ? "forkV5" : "upstreamV5";
  if (version === 4) return fork ? "forkV4" : "upstreamV4";
  return null;
}

/** Shortest row each layout writes; the columns after it are absent. */
const ROW_LENGTH: Record<EntryLayout, number> = {
  current: 12,
  forkV10: 12,
  forkV9: 12,
  forkV8: 12,
  forkV7: 12,
  forkV6: 12,
  forkV5: 12,
  forkV4: 10,
  upstreamV10: 11,
  upstreamV9: 11,
  upstreamV8: 11,
  upstreamV7: 11,
  upstreamV6: 11,
  upstreamV5: 11,
  upstreamV4: 11,
};

/** Layouts whose speed column may hold ultrafast, not just the legacy `fast` flag. */
const ULTRAFAST_LAYOUTS: ReadonlySet<EntryLayout> = new Set([
  "current",
  "forkV10",
  "forkV9",
  "forkV8",
  "forkV7",
  "forkV6",
  "upstreamV10",
  "upstreamV9",
  "upstreamV8",
  "upstreamV7",
  "upstreamV6",
  "upstreamV5",
]);

/** Layouts whose rows always carry `rateModel`; upstream's may append it. */
const RATE_MODEL_LAYOUTS: ReadonlySet<EntryLayout> = new Set([
  "current",
  "forkV10",
  "forkV9",
  "forkV8",
  "forkV7",
  "forkV6",
  "forkV5",
]);

/**
 * Rebuilds the cache, migrating older layouts. Migrated entries keep their records (the transcript
 * may be gone) but carry `requiresReparse` while it exists: upstream layouts, fork v4, pre-v9 fork
 * Codex (v9 only with malformed lines) and older fork Claude entries (no advisor records).
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

  if (!root.models.every((value) => typeof value === "string")) return cache;
  if (!root.sessions.every((value) => typeof value === "string")) return cache;
  const models = root.models as readonly string[];
  const sessions = root.sessions as readonly string[];

  // Reject entire corrupt entries; partial survivors would appear warm and hide usage until the file changes.
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
      // Fork v7+ layouts append provisional and one-hour columns; upstream
      // v7–v10 put their tier turn where the fork's provisional flag sits.
      const forkTurnColumn =
        layout === "current" || layout === "forkV10" || layout === "forkV9" || layout === "forkV8";
      const forkColumns = forkTurnColumn || layout === "forkV7";
      const provisional = forkColumns ? row[12] : undefined;
      const oneHourCacheCreationTokens = forkColumns ? row[13] : undefined;
      const unresolvedServiceTierTurnId = forkTurnColumn
        ? row[14]
        : layout === "upstreamV10" ||
            layout === "upstreamV9" ||
            layout === "upstreamV8" ||
            layout === "upstreamV7"
          ? row[12]
          : undefined;

      // Fork v4 predates fast mode. A legacy `fast` flag (0 or 1) is the
      // speed index it maps to; only later tier-aware layouts record ultrafast.
      const speed =
        layout === "forkV4"
          ? "standard"
          : typeof speedIndex === "number" && (speedIndex <= 1 || ULTRAFAST_LAYOUTS.has(layout))
            ? SPEEDS[speedIndex]
            : undefined;
      const hasRateModel =
        RATE_MODEL_LAYOUTS.has(layout) ||
        (layout.startsWith("upstream") && row.length > ROW_LENGTH[layout]);
      const rateModel =
        hasRateModel && typeof rateModelIndex === "number" ? models[rateModelIndex] : undefined;
      if (hasRateModel && rateModelIndex != null && rateModel === undefined) return null;
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
        speed === undefined ||
        (provisional !== undefined && provisional !== 0 && provisional !== 1) ||
        (oneHourCacheCreationTokens !== undefined && !isCount(oneHourCacheCreationTokens)) ||
        (unresolvedServiceTierTurnId !== undefined &&
          typeof unresolvedServiceTierTurnId !== "string")
      ) {
        return null;
      }

      // Unchanged and deleted transcripts may only exist in the cache, so the
      // parser cannot remove their previously saved local placeholders.
      if (provider === "claude" && model === CLAUDE_SYNTHETIC_MODEL) continue;

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
        ...(unresolvedServiceTierTurnId === undefined ? {} : { unresolvedServiceTierTurnId }),
        dedupeKey: typeof dedupeKey === "string" ? dedupeKey : null,
        ...(provisional === 1 ? { provisional: true as const } : {}),
        ...(oneHourCacheCreationTokens ? { oneHourCacheCreationTokens } : {}),
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
    const countsMalformed = !layout.startsWith("upstream");
    if (countsMalformed && (!isCount(entry.x) || !isCount(entry.tx))) continue;
    // Upstream's whole-file count is kept for deleted transcripts; a live one re-parses.
    if (!countsMalformed && entry.mr !== undefined && !isCount(entry.mr)) continue;
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
      // Only fork v9+ Codex state reconciles cumulative counters, keeps tier
      // provenance, and skips compaction and resume markers; fork v9 still
      // rejected initial requests with inherited totals as malformed, so only
      // its clean entries resume.
      (entry.p === "codex" &&
        layout !== "current" &&
        layout !== "forkV10" &&
        !(layout === "forkV9" && entry.x === 0 && entry.tx === 0)) ||
      // Claude entries before fork v11 lack advisor records (and before v7 kept
      // each message's first record).
      (entry.p === "claude" && layout !== "current");
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
      malformedRecords: countsMalformed ? (entry.x ?? 0) : (entry.mr ?? 0),
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
 * Whether `candidate` should replace `kept`, an earlier record with the same
 * dedupe key. Real usage replaces a provisional estimate. Claude Code writes a
 * message's records as growing snapshots, so its record with the most output
 * is the completed one. Otherwise the first record wins, as in ccusage.
 */
function supersedesUsageRecord(candidate: UsageRecord, kept: UsageRecord): boolean {
  const keptProvisional = kept.provisional === true;
  if (keptProvisional !== (candidate.provisional === true)) return keptProvisional;
  return (
    candidate.provider === "claude" && candidate.totals.outputTokens > kept.totals.outputTokens
  );
}

/**
 * Within-file de-duplication, applied before an entry is cached. One record
 * survives per dedupe key, at the position of the key's first record.
 */
export function dedupeWithinFile(records: readonly UsageRecord[]): readonly UsageRecord[] {
  const kept: UsageRecord[] = [];
  const indexByKey = new Map<string, number>();
  for (const record of records) {
    if (record.dedupeKey === null) {
      kept.push(record);
      continue;
    }
    const index = indexByKey.get(record.dedupeKey);
    if (index === undefined) {
      indexByKey.set(record.dedupeKey, kept.length);
      kept.push(record);
    } else if (supersedesUsageRecord(record, kept[index]!)) {
      kept[index] = record;
    }
  }
  return kept;
}

/**
 * The record each dedupe key keeps across a whole scan, by the same rule as
 * `dedupeWithinFile`. A resumed or forked Claude session copies records into
 * another transcript, so the completed record may sit in a later file.
 */
export function selectDedupeWinners(
  files: readonly { readonly records: readonly UsageRecord[] }[],
): ReadonlyMap<string, UsageRecord> {
  const winners = new Map<string, UsageRecord>();
  for (const { records } of files) {
    for (const record of records) {
      if (record.dedupeKey === null) continue;
      const kept = winners.get(record.dedupeKey);
      if (kept === undefined || supersedesUsageRecord(record, kept)) {
        winners.set(record.dedupeKey, record);
      }
    }
  }
  return winners;
}
