/**
 * Fork-owned migrations in their own ledger (fork_sql_migrations), run after
 * upstream's. Fork schema lives only in fork-owned tables: never add fork files
 * to Migrations/ or ALTER upstream tables.
 */

import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import ForkMigration0001 from "./ForkMigrations/001_ForkThreadGroupsAndRepositoryIdentity.ts";
import ForkMigration0002 from "./ForkMigrations/002_ForkNativeContinuation.ts";
import ForkMigration0003 from "./ForkMigrations/003_ForkStrictResumeProviderThreads.ts";
import ForkMigration0004 from "./ForkMigrations/004_ForkProjectRepositoryIdentityWorkspaceRoot.ts";
import ForkMigration0005 from "./ForkMigrations/005_ForkMessageArtifacts.ts";
import ForkMigration0006 from "./ForkMigrations/006_ForkMessageSpeech.ts";
import ForkMigration0007 from "./ForkMigrations/007_ForkThreadHiddenNotes.ts";

export const forkMigrationEntries = [
  [1, "ForkThreadGroupsAndRepositoryIdentity", ForkMigration0001],
  [2, "ForkNativeContinuation", ForkMigration0002],
  [3, "ForkStrictResumeProviderThreads", ForkMigration0003],
  [4, "ForkProjectRepositoryIdentityWorkspaceRoot", ForkMigration0004],
  [5, "ForkMessageArtifacts", ForkMigration0005],
  [6, "ForkMessageSpeech", ForkMigration0006],
  [7, "ForkThreadHiddenNotes", ForkMigration0007],
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
