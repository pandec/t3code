import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "068_ProjectionMessageSpeechDuration",
  (it) => {
    it.effect("adds duration_ms and backfills the rows whose format is known", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 67 });

        const insert = (
          messageId: string,
          mimeType: string,
          sizeBytes: number,
          model = "model",
        ) => sql`
        INSERT INTO projection_message_speech (
          message_id, thread_id, speech_id, transcript, mime_type, size_bytes,
          source_text_hash, script_recipe_hash, voice_id, tts_model, created_at
        ) VALUES (
          ${messageId}, 'thread-1', ${`speech-${messageId}`}, 'Transcript.', ${mimeType},
          ${sizeBytes}, 'hash', 'recipe', 'voice', ${model}, '2026-09-17T00:00:00.000Z'
        )
      `;
        // Gemini's PCM format is documented; any other WAV producer is not.
        yield* insert("wav", "audio/wav", 44 + 96_000);
        yield* insert(
          "wav-gemini",
          "audio/wav",
          44 + 96_000,
          "openrouter:google/gemini-3.1-flash-tts-preview",
        );
        yield* insert("mp3", "audio/mpeg", 16_000);
        yield* insert("elevenlabs", "audio/mpeg", 16_000, "elevenlabs:eleven_flash_v2_5");
        yield* insert("openrouter", "audio/mpeg", 16_000, "openrouter:openai/tts-1");
        yield* insert("wav-empty", "audio/wav", 44);
        yield* insert("other", "audio/ogg", 5000);

        yield* runMigrations({ toMigrationInclusive: 68 });

        const rows = yield* sql<{ readonly messageId: string; readonly durationMs: number | null }>`
        SELECT message_id AS "messageId", duration_ms AS "durationMs"
        FROM projection_message_speech
        ORDER BY message_id
      `;
        assert.deepEqual(rows, [
          { messageId: "elevenlabs", durationMs: 1000 },
          { messageId: "mp3", durationMs: 1000 },
          { messageId: "openrouter", durationMs: null },
          { messageId: "other", durationMs: null },
          { messageId: "wav", durationMs: null },
          { messageId: "wav-empty", durationMs: null },
          { messageId: "wav-gemini", durationMs: 2000 },
        ]);
        assert.deepEqual(
          migrationManifest.find(([id]) => id === 68),
          [68, "ProjectionMessageSpeechDuration"],
        );
      }),
    );
  },
);
