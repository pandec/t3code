import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A hidden note bound to a worktree is delivered only to a turn running there
// (see orchestration-v2/ThreadHiddenNotes.ts); null delivers anywhere.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fork_thread_hidden_notes ADD COLUMN worktree_path TEXT`;
});
