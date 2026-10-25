import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One recording per v2 message id; audio lives in the attachments dir by
// `speech_id`. The source hash lets a changed message regenerate its listening
// version; `origin` "agent" recordings are never replaced.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE fork_message_speech (
      message_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      speech_id TEXT NOT NULL,
      transcript TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      duration_ms INTEGER,
      source_text_hash TEXT NOT NULL,
      script_recipe_hash TEXT,
      voice_id TEXT NOT NULL,
      tts_model TEXT NOT NULL,
      origin TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX fork_message_speech_thread_idx ON fork_message_speech(thread_id)`;
});
