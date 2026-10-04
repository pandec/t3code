/**
 * Fork-owned migrations, recorded in their own ledger (fork_sql_migrations,
 * ids from 1) and run by `runMigrations` after upstream's migrations.
 *
 * Rule: fork schema lives only in fork-owned tables through this ledger. Never
 * add fork files to Migrations/ or ALTER upstream tables; upstream ids and
 * tables stay upstream's.
 */

import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import ForkMigration0001 from "./ForkMigrations/001_ForkThreadGroupsAndRepositoryIdentity.ts";

export const forkMigrationEntries = [
  [1, "ForkThreadGroupsAndRepositoryIdentity", ForkMigration0001],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const run = Migrator.make({});

/** Runs pending fork migrations and logs them; returns the [id, name] pairs it executed. */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* run({
    table: "fork_sql_migrations",
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
  if (executed.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ forkMigrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
