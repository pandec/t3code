import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";
import * as ServiceLauncherClient from "../../cloud/serviceLauncherClient.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly readonly?: boolean;
  readonly readwrite?: boolean;
  readonly create?: boolean;
  readonly disableWAL?: boolean;
  readonly spanAttributes?: Record<string, unknown>;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient, SqlError>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const loader = defaultSqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<Loader>(loader);
  return clientModule.layer(config);
}, Layer.unwrap);

const setup = (trial: boolean) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The server and the CLI open this database concurrently; wait for locks
      // instead of surfacing immediate SQLITE_BUSY failures.
      yield* sql`PRAGMA busy_timeout = 5000;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      if (!trial) {
        yield* sql`PRAGMA journal_mode = WAL;`;
        yield* runMigrations();
      }
    }),
  );

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
  options?: { readonly trial?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    setup(options?.trial === true),
    makeRuntimeSqliteLayer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup(false),
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

/**
 * Read-only connection to an existing database. Runs no pragmas and no
 * migrations, so it can be opened safely next to a live server process that
 * owns the schema.
 */
export const makeSqliteReadOnlyPersistence = Effect.fn("makeSqliteReadOnlyPersistence")(function* (
  dbPath: string,
) {
  const path = yield* Path.Path;
  return makeRuntimeSqliteLayer({
    filename: dbPath,
    // The bun client defaults readwrite/create to true and runs a WAL pragma
    // even with readonly set, so every flag must be pinned explicitly for the
    // connection to actually reject writes on both runtimes.
    readonly: true,
    readwrite: false,
    create: false,
    disableWAL: true,
    spanAttributes: {
      "db.name": path.basename(dbPath),
      "service.name": "t3-server",
    },
  });
}, Layer.unwrap);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const launcher = yield* ServiceLauncherClient.resolveServiceLauncherMode();
    return makeSqlitePersistenceLive(dbPath, { trial: launcher.trial });
  }),
);

export const layerReadOnlyConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqliteReadOnlyPersistence(dbPath)),
);
