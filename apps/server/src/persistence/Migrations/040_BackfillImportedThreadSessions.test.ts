import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../Layers/OrchestrationEventStore.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";

const layer = it.layer(
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-migration-040-import-session-test-",
      }),
    ),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("040_BackfillImportedThreadSessions", (it) => {
  it.effect("restores only historical imports with a matching resumable binding", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
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
            '2026-07-23T00:00:00.000Z', '2026-07-23T00:02:00.000Z'
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
          ),
          (
            'running-import', 'project', 'Running import',
            '{"instanceId":"claude-work","model":"claude-opus-4-8"}',
            'full-access', 'default',
            '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
          ),
          (
            'non-resumable-import', 'project', 'Non-resumable import',
            '{"instanceId":"claude-work","model":"claude-opus-4-8"}',
            'full-access', 'default',
            '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
          ),
          (
            'mismatched-cursor', 'project', 'Mismatched cursor',
            '{"instanceId":"claude-work","model":"claude-opus-4-8"}',
            'full-access', 'default',
            '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
          ),
          (
            'mismatched-instance', 'project', 'Mismatched instance',
            '{"instanceId":"claude-other","model":"claude-opus-4-8"}',
            'full-access', 'default',
            '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
          ),
          (
            'canonical-import', 'project', 'Canonical import',
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
          ),
          (
            'running-import', 'claudeAgent', 'claude-work', 'claudeAgent',
            'full-access', 'running', '2026-07-23T00:01:00.000Z',
            '{"resume":"running-session"}'
          ),
          (
            'non-resumable-import', 'claudeAgent', 'claude-work', 'claudeAgent',
            'full-access', 'stopped', '2026-07-23T00:01:00.000Z',
            NULL
          ),
          (
            'mismatched-cursor', 'claudeAgent', 'claude-work', 'claudeAgent',
            'full-access', 'stopped', '2026-07-23T00:01:00.000Z',
            '{"resume":"different-session"}'
          ),
          (
            'mismatched-instance', 'claudeAgent', 'claude-work', 'claudeAgent',
            'full-access', 'stopped', '2026-07-23T00:01:00.000Z',
            '{"resume":"mismatched-instance-session"}'
          ),
          (
            'canonical-import', 'claudeAgent', 'claude-work', 'claudeAgent',
            'full-access', 'stopped', '2026-07-23T00:01:00.000Z',
            '{"resume":"canonical-session"}'
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
          ),
          (
            'running-history', 'thread', 'running-import', 1,
            'thread.history-imported', '2026-07-23T00:00:00.000Z', 'client',
            '{"threadId":"running-import","source":{"provider":"claudeAgent","nativeSessionId":"running-session","nativeCwd":"/workspace/root"},"messages":[],"createdAt":"2026-07-23T00:00:00.000Z"}',
            '{}'
          ),
          (
            'non-resumable-history', 'thread', 'non-resumable-import', 1,
            'thread.history-imported', '2026-07-23T00:00:00.000Z', 'client',
            '{"threadId":"non-resumable-import","source":{"provider":"claudeAgent","nativeSessionId":"non-resumable-session","nativeCwd":"/workspace/root"},"messages":[],"createdAt":"2026-07-23T00:00:00.000Z"}',
            '{}'
          ),
          (
            'mismatched-cursor-history', 'thread', 'mismatched-cursor', 1,
            'thread.history-imported', '2026-07-23T00:00:00.000Z', 'client',
            '{"threadId":"mismatched-cursor","source":{"provider":"claudeAgent","nativeSessionId":"mismatched-cursor-session","nativeCwd":"/workspace/root"},"messages":[],"createdAt":"2026-07-23T00:00:00.000Z"}',
            '{}'
          ),
          (
            'mismatched-instance-history', 'thread', 'mismatched-instance', 1,
            'thread.history-imported', '2026-07-23T00:00:00.000Z', 'client',
            '{"threadId":"mismatched-instance","source":{"provider":"claudeAgent","nativeSessionId":"mismatched-instance-session","nativeCwd":"/workspace/root"},"messages":[],"createdAt":"2026-07-23T00:00:00.000Z"}',
            '{}'
          ),
          (
            'canonical-history', 'thread', 'canonical-import', 1,
            'thread.history-imported', '2026-07-23T00:00:00.000Z', 'client',
            '{"threadId":"canonical-import","source":{"provider":"claudeAgent","nativeSessionId":"canonical-session","nativeCwd":"/workspace/root"},"messages":[],"createdAt":"2026-07-23T00:00:00.000Z"}',
            '{}'
          ),
          (
            'canonical-session-set', 'thread', 'canonical-import', 2,
            'thread.session-set', '2026-07-23T00:01:00.000Z', 'client',
            '{"threadId":"canonical-import","session":{"threadId":"canonical-import","status":"stopped","providerName":"claudeAgent","providerInstanceId":"claude-work","runtimeMode":"full-access","activeTurnId":null,"lastError":null,"updatedAt":"2026-07-23T00:01:00.000Z"}}',
            '{}'
          )
      `;

      const [preMigrationJournal] = yield* sql<{ readonly sequence: number }>`
        SELECT MAX(sequence) AS sequence
        FROM orchestration_events
      `;
      yield* sql`
        INSERT INTO projection_state (
          projector, last_applied_sequence, updated_at
        ) VALUES (
          ${ORCHESTRATION_PROJECTOR_NAMES.threadSessions},
          ${preMigrationJournal?.sequence ?? 0},
          '2026-07-23T00:01:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* projectionPipeline.bootstrap;

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

      const migrationEvents = yield* sql<{
        readonly eventType: string;
        readonly actorKind: string;
        readonly occurredAt: string;
        readonly sequence: number;
        readonly sessionUpdatedAt: string;
        readonly streamVersion: number;
      }>`
        SELECT
          event_type AS "eventType",
          actor_kind AS "actorKind",
          occurred_at AS "occurredAt",
          sequence,
          json_extract(payload_json, '$.session.updatedAt') AS "sessionUpdatedAt",
          stream_version AS "streamVersion"
        FROM orchestration_events
        WHERE event_id = 'migration-040-import-session:eligible-import'
      `;
      assert.deepStrictEqual(migrationEvents, [
        {
          eventType: "thread.session-set",
          actorKind: "server",
          occurredAt: "2026-07-23T00:02:00.000Z",
          sequence: (preMigrationJournal?.sequence ?? 0) + 1,
          sessionUpdatedAt: "2026-07-23T00:01:00.000Z",
          streamVersion: 2,
        },
      ]);

      assert.deepStrictEqual(
        yield* sql`
          SELECT event_id AS "eventId"
          FROM orchestration_events
          WHERE event_id LIKE 'migration-040-import-session:%'
          ORDER BY event_id
        `,
        [{ eventId: "migration-040-import-session:eligible-import" }],
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT last_applied_sequence AS "lastAppliedSequence"
          FROM projection_state
          WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}
        `,
        [{ lastAppliedSequence: (preMigrationJournal?.sequence ?? 0) + 1 }],
      );

      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`
        UPDATE projection_state
        SET last_applied_sequence = 0
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}
      `;
      yield* projectionPipeline.bootstrap;
      assert.deepStrictEqual(
        yield* sql`
        SELECT thread_id AS "threadId", status
        FROM projection_thread_sessions
        ORDER BY thread_id
      `,
        [
          { threadId: "canonical-import", status: "stopped" },
          { threadId: "eligible-import", status: "stopped" },
        ],
      );
    }),
  );
});
