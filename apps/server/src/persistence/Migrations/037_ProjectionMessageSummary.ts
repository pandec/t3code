import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_message_summary (
      message_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_text_hash TEXT NOT NULL,
      recipe_hash TEXT NOT NULL,
      model_selection_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX projection_message_summary_thread_id_idx
    ON projection_message_summary (thread_id)
  `;
});
