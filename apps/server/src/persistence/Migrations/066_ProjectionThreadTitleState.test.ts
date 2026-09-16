import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("066_ProjectionThreadTitleState", (it) => {
  it.effect("adds nullable title state after the fork migration ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });

      const before = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isFalse(before.some((column) => column.name === "title_state_json"));

      yield* runMigrations({ toMigrationInclusive: 66 });
      const after = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isTrue(after.some((column) => column.name === "title_state_json"));
      assert.deepEqual(
        migrationManifest.find(([id]) => id === 66),
        [66, "ProjectionThreadTitleState"],
      );
    }),
  );
});
