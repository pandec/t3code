import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Per-message summaries and speech scripts, keyed by v2 message id. Rows are
// caches over the message text: the source hash and recipe say what produced
// them, so a changed message or recipe regenerates instead of reusing them.
// Legacy summaries and speech start fresh (data plan), so nothing is copied.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE fork_message_summaries (
      message_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_text_hash TEXT NOT NULL,
      recipe_hash TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      model_selection_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX fork_message_summaries_thread_idx ON fork_message_summaries(thread_id)`;
  yield* sql`
    CREATE TABLE fork_message_speech_scripts (
      message_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      script TEXT NOT NULL,
      source_text_hash TEXT NOT NULL,
      script_recipe_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX fork_message_speech_scripts_thread_idx ON fork_message_speech_scripts(thread_id)
  `;
});
