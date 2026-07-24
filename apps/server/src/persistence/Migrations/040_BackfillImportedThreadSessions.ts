import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Imports created before migration 040 persisted a provider binding and
 * history, but no projected session. Restore only rows whose import event and
 * resumable stopped binding agree, leaving binding-only orphans untouched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT OR IGNORE INTO projection_thread_sessions (
      thread_id,
      status,
      provider_name,
      provider_instance_id,
      runtime_mode,
      active_turn_id,
      last_error,
      updated_at
    )
    SELECT
      threads.thread_id,
      'stopped',
      runtime.provider_name,
      COALESCE(
        runtime.provider_instance_id,
        json_extract(threads.model_selection_json, '$.instanceId')
      ),
      runtime.runtime_mode,
      NULL,
      NULL,
      runtime.last_seen_at
    FROM projection_threads AS threads
    INNER JOIN provider_session_runtime AS runtime
      ON runtime.thread_id = threads.thread_id
    LEFT JOIN projection_thread_sessions AS sessions
      ON sessions.thread_id = threads.thread_id
    WHERE sessions.thread_id IS NULL
      AND threads.deleted_at IS NULL
      AND runtime.status = 'stopped'
      AND runtime.resume_cursor_json IS NOT NULL
      AND COALESCE(
        runtime.provider_instance_id,
        json_extract(threads.model_selection_json, '$.instanceId')
      ) IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS events
        WHERE events.aggregate_kind = 'thread'
          AND events.stream_id = threads.thread_id
          AND events.event_type = 'thread.history-imported'
          AND json_extract(events.payload_json, '$.source.provider') = runtime.provider_name
      )
  `;
});
