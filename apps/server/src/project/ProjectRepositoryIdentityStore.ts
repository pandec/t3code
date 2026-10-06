import { RepositoryIdentity } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeRepositoryIdentityJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RepositoryIdentity),
);

/**
 * Fork: the last successful repository identity of the active project at a
 * workspace root, kept in `fork_project_repository_identity`. Enrichment falls
 * back to it when live resolution yields nothing (typically a deleted checkout),
 * so repository grouping survives restarts. It is read-model metadata only;
 * pull-request mutations must verify a live checkout instead.
 *
 * Both methods are best-effort: failures are logged and read as "no value".
 */
export class ProjectRepositoryIdentityStore extends Context.Service<
  ProjectRepositoryIdentityStore,
  {
    /** The stored identity for the active project at this root, if it was resolved there. */
    readonly get: (workspaceRoot: string) => Effect.Effect<RepositoryIdentity | null>;
    /** Store a live identity for the active project at this root; no write when unchanged. */
    readonly record: (workspaceRoot: string, identity: RepositoryIdentity) => Effect.Effect<void>;
  }
>()("t3/project/ProjectRepositoryIdentityStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get: ProjectRepositoryIdentityStore["Service"]["get"] = (workspaceRoot) =>
    // A row resolved for another root (the project moved) never applies.
    sql<{ readonly repositoryIdentityJson: string }>`
      SELECT identity.repository_identity_json AS "repositoryIdentityJson"
      FROM fork_project_repository_identity AS identity
      JOIN projection_projects AS project
        ON project.project_id = identity.project_id
        AND project.workspace_root = identity.workspace_root
      WHERE project.workspace_root = ${workspaceRoot}
        AND project.deleted_at IS NULL
      LIMIT 1
    `.pipe(
      Effect.map(([row]) =>
        row === undefined
          ? null
          : Option.getOrNull(decodeRepositoryIdentityJson(row.repositoryIdentityJson)),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to read stored project repository identity", {
          workspaceRoot,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );

  const record: ProjectRepositoryIdentityStore["Service"]["record"] = (workspaceRoot, identity) => {
    const repositoryIdentityJson = JSON.stringify(identity);
    // One statement maps the root to its active project, so a resolution that
    // finishes after the project moved or was deleted writes nothing.
    return sql`
      INSERT INTO fork_project_repository_identity (
        project_id,
        workspace_root,
        repository_identity_json
      )
      SELECT project_id, workspace_root, ${repositoryIdentityJson}
      FROM projection_projects
      WHERE workspace_root = ${workspaceRoot}
        AND deleted_at IS NULL
      ON CONFLICT (project_id) DO UPDATE SET
        workspace_root = excluded.workspace_root,
        repository_identity_json = excluded.repository_identity_json
      WHERE fork_project_repository_identity.workspace_root IS NOT excluded.workspace_root
        OR fork_project_repository_identity.repository_identity_json
          IS NOT excluded.repository_identity_json
    `.pipe(
      Effect.asVoid,
      Effect.catch((cause) =>
        Effect.logWarning("Failed to store project repository identity", {
          workspaceRoot,
          cause,
        }),
      ),
    );
  };

  return ProjectRepositoryIdentityStore.of({ get, record });
});

export const layer = Layer.effect(ProjectRepositoryIdentityStore, make);
