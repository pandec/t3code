import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Provider threads whose native session must resume or fail: no fresh-session
// fallback (see sessionImport/StrictResume.ts).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE fork_strict_resume_provider_threads (
      provider_thread_id TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
