import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { forkOnlyMigrationNames, repairForkMigrationHistory } from "./forkMigrationHistory.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

// The fork database's effect_sql_migrations at 0b14af6127, verbatim.
const forkLedger: ReadonlyArray<readonly [number, string, string]> = [
  [1, "OrchestrationEvents", "2026-05-20 13:51:23"],
  [2, "OrchestrationCommandReceipts", "2026-05-20 13:51:23"],
  [3, "CheckpointDiffBlobs", "2026-05-20 13:51:23"],
  [4, "ProviderSessionRuntime", "2026-05-20 13:51:23"],
  [5, "Projections", "2026-05-20 13:51:23"],
  [6, "ProjectionThreadSessionRuntimeModeColumns", "2026-05-20 13:51:23"],
  [7, "ProjectionThreadMessageAttachments", "2026-05-20 13:51:23"],
  [8, "ProjectionThreadActivitySequence", "2026-05-20 13:51:23"],
  [9, "ProviderSessionRuntimeMode", "2026-05-20 13:51:23"],
  [10, "ProjectionThreadsRuntimeMode", "2026-05-20 13:51:23"],
  [11, "OrchestrationThreadCreatedRuntimeMode", "2026-05-20 13:51:23"],
  [12, "ProjectionThreadsInteractionMode", "2026-05-20 13:51:23"],
  [13, "ProjectionThreadProposedPlans", "2026-05-20 13:51:23"],
  [14, "ProjectionThreadProposedPlanImplementation", "2026-05-20 13:51:23"],
  [15, "ProjectionTurnsSourceProposedPlan", "2026-05-20 13:51:23"],
  [16, "CanonicalizeModelSelections", "2026-05-20 13:51:23"],
  [17, "ProjectionThreadsArchivedAt", "2026-05-20 13:51:23"],
  [18, "ProjectionThreadsArchivedAtIndex", "2026-05-20 13:51:23"],
  [19, "ProjectionSnapshotLookupIndexes", "2026-05-20 13:51:23"],
  [20, "AuthAccessManagement", "2026-05-20 13:51:23"],
  [21, "AuthSessionClientMetadata", "2026-05-20 13:51:23"],
  [22, "AuthSessionLastConnectedAt", "2026-05-20 13:51:23"],
  [23, "ProjectionThreadShellSummary", "2026-05-20 13:51:23"],
  [24, "BackfillProjectionThreadShellSummary", "2026-05-20 13:51:23"],
  [25, "CleanupInvalidProjectionPendingApprovals", "2026-05-20 13:51:23"],
  [26, "CanonicalizeModelSelectionOptions", "2026-05-20 13:51:23"],
  [27, "ProviderSessionRuntimeInstanceId", "2026-05-20 13:51:23"],
  [28, "ProjectionThreadSessionInstanceId", "2026-05-20 13:51:23"],
  [29, "ProjectionThreadDetailOrderingIndexes", "2026-05-20 13:51:23"],
  [30, "ProjectionThreadShellArchiveIndexes", "2026-05-20 13:51:23"],
  [31, "AuthAuthorizationScopes", "2026-06-24 10:32:26"],
  [32, "AuthPairingProofKeyThumbprint", "2026-06-24 10:32:26"],
  [33, "ProviderSessionRuntimeRevision", "2026-07-15 19:19:35"],
  [34, "ProjectionThreadMessageInputOrigin", "2026-07-21 09:47:51"],
  [35, "ProjectionProjectRepositoryIdentity", "2026-07-22 06:16:29"],
  [36, "ProjectionMessageSpeech", "2026-07-22 06:16:29"],
  [37, "ProjectionMessageSummary", "2026-07-22 13:06:40"],
  [38, "ProjectionMessageGenerationContext", "2026-07-22 13:06:40"],
  [39, "ProjectionThreadsSettled", "2026-07-23 08:29:26"],
  [40, "BackfillImportedThreadSessions", "2026-07-24 07:27:49"],
  [41, "ProjectionThreadsSnoozed", "2026-07-25 12:22:03"],
  [42, "ProjectionThreadTitleRegeneration", "2026-07-31 09:39:13"],
  [43, "ProjectionThreadsMovedToTop", "2026-08-05 06:46:09"],
  [44, "ProjectionThreadsPinned", "2026-08-05 06:46:09"],
  [45, "ProjectionTurnsKeysetIndex", "2026-08-07 06:26:12"],
  [46, "ProjectionThreadsPinOrderKey", "2026-08-08 05:38:30"],
  [47, "ProjectionProjectsDefaultThreadEnvMode", "2026-08-09 10:25:13"],
  [48, "ProjectionProjectFaviconPath", "2026-08-09 10:25:13"],
  [49, "AuthSessionClientConnection", "2026-08-23 07:34:06"],
  [50, "ProjectionMessageSpeechOrigin", "2026-08-24 16:27:39"],
  [51, "ProjectionThreadLinkedPullRequest", "2026-08-25 09:29:30"],
  [52, "ProjectionThreadsUnsettledAt", "2026-08-27 20:42:03"],
  [53, "ProjectionMessageSpeechRequest", "2026-08-27 20:42:03"],
  [54, "ClearAutomaticProjectModelDefaults", "2026-09-02 14:22:37"],
  [55, "ProjectionProjectsAutoPull", "2026-09-03 07:05:52"],
  [56, "RepairAutomaticSettlementTimestamps", "2026-09-03 07:05:52"],
  [57, "ProjectionProjectIcon", "2026-09-05 12:06:35"],
  [58, "ProjectionThreadBranchPullRequest", "2026-09-08 09:49:06"],
  [59, "ProjectionThreadsActiveOrderKey", "2026-09-08 09:49:06"],
  [60, "ProjectionThreadArchiveRequest", "2026-09-10 03:23:14"],
  [61, "ProjectionThreadsSnoozedUntilTurn", "2026-09-10 03:23:14"],
  [62, "DropRetiredMovedToTopEvents", "2026-09-10 03:36:05"],
  [63, "ProjectionThreadPullRequests", "2026-09-11 07:02:04"],
  [64, "ProjectionThreadMessageContext", "2026-09-14 07:11:45"],
  [65, "ProjectionThreadWorktreeSwitch", "2026-09-14 16:18:03"],
  [66, "ProjectionThreadTitleState", "2026-09-16 03:41:21"],
  [67, "ProjectionThreadCustomGroup", "2026-09-16 03:41:21"],
  [68, "ProjectionMessageSpeechDuration", "2026-09-17 08:21:54"],
  [69, "PullRequestFilesViewed", "2026-09-18 08:52:19"],
  [70, "ProjectionThreadsAutoSettleDisabledAt", "2026-09-25 12:58:23"],
];

type LedgerRow = {
  readonly migration_id: number;
  readonly name: string;
  readonly created_at: string;
};

// Upstream schema through `schema` plus the legacy fork columns fork migration 1
// copies, with the given fork ledger recorded in place.
const seedForkLedger = (
  ledger: ReadonlyArray<readonly [number, string, string]> = forkLedger,
  schema = 54,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: schema });
    const recorded = new Set(ledger.map(([, name]) => name));
    if (recorded.has("ProjectionThreadCustomGroup")) {
      yield* sql`ALTER TABLE projection_threads ADD COLUMN custom_group_id TEXT`;
    }
    if (recorded.has("ProjectionProjectRepositoryIdentity")) {
      yield* sql`ALTER TABLE projection_projects ADD COLUMN repository_identity_json TEXT`;
    }
    yield* sql`DELETE FROM effect_sql_migrations`;
    for (const [id, name, createdAt] of ledger) {
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (${id}, ${name}, ${createdAt})
      `;
    }
  });

const readLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<LedgerRow>`
    SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id
  `;
});

const expectBadState = Effect.fn(function* (message: string) {
  const sql = yield* SqlClient.SqlClient;
  const before = yield* readLedger;
  const error = yield* Effect.flip(runMigrations());
  assert.strictEqual(error._tag, "MigrationError");
  assert.strictEqual("kind" in error ? error.kind : undefined, "BadState");
  assert.include(error.message, message);
  assert.deepStrictEqual(yield* readLedger, before);
  assert.deepStrictEqual(
    yield* sql`SELECT name FROM sqlite_master WHERE name = 'fork_legacy_migrations'`,
    [],
  );
});

describe("repairForkMigrationHistory", () => {
  it.effect("maps the fork ledger to upstream ids so 055 onwards run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkLedger();
      assert.deepStrictEqual(yield* runMigrations(), [
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
      ]);
      const ledger = yield* readLedger;
      assert.deepStrictEqual(
        ledger.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      const forkCreatedAt = new Map(forkLedger.map(([, name, createdAt]) => [name, createdAt]));
      for (const row of ledger.filter((row) => row.migration_id <= 54)) {
        assert.strictEqual(row.created_at, forkCreatedAt.get(row.name));
      }
      assert.deepStrictEqual(
        yield* sql<LedgerRow>`
          SELECT migration_id, name, created_at FROM fork_legacy_migrations ORDER BY migration_id
        `,
        forkLedger.map(([migration_id, name, created_at]) => ({ migration_id, name, created_at })),
      );

      // Idempotent: nothing left to repair or run.
      assert.deepStrictEqual(yield* repairForkMigrationHistory(migrationManifest), []);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* readLedger, ledger);
      assert.strictEqual((yield* sql`SELECT * FROM fork_legacy_migrations`).length, 70);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("maps relocated upstream rows without fork-only rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const relocated = forkLedger.filter(([, name]) => !forkOnlyMigrationNames.has(name));
      yield* seedForkLedger(relocated);
      assert.deepStrictEqual(yield* runMigrations(), [
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
      ]);
      assert.deepStrictEqual(
        (yield* readLedger).map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.strictEqual(
        (yield* sql`SELECT * FROM fork_legacy_migrations`).length,
        relocated.length,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("maps an older fork ledger and runs the remaining upstream migrations", () =>
    Effect.gen(function* () {
      yield* seedForkLedger(forkLedger.slice(0, 60), 49);
      assert.deepStrictEqual(
        (yield* runMigrations()).map(([id]) => id),
        [50, 51, 52, 53, 54, 55, 56, 57, 58],
      );
      assert.deepStrictEqual(
        (yield* readLedger).map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("carries legacy fork columns through 055/056 into the fork tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkLedger();
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at, repository_identity_json)
        VALUES
          ('project-a', 'A', '/tmp/a', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{"remote":"a"}')
      `;
      yield* sql`
        INSERT INTO projection_threads
          (thread_id, project_id, title, created_at, updated_at, custom_group_id)
        VALUES
          ('thread-a', 'project-a', 'T', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'group-1'),
          ('thread-b', 'project-a', 'U', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)
      `;
      yield* runMigrations();
      assert.deepStrictEqual(yield* sql`SELECT * FROM fork_thread_custom_groups`, [
        { thread_id: "thread-a", custom_group_id: "group-1" },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM fork_project_repository_identity`, [
        {
          project_id: "project-a",
          repository_identity_json: '{"remote":"a"}',
          // Fork migration 4 scopes the identity to the project's root.
          workspace_root: "/tmp/a",
        },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("is a no-op on fresh and upstream-only databases", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* repairForkMigrationHistory(migrationManifest), []);
      yield* runMigrations();
      const ledger = yield* readLedger;
      assert.deepStrictEqual(yield* repairForkMigrationHistory(migrationManifest), []);
      assert.deepStrictEqual(yield* readLedger, ledger);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'fork_legacy_migrations'`,
        [],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses unknown migration names", () =>
    Effect.gen(function* () {
      yield* seedForkLedger([...forkLedger, [71, "UnknownFork", "2026-10-01 00:00:00"]]);
      yield* expectBadState("unknown migrations 71_UnknownFork");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses upstream migrations that are not a contiguous prefix", () =>
    Effect.gen(function* () {
      yield* seedForkLedger(forkLedger.filter(([, name]) => name !== "ProjectionThreadsSnoozed"));
      yield* expectBadState(
        "expected 34_ProjectionThreadsSnoozed, found 35_ProjectionThreadTitleRegeneration (recorded as 42)",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
