import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_ProviderSessionRuntimeRevision", (it) => {
  it.effect("backfills existing runtime rows with revision zero", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at
        )
        VALUES (
          'thread-before-revision',
          'claudeAgent',
          'claudeAgent',
          'claudeAgent',
          'full-access',
          'running',
          '2026-07-15T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 33 });

      const rows = yield* sql<{ readonly revision: number }>`
        SELECT revision
        FROM provider_session_runtime
        WHERE thread_id = 'thread-before-revision'
      `;
      assert.deepStrictEqual(rows, [{ revision: 0 }]);
    }),
  );
});
