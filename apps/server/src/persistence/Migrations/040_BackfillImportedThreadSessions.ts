import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Imports created before migration 040 persisted a provider binding and
 * history, but no session event. Append the missing canonical event only when
 * the import and resumable stopped binding agree, leaving binding-only orphans
 * untouched and keeping projection rebuilds deterministic.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT OR IGNORE INTO orchestration_events (
      event_id,
      aggregate_kind,
      stream_id,
      stream_version,
      event_type,
      occurred_at,
      command_id,
      causation_event_id,
      correlation_id,
      actor_kind,
      payload_json,
      metadata_json
    )
    SELECT
      'migration-040-import-session:' || threads.thread_id,
      'thread',
      threads.thread_id,
      (
        SELECT COALESCE(MAX(existing.stream_version), -1) + 1
        FROM orchestration_events AS existing
        WHERE existing.aggregate_kind = 'thread'
          AND existing.stream_id = threads.thread_id
      ),
      'thread.session-set',
      runtime.last_seen_at,
      NULL,
      NULL,
      NULL,
      'server',
      json_object(
        'threadId', threads.thread_id,
        'session', json_object(
          'threadId', threads.thread_id,
          'status', 'stopped',
          'providerName', runtime.provider_name,
          'providerInstanceId', COALESCE(
            runtime.provider_instance_id,
            json_extract(threads.model_selection_json, '$.instanceId')
          ),
          'runtimeMode', runtime.runtime_mode,
          'activeTurnId', NULL,
          'lastError', NULL,
          'updatedAt', runtime.last_seen_at
        )
      ),
      json_object('migration', 40)
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
