import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_ProjectionMessageSpeechRequest", (it) => {
  it.effect("adds nullable message speech request columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* runMigrations({ toMigrationInclusive: 53 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      assert.deepStrictEqual(
        columns
          .filter((column) =>
            ["speech_request_id", "speech_request_started_at"].includes(column.name),
          )
          .map((column) => ({ name: column.name, notnull: column.notnull })),
        [
          { name: "speech_request_id", notnull: 0 },
          { name: "speech_request_started_at", notnull: 0 },
        ],
      );
    }),
  );
});
