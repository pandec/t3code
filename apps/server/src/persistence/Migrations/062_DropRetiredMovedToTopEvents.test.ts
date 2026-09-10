import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("062_DropRetiredMovedToTopEvents", (it) => {
  it.effect("drops thread.moved-to-top rows and keeps every other event", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });

      const event = (eventId: string, version: number, type: string, payload: object) =>
        sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          )
          VALUES (
            ${eventId}, 'thread', 'thread-1', ${version}, ${type}, '2026-08-18T12:49:47.646Z',
            NULL, NULL, NULL, 'client', ${JSON.stringify(payload)}, '{}'
          )
        `;

      yield* event("event-created", 0, "thread.created", { threadId: "thread-1" });
      yield* event("event-moved", 1, "thread.moved-to-top", {
        threadId: "thread-1",
        movedToTopAt: "2026-08-18T12:49:47.646Z",
      });
      yield* event("event-pinned", 2, "thread.pinned", { threadId: "thread-1" });

      yield* runMigrations({ toMigrationInclusive: 62 });

      const rows = yield* sql<{ readonly event_type: string; readonly stream_version: number }>`
        SELECT event_type, stream_version FROM orchestration_events ORDER BY sequence
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.event_type, row.stream_version]),
        [
          ["thread.created", 0],
          ["thread.pinned", 2],
        ],
      );
    }),
  );
});
