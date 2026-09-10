import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// The fork's "Move to top" ordering used to persist a thread.moved-to-top
// event. Upstream's activeOrderKey replaced it and the event type left the
// contracts, so any rows recorded before the switch make event decoding
// fail and the backend crash on startup. The payload only carried the
// moved-at stamp, which nothing reads any more, so dropping the rows is
// safe: stream versions are derived from the current maximum per stream, so
// the gaps they leave behind are harmless.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM orchestration_events WHERE event_type = 'thread.moved-to-top'`;
});
