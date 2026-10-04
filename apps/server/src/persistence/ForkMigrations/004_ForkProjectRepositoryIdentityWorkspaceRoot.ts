import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Scopes each stored repository identity to the workspace root it was resolved
// for, so a project moved to another folder never falls back to the old one.
// Carried legacy rows take their project's current root, which is where the
// legacy fork resolved them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fork_project_repository_identity ADD COLUMN workspace_root TEXT`;
  const projectColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_projects')
  `;
  if (projectColumns.some((column) => column.name === "workspace_root")) {
    yield* sql`
      UPDATE fork_project_repository_identity
      SET workspace_root = (
        SELECT workspace_root FROM projection_projects
        WHERE projection_projects.project_id = fork_project_repository_identity.project_id
      )
    `;
  }
});
