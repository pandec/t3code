import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds a monotonic row revision for compare-and-set updates. Activity timestamps
 * are wall-clock values and can repeat or move backwards, so they cannot safely
 * double as persistence versions.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_session_runtime)
  `;
  if (!columns.some((column) => column.name === "revision")) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN revision INTEGER NOT NULL DEFAULT 0
    `;
  }
});
