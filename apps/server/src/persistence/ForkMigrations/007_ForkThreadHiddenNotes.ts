import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One row per (thread, kind): a newer note of the same kind replaces the pending
// one. `worktree_path` binds a note to turns running there; `delivered_at` keeps
// a delivered note as a marker so a note queued once per key is never re-queued.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE fork_thread_hidden_notes (
      note_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      worktree_path TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE (thread_id, kind)
    )
  `;
});
