import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Migrations the fork recorded in effect_sql_migrations before it moved its
// schema to the fork ledger (ForkMigrations.ts). Their schema is retired.
export const forkOnlyMigrationNames: ReadonlySet<string> = new Set([
  "ProviderSessionRuntimeRevision",
  "ProjectionThreadMessageInputOrigin",
  "ProjectionProjectRepositoryIdentity",
  "ProjectionMessageSpeech",
  "ProjectionMessageSummary",
  "ProjectionMessageGenerationContext",
  "BackfillImportedThreadSessions",
  "ProjectionThreadsMovedToTop",
  "ProjectionMessageSpeechOrigin",
  "ProjectionMessageSpeechRequest",
  "ProjectionThreadArchiveRequest",
  "ProjectionThreadsSnoozedUntilTurn",
  "DropRetiredMovedToTopEvents",
  "ProjectionThreadWorktreeSwitch",
  "ProjectionThreadCustomGroup",
  "ProjectionMessageSpeechDuration",
]);

// V2 previews recorded these at 53..55; reconcileV2PreviewMigration owns that shape.
const previewMigrationNames: ReadonlySet<string> = new Set([
  "OrchestrationV2",
  "RemoveRedundantProjectionIndexes",
]);

const badState = (message: string) => new Migrator.MigrationError({ kind: "BadState", message });

/**
 * Rewrites a fork database's migration ledger to upstream ids before upstream's
 * migrator runs. Fork builds interleaved fork-only migrations with upstream ones,
 * so upstream migrations sit at relocated ids and the recorded maximum masks
 * newer upstream ids. Upstream rows are mapped back by name (their files are
 * identical to upstream's), fork-only rows leave the ledger, and every original
 * row is kept in fork_legacy_migrations. Runs from `runMigrations` before the
 * V2 preview reconcile. Returns the original rows it moved; ledgers with neither
 * fork-only rows nor relocated upstream rows (including V2 previews) are left
 * untouched.
 */
export const repairForkMigrationHistory = Effect.fn("repairForkMigrationHistory")(function* (
  manifest: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
      const upstreamIds = new Map(manifest.map(([id, name]) => [name, id]));
      const isForkHistory = history.some((row) => {
        const upstreamId = upstreamIds.get(row.name);
        return (
          forkOnlyMigrationNames.has(row.name) ||
          (upstreamId !== undefined &&
            upstreamId !== row.migration_id &&
            !previewMigrationNames.has(row.name))
        );
      });
      if (!isForkHistory) return [];

      const unknown = history.filter(
        (row) => !upstreamIds.has(row.name) && !forkOnlyMigrationNames.has(row.name),
      );
      if (unknown.length > 0) {
        return yield* badState(
          `Cannot repair fork migration history: unknown migrations ${unknown.map((row) => `${row.migration_id}_${row.name}`).join(", ")}.`,
        );
      }
      const upstreamRows = history
        .flatMap((row) => {
          const upstreamId = upstreamIds.get(row.name);
          return upstreamId === undefined ? [] : [{ ...row, upstreamId }];
        })
        .sort((a, b) => a.upstreamId - b.upstreamId);
      const mismatch = upstreamRows.findIndex((row, index) => row.upstreamId !== index + 1);
      const misplaced = upstreamRows[mismatch];
      if (misplaced !== undefined) {
        return yield* badState(
          `Cannot repair fork migration history: recorded upstream migrations are not a contiguous prefix of this build's manifest; expected ${mismatch + 1}_${manifest[mismatch]?.[1]}, found ${misplaced.upstreamId}_${misplaced.name} (recorded as ${misplaced.migration_id}).`,
        );
      }
      const audited = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fork_legacy_migrations'
      `;
      if (audited.length > 0) {
        return yield* badState(
          "Cannot repair fork migration history: fork_legacy_migrations already exists.",
        );
      }

      yield* sql`
        CREATE TABLE fork_legacy_migrations (
          migration_id INTEGER PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `;
      for (const row of history) {
        yield* sql`
          INSERT INTO fork_legacy_migrations (migration_id, name, created_at)
          VALUES (${row.migration_id}, ${row.name}, ${row.created_at})
        `;
      }
      yield* sql`DELETE FROM effect_sql_migrations`;
      for (const row of upstreamRows) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          VALUES (${row.upstreamId}, ${row.name}, ${row.created_at})
        `;
      }
      const moved = history.map((row) => `${row.migration_id}_${row.name}`);
      yield* Effect.log("Repaired fork migration history").pipe(
        Effect.annotateLogs({ forkLegacyMigrations: moved }),
      );
      return history.map((row) => [row.migration_id, row.name] as const);
    }),
  );
});
