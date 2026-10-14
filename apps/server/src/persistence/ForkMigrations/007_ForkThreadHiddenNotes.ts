import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Hidden notes the next provider turn of a thread carries once (see
// orchestration-v2/ThreadHiddenNotes.ts). One note per (thread, kind): a newer
// note of the same kind replaces the pending one.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE fork_thread_hidden_notes (
      note_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (thread_id, kind)
    )
  `;
});
