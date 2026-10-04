import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { forkMigrationManifest, runForkMigrations } from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

describe("fork migrations", () => {
  it.effect("run after upstream migrations in their own ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      assert.deepStrictEqual(
        (yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM fork_sql_migrations ORDER BY migration_id
        `).map((row) => [row.migration_id, row.name] as const),
        forkMigrationManifest,
      );
      assert.deepStrictEqual(
        (yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
        `).map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      // Fresh databases have no legacy columns to copy from.
      assert.deepStrictEqual(yield* sql`SELECT * FROM fork_thread_custom_groups`, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM fork_project_repository_identity`, []);
      assert.deepStrictEqual(yield* runForkMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("migration 1 copies legacy group membership and repository identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, custom_group_id TEXT)`;
      yield* sql`
        CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, repository_identity_json TEXT)
      `;
      yield* sql`
        INSERT INTO projection_threads (thread_id, custom_group_id)
        VALUES ('thread-a', 'group-1'), ('thread-b', NULL)
      `;
      yield* sql`
        INSERT INTO projection_projects (project_id, repository_identity_json)
        VALUES ('project-a', '{"remote":"github.com/a/b"}'), ('project-b', NULL)
      `;
      assert.deepStrictEqual(yield* runForkMigrations(), [
        [1, "ForkThreadGroupsAndRepositoryIdentity"],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM fork_thread_custom_groups`, [
        { thread_id: "thread-a", custom_group_id: "group-1" },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM fork_project_repository_identity`, [
        { project_id: "project-a", repository_identity_json: '{"remote":"github.com/a/b"}' },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("migration 1 refuses to drop a column the fork ledger recorded", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE fork_legacy_migrations (migration_id INTEGER, name TEXT)`;
      yield* sql`INSERT INTO fork_legacy_migrations VALUES (67, 'ProjectionThreadCustomGroup')`;
      yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)`;
      // The migrator turns a failed migration into a defect.
      const exit = yield* Effect.exit(runForkMigrations());
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.include(Cause.pretty(exit.cause), "projection_threads.custom_group_id is missing");
      }
      assert.deepStrictEqual(yield* sql`SELECT * FROM fork_sql_migrations`, []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("migration 1 succeeds without legacy tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* runForkMigrations(), [
        [1, "ForkThreadGroupsAndRepositoryIdentity"],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM fork_thread_custom_groups`, []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
