import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { SQLiteDatabase } from "expo-sqlite";
import * as NodeSqlite from "node:sqlite";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));

import {
  decodeLegacyCacheRecord,
  loadCacheRecord,
  make,
  runStartupCacheMaintenance,
  saveBoundedCacheRecord,
  utf8ByteLength,
} from "./mobile-database";

function sqliteValue(value: unknown): NodeSqlite.SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  throw new Error("Unsupported SQLite test parameter.");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function makeCacheDatabase(
  options: {
    readonly incrementalAutoVacuum?: boolean;
    readonly failAutoVacuumConversion?: boolean;
    readonly preferenceWriteGate?: Promise<void>;
    readonly onPreferenceWriteStarted?: () => void;
    readonly onPreferenceWriteFinished?: () => void;
    readonly onClose?: () => void;
  } = {},
) {
  const sqlite = new NodeSqlite.DatabaseSync(":memory:");
  const executedSql: string[] = [];
  if (options.incrementalAutoVacuum !== false) {
    sqlite.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  }
  sqlite.exec(`
    PRAGMA user_version = 3;

    CREATE TABLE client_cache (
      environment_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (environment_id, kind, cache_key)
    ) WITHOUT ROWID;

    CREATE TABLE client_preferences (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE client_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
  const database = {
    execAsync: (sql: string) => {
      executedSql.push(sql);
      if (options.failAutoVacuumConversion === true && sql === "VACUUM;") {
        return Promise.reject(new Error("vacuum unavailable"));
      }
      sqlite.exec(sql);
      return Promise.resolve();
    },
    getFirstAsync: <T>(sql: string, ...params: ReadonlyArray<unknown>): Promise<T | null> => {
      const row = sqlite.prepare(sql).get(...params.map(sqliteValue));
      return Promise.resolve(row === undefined ? null : (row as T));
    },
    runAsync: async (sql: string, ...params: ReadonlyArray<unknown>) => {
      if (sql.includes("INSERT INTO client_preferences")) {
        options.onPreferenceWriteStarted?.();
        await options.preferenceWriteGate;
      }
      const result = sqlite.prepare(sql).run(...params.map(sqliteValue));
      if (sql.includes("INSERT INTO client_preferences")) {
        options.onPreferenceWriteFinished?.();
      }
      return {
        changes: result.changes,
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
    getAllAsync: <T>(sql: string, ...params: ReadonlyArray<unknown>): Promise<T[]> =>
      Promise.resolve(sqlite.prepare(sql).all(...params.map(sqliteValue)) as T[]),
    withExclusiveTransactionAsync: async (run: (transaction: SQLiteDatabase) => Promise<void>) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        await run(database as unknown as SQLiteDatabase);
        sqlite.exec("COMMIT");
      } catch (cause) {
        sqlite.exec("ROLLBACK");
        throw cause;
      }
    },
    closeAsync: () => {
      options.onClose?.();
      sqlite.close();
      return Promise.resolve();
    },
  };

  return {
    database: database as unknown as SQLiteDatabase,
    rows: () =>
      sqlite
        .prepare(
          "SELECT cache_key AS cacheKey, payload, schema_version AS schemaVersion FROM client_cache ORDER BY cache_key",
        )
        .all() as unknown as ReadonlyArray<{
        readonly cacheKey: string;
        readonly payload: string;
        readonly schemaVersion: number;
      }>,
    autoVacuum: () => {
      const row = sqlite.prepare("PRAGMA auto_vacuum").get() as
        | { readonly auto_vacuum: number }
        | undefined;
      return row?.auto_vacuum ?? 0;
    },
    autoVacuumOutcome: () => {
      const row = sqlite
        .prepare("SELECT value FROM client_meta WHERE key = 'auto-vacuum-conversion-v1'")
        .get() as { readonly value: string } | undefined;
      return row?.value ?? null;
    },
    executedSql,
    close: () => sqlite.close(),
  };
}

describe("mobile database cache budgets", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("counts UTF-8 bytes without allocating an encoded copy", () => {
    expect(utf8ByteLength("cache")).toBe(5);
    expect(utf8ByteLength("é😀")).toBe(6);
  });

  it("skips oversized rows and removes the superseded snapshot", async () => {
    const cache = makeCacheDatabase();
    try {
      const identity = { environmentId, kind: "thread", cacheKey: "thread-1" } as const;
      await saveBoundedCacheRecord(
        cache.database,
        { ...identity, schemaVersion: 1, payload: "old" },
        { maxRowBytes: 4, maxTotalBytes: 16, now: 1 },
      );

      const result = await saveBoundedCacheRecord(
        cache.database,
        { ...identity, schemaVersion: 2, payload: "oversized" },
        { maxRowBytes: 4, maxTotalBytes: 16, now: 2 },
      );

      expect(result.skipped).toBe(true);
      expect(cache.rows()).toEqual([]);
      expect(await loadCacheRecord(cache.database, identity, 3)).toBeNull();
    } finally {
      cache.close();
    }
  });

  it("evicts the least recently accessed row and replaces superseded snapshots", async () => {
    const cache = makeCacheDatabase();
    try {
      const save = (cacheKey: string, payload: string, now: number) =>
        saveBoundedCacheRecord(
          cache.database,
          { environmentId, kind: "thread", cacheKey, schemaVersion: 1, payload },
          { maxRowBytes: 8, maxTotalBytes: 8, now },
        );

      await save("thread-1", "1111", 1);
      await save("thread-2", "2222", 2);
      await loadCacheRecord(
        cache.database,
        { environmentId, kind: "thread", cacheKey: "thread-1" },
        400_000,
      );
      const result = await save("thread-3", "3333", 400_001);

      expect(result.removedRows).toBe(1);
      expect(cache.rows()).toEqual([
        { cacheKey: "thread-1", payload: "1111", schemaVersion: 1 },
        { cacheKey: "thread-3", payload: "3333", schemaVersion: 1 },
      ]);

      await save("thread-3", "new", 400_002);
      expect(cache.rows()).toEqual([
        { cacheKey: "thread-1", payload: "1111", schemaVersion: 1 },
        { cacheKey: "thread-3", payload: "new", schemaVersion: 1 },
      ]);
    } finally {
      cache.close();
    }
  });

  it("prunes an upgraded cache and enables future incremental vacuuming", async () => {
    const cache = makeCacheDatabase({ incrementalAutoVacuum: false });
    try {
      for (const [index, cacheKey] of ["thread-1", "thread-2", "thread-3"].entries()) {
        await saveBoundedCacheRecord(
          cache.database,
          { environmentId, kind: "thread", cacheKey, schemaVersion: 1, payload: "data" },
          { maxRowBytes: 8, maxTotalBytes: 100, now: index + 1 },
        );
      }

      await runStartupCacheMaintenance(cache.database, {
        maxTotalBytes: 8,
        vacuumPasses: 2,
        autoVacuumMinAllocatedBytes: 0,
      });

      expect(cache.autoVacuum()).toBe(2);
      expect(cache.autoVacuumOutcome()).toBe("succeeded");
      expect(cache.rows().map((row) => row.cacheKey)).toEqual(["thread-2", "thread-3"]);
    } finally {
      cache.close();
    }
  });

  it("records a failed auto-vacuum conversion and does not retry it", async () => {
    const cache = makeCacheDatabase({
      incrementalAutoVacuum: false,
      failAutoVacuumConversion: true,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const options = { vacuumPasses: 2, autoVacuumMinAllocatedBytes: 0 } as const;
      await runStartupCacheMaintenance(cache.database, options);
      await runStartupCacheMaintenance(cache.database, options);

      expect(cache.autoVacuumOutcome()).toBe("failed");
      expect(cache.executedSql.filter((sql) => sql === "VACUUM;")).toHaveLength(1);
      expect(cache.executedSql).toContain("PRAGMA journal_mode = WAL;");
      expect(cache.executedSql).toContain("PRAGMA wal_checkpoint(TRUNCATE);");
      expect(cache.executedSql).toContain("PRAGMA optimize;");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[mobile-database] could not enable incremental auto-vacuum",
        { reason: "Error" },
      );
    } finally {
      warn.mockRestore();
      cache.close();
    }
  });

  it("defers auto-vacuum conversion until the database reaches the physical size threshold", async () => {
    const cache = makeCacheDatabase({ incrementalAutoVacuum: false });
    try {
      await runStartupCacheMaintenance(cache.database, {
        vacuumPasses: 0,
        autoVacuumMinAllocatedBytes: Number.MAX_SAFE_INTEGER,
      });

      expect(cache.autoVacuumOutcome()).toBeNull();
      expect(cache.executedSql).not.toContain("VACUUM;");

      await runStartupCacheMaintenance(cache.database, {
        vacuumPasses: 0,
        autoVacuumMinAllocatedBytes: 0,
      });
      expect(cache.autoVacuumOutcome()).toBe("succeeded");
      expect(cache.executedSql.filter((sql) => sql === "VACUUM;")).toHaveLength(1);
    } finally {
      cache.close();
    }
  });
});

describe("mobile database operation ordering", () => {
  it("waits for queued preference saves before closing the database", async () => {
    const writeGate = deferred();
    const writeStarted = deferred();
    const events: string[] = [];
    const cache = makeCacheDatabase({
      preferenceWriteGate: writeGate.promise,
      onPreferenceWriteStarted: () => {
        events.push("preference:start");
        writeStarted.resolve();
      },
      onPreferenceWriteFinished: () => {
        events.push("preference:end");
      },
      onClose: () => {
        events.push("close");
      },
    });
    openDatabaseAsync.mockResolvedValueOnce(cache.database);
    const scope = await Effect.runPromise(Scope.make());
    let close: Promise<void> | null = null;

    try {
      const database = await Effect.runPromise(
        make.pipe(Effect.provideService(Scope.Scope, scope)),
      );
      const save = Effect.runPromise(database.savePreferencesJson("{}", 1));
      await writeStarted.promise;

      close = Effect.runPromise(Scope.close(scope, Exit.void));
      await Promise.resolve();
      expect(events).toEqual(["preference:start"]);

      writeGate.resolve();
      await Promise.all([save, close]);
      expect(events).toEqual(["preference:start", "preference:end", "close"]);
    } finally {
      writeGate.resolve();
      await (close ?? Effect.runPromise(Scope.close(scope, Exit.void)));
    }
  });
});

describe("mobile database legacy cache migration", () => {
  it.effect("keeps acquisition failures typed on database operations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        openDatabaseAsync.mockRejectedValueOnce(new Error("SQLite unavailable"));

        const database = yield* make;
        const result = yield* Effect.result(database.loadPreferencesJson);

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "MobileDatabaseError", operation: "open" },
        });
      }),
    ),
  );

  it("maps legacy thread records to their SQLite identity", () => {
    const payload = JSON.stringify({
      schemaVersion: 2,
      environmentId: "environment-1",
      threadId: "thread-1",
      snapshot: {},
    });

    expect(decodeLegacyCacheRecord("connection-thread-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "thread",
      cacheKey: "thread-1",
      schemaVersion: 2,
      payload,
    });
  });

  it("preserves the old shell payload for schema decoding after migration", () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      environmentId: "environment-1",
      snapshotReceivedAt: "2026-07-01T00:00:00.000Z",
      snapshot: {},
    });

    expect(decodeLegacyCacheRecord("shell-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "shell",
      cacheKey: "snapshot",
      schemaVersion: 1,
      payload,
    });
  });

  it("skips malformed legacy records", () => {
    expect(decodeLegacyCacheRecord("connection-vcs-refs", "{not-json")).toBeNull();
    expect(
      decodeLegacyCacheRecord(
        "connection-vcs-refs",
        JSON.stringify({ schemaVersion: 1, environmentId: "environment-1" }),
      ),
    ).toBeNull();
  });
});
