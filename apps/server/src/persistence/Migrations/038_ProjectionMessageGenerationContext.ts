import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN generation_model_selection_json TEXT
  `;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN generation_cwd TEXT
  `;

  // Pre-feature messages do not carry authoritative generation provenance.
  // Leave them null so runtime fallback remains explicit instead of persisting
  // the thread's mutable current model and directory as historical fact.
});
