import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_message_speech (
      message_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      speech_id TEXT NOT NULL,
      transcript TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      source_text_hash TEXT NOT NULL,
      script_recipe_hash TEXT NOT NULL,
      voice_id TEXT NOT NULL,
      tts_model TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX projection_message_speech_thread_id_idx
    ON projection_message_speech (thread_id)
  `;
});
