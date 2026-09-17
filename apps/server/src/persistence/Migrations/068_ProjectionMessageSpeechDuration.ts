import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Recordings carry their playable length so clients can show it before the
 * audio loads. Existing rows are backfilled where the byte size determines
 * it: ElevenLabs MP3 is always 128 kbps (including rows from before model
 * ids carried a provider prefix), and Gemini TTS serves 24 kHz 16-bit mono
 * PCM under a 44-byte WAV header. Other OpenRouter models vary in bit rate
 * or sample rate and the projection holds no format data, so their length
 * stays unknown until the recording is regenerated.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_message_speech
    ADD COLUMN duration_ms INTEGER
  `;

  yield* sql`
    UPDATE projection_message_speech
    SET duration_ms = CAST(ROUND(size_bytes * 8 * 1000.0 / 128000) AS INTEGER)
    WHERE mime_type = 'audio/mpeg'
      AND (tts_model LIKE 'elevenlabs:%' OR instr(tts_model, ':') = 0)
  `;

  yield* sql`
    UPDATE projection_message_speech
    SET duration_ms = CAST(ROUND((size_bytes - 44) * 1000.0 / 48000) AS INTEGER)
    WHERE mime_type = 'audio/wav'
      AND size_bytes > 44
      AND tts_model LIKE 'openrouter:google/gemini-%'
  `;
});
