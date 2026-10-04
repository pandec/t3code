import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// The continuation group each provider instance's native conversation was
// created in (NativeContinuationStore.ts). Starts empty: conversations are
// recorded the next time a provider session attaches them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE fork_native_continuation (
      provider_instance_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      native_thread_id TEXT NOT NULL,
      continuation_key TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (provider_instance_id, driver, native_thread_id)
    )
  `;
});
