import { assert, describe, it } from "@effect/vitest";
import type { RepositoryIdentity } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";

import { runForkMigrations } from "../persistence/ForkMigrations.ts";
import * as ProjectEnrichment from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectRepositoryIdentityStore from "./ProjectRepositoryIdentityStore.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const identity = (name: string): RepositoryIdentity => ({
  canonicalKey: `example.test/acme/${name}`,
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: `https://example.test/acme/${name}.git`,
  },
  rootPath: "/repo",
  name,
});

// A fresh enrichment service has empty caches, like one after a server restart.
const enrichmentLayer = (resolve: (workspaceRoot: string) => RepositoryIdentity | null) =>
  Layer.effect(ProjectEnrichment.ProjectEnrichmentService, ProjectEnrichment.make()).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (workspaceRoot) => Effect.succeed(resolve(workspaceRoot)),
        }),
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          resolvePath: () => Effect.succeed(null),
        }),
        ProjectRepositoryIdentityStore.layer,
      ),
    ),
  );

/** Request resolution and wait for the worker's completion notification. */
const resolveOnce = Effect.fn("ProjectRepositoryIdentityStoreTest.resolveOnce")(function* (
  workspaceRoot: string,
) {
  const service = yield* ProjectEnrichment.ProjectEnrichmentService;
  const changes = yield* service.subscribeChanges;
  yield* service.request(workspaceRoot);
  const change = yield* PubSub.take(changes);
  assert.equal(change.workspaceRoot, workspaceRoot);
  return change;
});

const setupProjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The columns the store reads from upstream's project table.
  yield* sql`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* runForkMigrations();
  yield* sql`INSERT INTO projection_projects (project_id, workspace_root) VALUES ('p1', '/repo')`;
  return sql;
});

const storedRows = (sql: SqlClient.SqlClient) =>
  sql<{ readonly project_id: string; readonly workspace_root: string; readonly name: string }>`
    SELECT project_id, workspace_root, json_extract(repository_identity_json, '$.name') AS name
    FROM fork_project_repository_identity
  `;

describe("durable repository identity", () => {
  it.effect("falls back to the last resolved identity after the checkout is gone", () =>
    Effect.gen(function* () {
      const sql = yield* setupProjects;

      const resolved = yield* resolveOnce("/repo").pipe(
        Effect.scoped,
        Effect.provide(enrichmentLayer(() => identity("app"))),
      );
      assert.equal(resolved.enrichment.repositoryIdentity?.name, "app");
      assert.deepStrictEqual(yield* storedRows(sql), [
        { project_id: "p1", workspace_root: "/repo", name: "app" },
      ]);

      yield* Effect.gen(function* () {
        const service = yield* ProjectEnrichment.ProjectEnrichmentService;
        // Before the live probe finishes, the stored identity is served.
        const cold = yield* service.peek("/repo");
        assert.isFalse(cold.repositoryIdentityResolved);
        assert.equal(cold.repositoryIdentity?.name, "app");
        // A probe that finds nothing keeps the stored identity in the pushed refresh.
        const gone = yield* resolveOnce("/repo");
        assert.isTrue(gone.repositoryIdentityResolved);
        assert.equal(gone.enrichment.repositoryIdentity?.name, "app");
        assert.equal((yield* service.peek("/repo")).repositoryIdentity?.name, "app");
      }).pipe(Effect.scoped, Effect.provide(enrichmentLayer(() => null)));
      // A failed resolution never clears what was stored.
      assert.lengthOf(yield* storedRows(sql), 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "replaces a changed identity and ignores rows for another root or deleted projects",
    () =>
      Effect.gen(function* () {
        const sql = yield* setupProjects;
        const store = yield* ProjectRepositoryIdentityStore.make;

        yield* store.record("/repo", identity("app"));
        yield* store.record("/repo", identity("renamed"));
        assert.equal((yield* store.get("/repo"))?.name, "renamed");
        // No active project owns this root, so nothing is written.
        yield* store.record("/elsewhere", identity("other"));
        assert.deepStrictEqual(yield* storedRows(sql), [
          { project_id: "p1", workspace_root: "/repo", name: "renamed" },
        ]);

        // The project moved: the identity resolved for the old folder no longer applies.
        yield* sql`UPDATE projection_projects SET workspace_root = '/moved' WHERE project_id = 'p1'`;
        assert.isNull(yield* store.get("/moved"));
        yield* store.record("/moved", identity("moved"));
        assert.equal((yield* store.get("/moved"))?.name, "moved");

        yield* sql`UPDATE projection_projects SET deleted_at = '2026-10-04T00:00:00.000Z'`;
        assert.isNull(yield* store.get("/moved"));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
