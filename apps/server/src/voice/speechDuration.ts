import type { SpeechAudioMimeType } from "@t3tools/contracts";

import { readWavPcm } from "./wavAudio.ts";

/**
 * Bit rate of every MP3 this server stores. ElevenLabs is asked for
 * `mp3_44100_128` outright, and OpenRouter's MP3 models are assumed to match
 * (see the join helper in speechChunks). A wrong assumption here only mis-
 * states the length shown before first play; the player corrects itself
 * from the loaded file.
 */
const MP3_BIT_RATE = 128_000;

/**
 * Playable length of a stored recording, derived from its bytes so clients
 * can show the total before the audio loads. WAV is exact from the header.
 * MP3 is the CBR estimate; a leading ID3 tag or Xing frame adds a few
 * milliseconds of error, well under what the clock displays.
 */
export function estimateSpeechDurationMs(bytes: Uint8Array, mimeType: SpeechAudioMimeType): number {
  if (mimeType === "audio/wav") {
    const wav = readWavPcm(bytes);
    if (wav === null) return 0;
    const bytesPerSecond =
      (wav.format.sampleRate * wav.format.channels * wav.format.bitsPerSample) / 8;
    return bytesPerSecond > 0 ? Math.round((wav.pcm.byteLength * 1000) / bytesPerSecond) : 0;
  }
  return Math.round((bytes.byteLength * 8 * 1000) / MP3_BIT_RATE);
}
