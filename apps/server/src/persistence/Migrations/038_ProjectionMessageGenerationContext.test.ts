import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_ProjectionMessageGenerationContext", (it) => {
  it.effect("backfills generation model and directory for existing assistant messages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project', 'Project', '/workspace/root', '[]',
          '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, worktree_path, created_at, updated_at
        ) VALUES (
          'thread', 'project', 'Thread',
          '{"instanceId":"codex","model":"gpt-5.6-sol"}',
          'full-access', 'default', '/workspace/worktree',
          '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'message', 'thread', 'assistant', 'Response', 0,
          '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 38 });

      const rows = yield* sql<{
        readonly generationModelSelectionJson: string;
        readonly generationCwd: string;
      }>`
        SELECT
          generation_model_selection_json AS generationModelSelectionJson,
          generation_cwd AS generationCwd
        FROM projection_thread_messages
        WHERE message_id = 'message'
      `;
      assert.deepStrictEqual(rows, [
        {
          generationModelSelectionJson: '{"instanceId":"codex","model":"gpt-5.6-sol"}',
          generationCwd: "/workspace/worktree",
        },
      ]);
    }),
  );
});
