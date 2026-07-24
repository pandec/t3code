import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_BackfillImportedThreadSessions", (it) => {
  it.effect("restores only historical imports with a matching resumable binding", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 39 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project', 'Project', '/workspace/root', '[]',
          '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES
          (
            'eligible-import', 'project', 'Eligible import',
            '{"instanceId":"claude-work","model":"claude-opus-4-8"}',
            'full-access', 'default',
            '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
          ),
          (
            'missing-binding', 'project', 'Missing binding',
            '{"instanceId":"claude-work","model":"claude-opus-4-8"}',
            'full-access', 'default',
            '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
          ),
          (
            'ordinary-thread', 'project', 'Ordinary thread',
            '{"instanceId":"claude-work","model":"claude-opus-4-8"}',
            'full-access', 'default',
            '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
          )
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key,
          runtime_mode, status, last_seen_at, resume_cursor_json
        ) VALUES
          (
            'eligible-import', 'claudeAgent', 'claude-work', 'claudeAgent',
            'full-access', 'stopped', '2026-07-23T00:01:00.000Z',
            '{"resume":"native-session"}'
          ),
          (
            'ordinary-thread', 'claudeAgent', 'claude-work', 'claudeAgent',
            'full-access', 'stopped', '2026-07-23T00:01:00.000Z',
            '{"resume":"ordinary-session"}'
          )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES
          (
            'eligible-history', 'thread', 'eligible-import', 1,
            'thread.history-imported', '2026-07-23T00:00:00.000Z', 'client',
            '{"threadId":"eligible-import","source":{"provider":"claudeAgent","nativeSessionId":"native-session","nativeCwd":"/workspace/root"},"messages":[],"createdAt":"2026-07-23T00:00:00.000Z"}',
            '{}'
          ),
          (
            'missing-binding-history', 'thread', 'missing-binding', 1,
            'thread.history-imported', '2026-07-23T00:00:00.000Z', 'client',
            '{"threadId":"missing-binding","source":{"provider":"claudeAgent","nativeSessionId":"missing-session","nativeCwd":"/workspace/root"},"messages":[],"createdAt":"2026-07-23T00:00:00.000Z"}',
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 40 });

      const sessions = yield* sql<{
        readonly threadId: string;
        readonly status: string;
        readonly providerName: string | null;
        readonly providerInstanceId: string | null;
        readonly runtimeMode: string;
      }>`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode"
        FROM projection_thread_sessions
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(sessions, [
        {
          threadId: "eligible-import",
          status: "stopped",
          providerName: "claudeAgent",
          providerInstanceId: "claude-work",
          runtimeMode: "full-access",
        },
      ]);
    }),
  );
});
