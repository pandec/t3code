import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Carries custom-group membership and repository identity out of the legacy v1
// columns the fork added to upstream tables. V2 keeps v1 thread and project ids,
// so the copied keys stay valid. Fresh databases have neither column; a fork
// database whose ledger recorded the column's migration must still have it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE fork_thread_custom_groups (
      thread_id TEXT PRIMARY KEY NOT NULL,
      custom_group_id TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE fork_project_repository_identity (
      project_id TEXT PRIMARY KEY NOT NULL,
      repository_identity_json TEXT NOT NULL
    )
  `;
  const legacyRecorded = Effect.fn(function* (migration: string) {
    const audit = yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fork_legacy_migrations'
    `;
    if (audit.length === 0) return false;
    return (yield* sql`SELECT 1 FROM fork_legacy_migrations WHERE name = ${migration}`).length > 0;
  });
  // Whether the legacy column exists; fails if the fork ledger says it should.
  const hasLegacyColumn = Effect.fn(function* (table: string, column: string, migration: string) {
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table})
    `;
    if (columns.some((row) => row.name === column)) return true;
    if (!(yield* legacyRecorded(migration))) return false;
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: `Fork ledger recorded ${migration} but ${table}.${column} is missing; refusing to drop its data.`,
    });
  });
  if (
    yield* hasLegacyColumn("projection_threads", "custom_group_id", "ProjectionThreadCustomGroup")
  ) {
    yield* sql`
      INSERT INTO fork_thread_custom_groups (thread_id, custom_group_id)
      SELECT thread_id, custom_group_id FROM projection_threads
      WHERE custom_group_id IS NOT NULL
    `;
  }
  if (
    yield* hasLegacyColumn(
      "projection_projects",
      "repository_identity_json",
      "ProjectionProjectRepositoryIdentity",
    )
  ) {
    yield* sql`
      INSERT INTO fork_project_repository_identity (project_id, repository_identity_json)
      SELECT project_id, repository_identity_json FROM projection_projects
      WHERE repository_identity_json IS NOT NULL
    `;
  }
});
