import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN generation_model_selection_json TEXT
  `;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN generation_cwd TEXT
  `;

  yield* sql`
    UPDATE projection_thread_messages AS messages
    SET
      generation_model_selection_json = (
        SELECT threads.model_selection_json
        FROM projection_threads AS threads
        WHERE threads.thread_id = messages.thread_id
      ),
      generation_cwd = (
        SELECT COALESCE(threads.worktree_path, projects.workspace_root)
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = messages.thread_id
      )
    WHERE messages.role = 'assistant'
  `;
});
