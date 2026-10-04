import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Listening recordings, one per v2 message id. The audio itself is a file in
// the attachments directory named by `speech_id`. The source hash says which
// message text a listening version was made from, so a changed message hides
// and regenerates it. `origin` "agent" marks a recording the agent made itself,
// which listening never replaces. Legacy speech starts fresh (data plan).
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
