import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SQLiteDatabase } from "expo-sqlite";

import { diagnosticEnvironmentKey } from "../diagnostics/events";
import { recordMobileDiagnostic } from "../diagnostics/journal";
import { type ScheduledAsyncOperation, SerializedAsyncQueue } from "../lib/serialized-async-queue";

const DATABASE_NAME = "t3code-client.db";
const DATABASE_SCHEMA_VERSION = 2;
const CACHE_INCREMENTAL_VACUUM_PAGES = 256;
const CACHE_STARTUP_VACUUM_PASSES = 32;
const CACHE_LRU_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_STARTUP_MAINTENANCE_DELAY_MS = 1_000;
const MEBIBYTE = 1024 * 1024;

export const MOBILE_CACHE_MAX_ROW_BYTES = 4 * MEBIBYTE;
export const MOBILE_CACHE_MAX_TOTAL_BYTES = 128 * MEBIBYTE;
const LEGACY_CACHE_DIRECTORIES = [
  "connection-shell-snapshots",
  "shell-snapshots",
  "connection-thread-snapshots",
  "connection-server-configs",
  "connection-vcs-refs",
] as const;

export const ClientCacheKind = Schema.Literals(["shell", "thread", "server-config", "vcs-refs"]);
export type ClientCacheKind = typeof ClientCacheKind.Type;

export interface ClientCacheSummaryRow {
  readonly environmentId: EnvironmentId;
  readonly kind: ClientCacheKind;
  readonly recordCount: number;
  readonly payloadBytes: number;
}

export interface StoredPreferencesJson {
  readonly payload: string;
  readonly updatedAt: number;
}

const ClientCacheSummaryRows = Schema.Array(
  Schema.Struct({
    environmentId: Schema.String,
    kind: ClientCacheKind,
    recordCount: Schema.Number,
    payloadBytes: Schema.Number,
  }),
);

const MobileDatabaseOperation = Schema.Literals([
  "open",
  "migrate",
  "load-cache",
  "save-cache",
  "remove-cache",
  "clear-cache-kind",
  "clear-environment-cache",
  "clear-all-caches",
  "inspect-caches",
  "load-preferences",
  "save-preferences",
]);

export class MobileDatabaseError extends Schema.TaggedErrorClass<MobileDatabaseError>()(
  "MobileDatabaseError",
  {
    operation: MobileDatabaseOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mobile database operation failed: ${this.operation}.`;
  }
}

function databaseError(operation: typeof MobileDatabaseOperation.Type) {
  return (cause: unknown) => new MobileDatabaseError({ operation, cause });
}

interface LegacyCacheRecord {
  readonly environmentId: string;
  readonly kind: ClientCacheKind;
  readonly cacheKey: string;
  readonly schemaVersion: number;
  readonly payload: string;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export type CacheSqliteDatabase = Pick<SQLiteDatabase, "execAsync" | "getFirstAsync" | "runAsync">;

export interface CacheIdentity {
  readonly environmentId: EnvironmentId;
  readonly kind: ClientCacheKind;
  readonly cacheKey: string;
}

interface DatabaseStorageStats {
  readonly cacheBytes: number;
  readonly allocatedBytes: number;
  readonly freePages: number;
  readonly pageSize: number;
}

export interface CachePruneResult extends DatabaseStorageStats {
  readonly removedRows: number;
  readonly withinBudget: boolean;
}

export interface CacheSaveResult extends CachePruneResult {
  readonly skipped: boolean;
  readonly payloadBytes: number;
}

function cachePayloadSizeBucket(payloadBytes: number): string {
  const payloadMebibytes = Math.ceil(payloadBytes / MEBIBYTE);
  if (payloadMebibytes <= 8) return "4-8MiB";
  if (payloadMebibytes <= 16) return "9-16MiB";
  if (payloadMebibytes <= 32) return "17-32MiB";
  if (payloadMebibytes <= 64) return "33-64MiB";
  return ">64MiB";
}

function recordCacheWriteSkipped(
  environmentId: string,
  kind: ClientCacheKind,
  payloadBytes: number,
): void {
  recordMobileDiagnostic("cache", {
    op: "skip-oversized",
    env: diagnosticEnvironmentKey(environmentId as EnvironmentId),
    kind,
    payloadSize: cachePayloadSizeBucket(payloadBytes),
    limitMiB: MOBILE_CACHE_MAX_ROW_BYTES / MEBIBYTE,
  });
}

function recordCachePruned(result: CachePruneResult, source: "save" | "startup"): void {
  if (result.removedRows === 0 && result.withinBudget) return;
  recordMobileDiagnostic("cache", {
    op: "prune",
    source,
    removedRows: result.removedRows,
    cacheMiB: Math.ceil(result.cacheBytes / MEBIBYTE),
    allocatedMiB: Math.ceil(result.allocatedBytes / MEBIBYTE),
    withinBudget: result.withinBudget,
  });
}

async function databaseStorageStats(database: CacheSqliteDatabase): Promise<DatabaseStorageStats> {
  const row = await database.getFirstAsync<DatabaseStorageStats>(`
    SELECT
      (SELECT COALESCE(SUM(payload_bytes), 0) FROM client_cache) AS cacheBytes,
      page_count * page_size AS allocatedBytes,
      freelist_count AS freePages,
      page_size AS pageSize
    FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()
  `);
  return {
    cacheBytes: Math.max(0, row?.cacheBytes ?? 0),
    allocatedBytes: Math.max(0, row?.allocatedBytes ?? 0),
    freePages: Math.max(0, row?.freePages ?? 0),
    pageSize: Math.max(0, row?.pageSize ?? 0),
  };
}

export async function pruneCacheToBudget(
  database: CacheSqliteDatabase,
  options: {
    readonly maxTotalBytes?: number;
    readonly protectedIdentity?: CacheIdentity;
  } = {},
): Promise<CachePruneResult> {
  const maxTotalBytes = options.maxTotalBytes ?? MOBILE_CACHE_MAX_TOTAL_BYTES;
  const stats = await databaseStorageStats(database);
  if (stats.cacheBytes <= maxTotalBytes) {
    return { ...stats, removedRows: 0, withinBudget: true };
  }

  const protectedIdentity = options.protectedIdentity;
  const result = await database.runAsync(
    `WITH candidates AS (
       SELECT
         environment_id,
         kind,
         cache_key,
         COALESCE(
           SUM(payload_bytes) OVER (
             ORDER BY updated_at ASC, environment_id ASC, kind ASC, cache_key ASC
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ),
           0
         ) AS bytes_before
       FROM client_cache
       WHERE ? IS NULL OR NOT (environment_id = ? AND kind = ? AND cache_key = ?)
     )
     DELETE FROM client_cache
     WHERE (environment_id, kind, cache_key) IN (
       SELECT environment_id, kind, cache_key
       FROM candidates
       WHERE bytes_before < ?
     )`,
    protectedIdentity?.environmentId ?? null,
    protectedIdentity?.environmentId ?? "",
    protectedIdentity?.kind ?? "",
    protectedIdentity?.cacheKey ?? "",
    stats.cacheBytes - maxTotalBytes,
  );
  const prunedStats = await databaseStorageStats(database);
  return {
    ...prunedStats,
    removedRows: result.changes,
    withinBudget: prunedStats.cacheBytes <= maxTotalBytes,
  };
}

export async function saveBoundedCacheRecord(
  database: CacheSqliteDatabase,
  input: CacheIdentity & {
    readonly schemaVersion: number;
    readonly payload: string;
  },
  options: {
    readonly maxRowBytes?: number;
    readonly maxTotalBytes?: number;
    readonly now?: number;
  } = {},
): Promise<CacheSaveResult> {
  const payloadBytes = utf8ByteLength(input.payload);
  const maxRowBytes = options.maxRowBytes ?? MOBILE_CACHE_MAX_ROW_BYTES;
  if (payloadBytes > maxRowBytes) {
    const removed = await database.runAsync(
      `DELETE FROM client_cache
       WHERE environment_id = ? AND kind = ? AND cache_key = ?`,
      input.environmentId,
      input.kind,
      input.cacheKey,
    );
    if (removed.changes > 0) {
      await database.execAsync(`PRAGMA incremental_vacuum(${CACHE_INCREMENTAL_VACUUM_PAGES});`);
    }
    const stats = await databaseStorageStats(database);
    return {
      ...stats,
      payloadBytes,
      removedRows: removed.changes,
      skipped: true,
      withinBudget: stats.cacheBytes <= (options.maxTotalBytes ?? MOBILE_CACHE_MAX_TOTAL_BYTES),
    };
  }

  const now = options.now ?? Date.now();
  await database.runAsync(
    `INSERT INTO client_cache
      (environment_id, kind, cache_key, schema_version, payload, payload_bytes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (environment_id, kind, cache_key) DO UPDATE SET
       schema_version = excluded.schema_version,
       payload = excluded.payload,
       payload_bytes = excluded.payload_bytes,
       updated_at = excluded.updated_at`,
    input.environmentId,
    input.kind,
    input.cacheKey,
    input.schemaVersion,
    input.payload,
    payloadBytes,
    now,
  );
  const pruneResult = await pruneCacheToBudget(database, {
    maxTotalBytes: options.maxTotalBytes,
    protectedIdentity: input,
  });
  if (pruneResult.removedRows > 0) {
    await database.execAsync(`PRAGMA incremental_vacuum(${CACHE_INCREMENTAL_VACUUM_PAGES});`);
  }

  return {
    ...pruneResult,
    payloadBytes,
    skipped: false,
  };
}

export async function loadCacheRecord(
  database: CacheSqliteDatabase,
  identity: CacheIdentity,
  now = Date.now(),
): Promise<{ readonly payload: string } | null> {
  const row = await database.getFirstAsync<{ readonly payload: string }>(
    `SELECT payload
     FROM client_cache
     WHERE environment_id = ? AND kind = ? AND cache_key = ?`,
    identity.environmentId,
    identity.kind,
    identity.cacheKey,
  );
  if (row !== null) {
    await database.runAsync(
      `UPDATE client_cache
       SET updated_at = ?
       WHERE environment_id = ? AND kind = ? AND cache_key = ? AND updated_at < ?`,
      now,
      identity.environmentId,
      identity.kind,
      identity.cacheKey,
      now - CACHE_LRU_TOUCH_INTERVAL_MS,
    );
  }
  return row;
}

export function decodeLegacyCacheRecord(
  directoryName: (typeof LEGACY_CACHE_DIRECTORIES)[number],
  payload: string,
): LegacyCacheRecord | null {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = objectRecord(JSON.parse(payload));
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed.environmentId !== "string" ||
    typeof parsed.schemaVersion !== "number"
  ) {
    return null;
  }

  switch (directoryName) {
    case "connection-shell-snapshots":
    case "shell-snapshots":
      return {
        environmentId: parsed.environmentId,
        kind: "shell",
        cacheKey: "snapshot",
        schemaVersion: parsed.schemaVersion,
        payload,
      };
    case "connection-thread-snapshots":
      return typeof parsed.threadId === "string"
        ? {
            environmentId: parsed.environmentId,
            kind: "thread",
            cacheKey: parsed.threadId,
            schemaVersion: parsed.schemaVersion,
            payload,
          }
        : null;
    case "connection-server-configs":
      return {
        environmentId: parsed.environmentId,
        kind: "server-config",
        cacheKey: "config",
        schemaVersion: parsed.schemaVersion,
        payload,
      };
    case "connection-vcs-refs":
      return typeof parsed.cwd === "string"
        ? {
            environmentId: parsed.environmentId,
            kind: "vcs-refs",
            cacheKey: parsed.cwd,
            schemaVersion: parsed.schemaVersion,
            payload,
          }
        : null;
  }
}

async function ensureIncrementalAutoVacuum(database: SQLiteDatabase): Promise<void> {
  const row = await database.getFirstAsync<{ readonly autoVacuum: number }>(
    "SELECT auto_vacuum AS autoVacuum FROM pragma_auto_vacuum()",
  );
  const autoVacuum = row?.autoVacuum ?? 0;
  if (autoVacuum === 2) return;
  if (autoVacuum === 0) {
    try {
      await database.execAsync("PRAGMA journal_mode = DELETE;");
      await database.execAsync("PRAGMA auto_vacuum = INCREMENTAL;");
      await database.execAsync("VACUUM;");
    } finally {
      await database.execAsync("PRAGMA journal_mode = WAL;");
    }
  } else {
    await database.execAsync("PRAGMA auto_vacuum = INCREMENTAL;");
  }
  const converted = await database.getFirstAsync<{ readonly autoVacuum: number }>(
    "SELECT auto_vacuum AS autoVacuum FROM pragma_auto_vacuum()",
  );
  if ((converted?.autoVacuum ?? 0) !== 2) {
    throw new Error("SQLite incremental auto-vacuum conversion did not persist.");
  }
}

export async function runStartupCacheMaintenance(
  database: SQLiteDatabase,
  options: {
    readonly maxTotalBytes?: number;
    readonly vacuumPasses?: number;
  } = {},
): Promise<void> {
  const pruneResult = await pruneCacheToBudget(database, {
    maxTotalBytes: options.maxTotalBytes,
  });
  let incrementalVacuumAvailable = true;
  try {
    await ensureIncrementalAutoVacuum(database);
  } catch (cause) {
    incrementalVacuumAvailable = false;
    const reason = cause instanceof Error ? cause.name : "Unknown";
    recordMobileDiagnostic("cache", { op: "auto-vacuum-failed", reason });
    console.warn("[mobile-database] could not enable incremental auto-vacuum", { reason });
  }
  await database.execAsync("PRAGMA wal_checkpoint(TRUNCATE);");

  if (incrementalVacuumAvailable) {
    const vacuumPasses = options.vacuumPasses ?? CACHE_STARTUP_VACUUM_PASSES;
    for (let pass = 0; pass < vacuumPasses; pass += 1) {
      const row = await database.getFirstAsync<{ readonly freePages: number }>(
        "SELECT freelist_count AS freePages FROM pragma_freelist_count()",
      );
      if ((row?.freePages ?? 0) === 0) break;
      await database.execAsync(`PRAGMA incremental_vacuum(${CACHE_INCREMENTAL_VACUUM_PAGES});`);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  await database.execAsync("PRAGMA optimize;");
  const finalStats = await databaseStorageStats(database);
  recordCachePruned(
    { ...finalStats, removedRows: pruneResult.removedRows, withinBudget: pruneResult.withinBudget },
    "startup",
  );
}

async function migrateLegacyFileCaches(database: SQLiteDatabase): Promise<boolean> {
  try {
    const { Directory, File, Paths } = await import("expo-file-system");
    let complete = true;
    const listFiles = (
      directory: InstanceType<typeof Directory>,
    ): Array<InstanceType<typeof File>> =>
      directory.list().flatMap((entry) => (entry instanceof File ? [entry] : listFiles(entry)));

    for (const directoryName of LEGACY_CACHE_DIRECTORIES) {
      try {
        const directory = new Directory(Paths.document, directoryName);
        if (!directory.exists) continue;
        for (const file of listFiles(directory)) {
          const payload = await file.text();
          const record = decodeLegacyCacheRecord(directoryName, payload);
          if (record === null) continue;
          const payloadBytes = utf8ByteLength(record.payload);
          if (payloadBytes > MOBILE_CACHE_MAX_ROW_BYTES) {
            recordCacheWriteSkipped(record.environmentId, record.kind, payloadBytes);
            console.warn("[mobile-database] skipped oversized legacy cache record", {
              environmentId: diagnosticEnvironmentKey(record.environmentId as EnvironmentId),
              kind: record.kind,
              payloadSize: cachePayloadSizeBucket(payloadBytes),
            });
            continue;
          }
          await database.runAsync(
            `INSERT INTO client_cache
              (environment_id, kind, cache_key, schema_version, payload, payload_bytes, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (environment_id, kind, cache_key) DO NOTHING`,
            record.environmentId,
            record.kind,
            record.cacheKey,
            record.schemaVersion,
            record.payload,
            payloadBytes,
            Date.now(),
          );
        }
        directory.delete();
      } catch (cause) {
        complete = false;
        console.warn(`[mobile-database] could not migrate legacy cache ${directoryName}`, cause);
      }
    }
    return complete;
  } catch (cause) {
    console.warn("[mobile-database] could not load legacy cache migration", cause);
    return false;
  }
}

export class MobileDatabase extends Context.Service<
  MobileDatabase,
  {
    readonly loadCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
    ) => Effect.Effect<Option.Option<string>, MobileDatabaseError>;
    readonly saveCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
      schemaVersion: number,
      payload: string,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly removeCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly clearCacheKind: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly clearEnvironmentCache: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly clearAllCaches: Effect.Effect<void, MobileDatabaseError>;
    readonly inspectCaches: Effect.Effect<
      ReadonlyArray<ClientCacheSummaryRow>,
      MobileDatabaseError
    >;
    readonly loadPreferencesJson: Effect.Effect<
      Option.Option<StoredPreferencesJson>,
      MobileDatabaseError
    >;
    readonly savePreferencesJson: (
      payload: string,
      updatedAt: number,
    ) => Effect.Effect<void, MobileDatabaseError>;
  }
>()("@t3tools/mobile/persistence/MobileDatabase") {}

const makeAvailable = Effect.gen(function* () {
  const cacheOperations = new SerializedAsyncQueue();
  let startupMaintenance: ScheduledAsyncOperation | null = null;
  const database = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const SQLite = await import("expo-sqlite");
        return SQLite.openDatabaseAsync(DATABASE_NAME);
      },
      catch: databaseError("open"),
    }),
    (openDatabase) =>
      Effect.promise(async () => {
        startupMaintenance?.cancel();
        await startupMaintenance?.done;
        await cacheOperations.drain();
        await openDatabase.closeAsync();
      }).pipe(Effect.ignore),
  );

  yield* Effect.tryPromise({
    try: async () => {
      const schema = await database.getFirstAsync<{ readonly user_version: number }>(
        "PRAGMA user_version",
      );
      const schemaVersion = schema?.user_version ?? 0;
      if (schemaVersion === 0) {
        await database.execAsync("PRAGMA auto_vacuum = INCREMENTAL;");
      }
      await database.execAsync(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;",
      );
      await database.withExclusiveTransactionAsync(async (transaction) => {
        await transaction.execAsync("PRAGMA busy_timeout = 3000;");
        await transaction.execAsync(`
              CREATE TABLE IF NOT EXISTS client_cache (
                environment_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                payload TEXT NOT NULL,
                payload_bytes INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (environment_id, kind, cache_key)
              ) WITHOUT ROWID;

              CREATE INDEX IF NOT EXISTS client_cache_environment_updated
                ON client_cache (environment_id, updated_at DESC);

              CREATE TABLE IF NOT EXISTS client_preferences (
                singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL
              );
            `);
      });
      const payloadBytesColumn = await database.getFirstAsync<{ readonly present: number }>(
        `SELECT 1 AS present
         FROM pragma_table_info('client_cache')
         WHERE name = 'payload_bytes'`,
      );
      if (payloadBytesColumn === null) {
        await database.withExclusiveTransactionAsync(async (transaction) => {
          await transaction.execAsync("PRAGMA busy_timeout = 3000;");
          await transaction.runAsync(
            "DELETE FROM client_cache WHERE LENGTH(CAST(payload AS BLOB)) > ?",
            MOBILE_CACHE_MAX_ROW_BYTES,
          );
          await transaction.runAsync(
            `WITH sized AS (
               SELECT
                 environment_id,
                 kind,
                 cache_key,
                 updated_at,
                 LENGTH(CAST(payload AS BLOB)) AS payload_bytes
               FROM client_cache
             ),
             candidates AS (
               SELECT
                 environment_id,
                 kind,
                 cache_key,
                 COALESCE(
                   SUM(payload_bytes) OVER (
                     ORDER BY updated_at ASC, environment_id ASC, kind ASC, cache_key ASC
                     ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                   ),
                   0
                 ) AS bytes_before,
                 SUM(payload_bytes) OVER () AS total_bytes
               FROM sized
             )
             DELETE FROM client_cache
             WHERE (environment_id, kind, cache_key) IN (
               SELECT environment_id, kind, cache_key
               FROM candidates
               WHERE bytes_before < total_bytes - ?
             )`,
            MOBILE_CACHE_MAX_TOTAL_BYTES,
          );
          await transaction.execAsync(
            `ALTER TABLE client_cache
               ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0;
             UPDATE client_cache
               SET payload_bytes = LENGTH(CAST(payload AS BLOB));`,
          );
        });
      }
      await database.execAsync(
        `CREATE INDEX IF NOT EXISTS client_cache_lru
           ON client_cache (updated_at ASC, environment_id, kind, cache_key, payload_bytes);`,
      );
      const migrated = schemaVersion >= 1 || (await migrateLegacyFileCaches(database));
      if (migrated && schemaVersion < DATABASE_SCHEMA_VERSION) {
        await database.execAsync(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};`);
      }
    },
    catch: databaseError("migrate"),
  });

  startupMaintenance = cacheOperations.schedule(CACHE_STARTUP_MAINTENANCE_DELAY_MS, async () => {
    try {
      await runStartupCacheMaintenance(database);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.name : "Unknown";
      recordMobileDiagnostic("cache", { op: "maintenance-failed", reason });
      console.warn("[mobile-database] could not complete cache startup maintenance", { reason });
    }
  });

  return MobileDatabase.of({
    loadCache: Effect.fn("MobileDatabase.loadCache")((environmentId, kind, cacheKey) =>
      Effect.tryPromise({
        try: () =>
          cacheOperations.run(() => loadCacheRecord(database, { environmentId, kind, cacheKey })),
        catch: databaseError("load-cache"),
      }).pipe(Effect.map((row) => Option.fromNullishOr(row?.payload))),
    ),
    saveCache: Effect.fn("MobileDatabase.saveCache")(
      (environmentId, kind, cacheKey, schemaVersion, payload) =>
        Effect.tryPromise({
          try: () =>
            cacheOperations.run(() =>
              saveBoundedCacheRecord(database, {
                environmentId,
                kind,
                cacheKey,
                schemaVersion,
                payload,
              }),
            ),
          catch: databaseError("save-cache"),
        }).pipe(
          Effect.tap((result) => {
            if (result.skipped) {
              recordCacheWriteSkipped(environmentId, kind, result.payloadBytes);
              return Effect.logWarning("Skipped oversized mobile client cache record.", {
                environmentId: diagnosticEnvironmentKey(environmentId),
                kind,
                payloadSize: cachePayloadSizeBucket(result.payloadBytes),
                limitMiB: MOBILE_CACHE_MAX_ROW_BYTES / MEBIBYTE,
              });
            }
            recordCachePruned(result, "save");
            return Effect.void;
          }),
          Effect.asVoid,
        ),
    ),
    removeCache: Effect.fn("MobileDatabase.removeCache")((environmentId, kind, cacheKey) =>
      Effect.tryPromise({
        try: () =>
          cacheOperations.run(() =>
            database.runAsync(
              `DELETE FROM client_cache
                       WHERE environment_id = ? AND kind = ? AND cache_key = ?`,
              environmentId,
              kind,
              cacheKey,
            ),
          ),
        catch: databaseError("remove-cache"),
      }).pipe(Effect.asVoid),
    ),
    clearCacheKind: Effect.fn("MobileDatabase.clearCacheKind")((environmentId, kind) =>
      Effect.tryPromise({
        try: () =>
          cacheOperations.run(() =>
            database.runAsync(
              "DELETE FROM client_cache WHERE environment_id = ? AND kind = ?",
              environmentId,
              kind,
            ),
          ),
        catch: databaseError("clear-cache-kind"),
      }).pipe(Effect.asVoid),
    ),
    clearEnvironmentCache: Effect.fn("MobileDatabase.clearEnvironmentCache")((environmentId) =>
      Effect.tryPromise({
        try: () =>
          cacheOperations.run(() =>
            database.runAsync("DELETE FROM client_cache WHERE environment_id = ?", environmentId),
          ),
        catch: databaseError("clear-environment-cache"),
      }).pipe(Effect.asVoid),
    ),
    clearAllCaches: Effect.tryPromise({
      try: () => cacheOperations.run(() => database.runAsync("DELETE FROM client_cache")),
      catch: databaseError("clear-all-caches"),
    }).pipe(Effect.asVoid),
    inspectCaches: Effect.tryPromise({
      try: () =>
        cacheOperations.run(() =>
          database.getAllAsync<unknown>(`
                SELECT
                  environment_id AS environmentId,
                  kind,
                  COUNT(*) AS recordCount,
                  COALESCE(SUM(payload_bytes), 0) AS payloadBytes
                FROM client_cache
                GROUP BY environment_id, kind
                ORDER BY environment_id, kind
              `),
        ),
      catch: databaseError("inspect-caches"),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ClientCacheSummaryRows)),
      Effect.mapError(databaseError("inspect-caches")),
      Effect.map(
        (rows): ReadonlyArray<ClientCacheSummaryRow> =>
          rows.map((row) => ({
            environmentId: row.environmentId as EnvironmentId,
            kind: row.kind,
            recordCount: row.recordCount,
            payloadBytes: row.payloadBytes,
          })),
      ),
    ),
    loadPreferencesJson: Effect.tryPromise({
      try: () =>
        database.getFirstAsync<StoredPreferencesJson>(
          `SELECT payload, updated_at AS updatedAt
                 FROM client_preferences
                 WHERE singleton = 1`,
        ),
      catch: databaseError("load-preferences"),
    }).pipe(Effect.map(Option.fromNullishOr)),
    savePreferencesJson: Effect.fn("MobileDatabase.savePreferencesJson")((payload, updatedAt) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            `INSERT INTO client_preferences (singleton, payload, updated_at)
                   VALUES (1, ?, ?)
                   ON CONFLICT (singleton) DO UPDATE SET
                     payload = excluded.payload,
                     updated_at = excluded.updated_at`,
            payload,
            updatedAt,
          ),
        catch: databaseError("save-preferences"),
      }).pipe(Effect.asVoid),
    ),
  });
});

function makeUnavailable(error: MobileDatabaseError): MobileDatabase["Service"] {
  const fail = Effect.fail(error);
  return MobileDatabase.of({
    loadCache: () => fail,
    saveCache: () => fail,
    removeCache: () => fail,
    clearCacheKind: () => fail,
    clearEnvironmentCache: () => fail,
    clearAllCaches: fail,
    inspectCaches: fail,
    loadPreferencesJson: fail,
    savePreferencesJson: () => fail,
  });
}

export const make = Effect.result(makeAvailable).pipe(
  Effect.map((result) =>
    result._tag === "Success" ? result.success : makeUnavailable(result.failure),
  ),
);

export const layer = Layer.effect(MobileDatabase, make);
