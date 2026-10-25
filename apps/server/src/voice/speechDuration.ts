import type { SpeechAudioMimeType } from "@t3tools/contracts";

import { readMp3FrameHeader, stripLeadingId3v2Tag } from "./speechChunks.ts";
import { readWavPcm } from "./wavAudio.ts";

/**
 * Bit rate assumed when the first MP3 frame cannot be read. ElevenLabs is
 * asked for `mp3_44100_128` outright, so this only matters for a stream
 * that does not start with a frame header.
 */
const MP3_FALLBACK_BIT_RATE = 128_000;

/**
 * Playable length from the bytes, so clients show it before the audio loads. WAV
 * is exact; MP3 assumes constant bit rate from the first frame, as the join
 * helper does. The player corrects the clock once the file loads.
 */
export function estimateSpeechDurationMs(bytes: Uint8Array, mimeType: SpeechAudioMimeType): number {
  if (mimeType === "audio/wav") {
    const wav = readWavPcm(bytes);
    if (wav === null) return 0;
    const bytesPerSecond =
      (wav.format.sampleRate * wav.format.channels * wav.format.bitsPerSample) / 8;
    return bytesPerSecond > 0 ? Math.round((wav.pcm.byteLength * 1000) / bytesPerSecond) : 0;
  }
  const audio = stripLeadingId3v2Tag(bytes);
  const bitRate = readMp3FrameHeader(audio)?.bitRate ?? MP3_FALLBACK_BIT_RATE;
  return Math.round((audio.byteLength * 8 * 1000) / bitRate);
}
