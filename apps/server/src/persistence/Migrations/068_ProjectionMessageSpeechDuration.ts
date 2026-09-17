import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Recordings carry their playable length so clients can show it before the
 * audio loads. Existing rows are backfilled from their byte size: WAV rows
 * are all Gemini's 24 kHz 16-bit mono PCM under a 44-byte header, and MP3
 * rows are all 128 kbps CBR, the only formats this server has ever stored.
 * Anything else stays null and shows as unknown until regenerated.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_message_speech
    ADD COLUMN duration_ms INTEGER
  `;

  yield* sql`
    UPDATE projection_message_speech
    SET duration_ms = CAST(ROUND((size_bytes - 44) * 1000.0 / 48000) AS INTEGER)
    WHERE mime_type = 'audio/wav' AND size_bytes > 44
  `;

  yield* sql`
    UPDATE projection_message_speech
    SET duration_ms = CAST(ROUND(size_bytes * 8 * 1000.0 / 128000) AS INTEGER)
    WHERE mime_type = 'audio/mpeg'
  `;
});
