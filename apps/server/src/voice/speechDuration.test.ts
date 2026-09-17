import { describe, expect, it } from "vite-plus/test";

import { estimateSpeechDurationMs } from "./speechDuration.ts";
import { wrapPcmAsWav } from "./wavAudio.ts";

describe("estimateSpeechDurationMs", () => {
  it("reads a WAV's length from its header and format", () => {
    // Two seconds of 24 kHz 16-bit mono: 96,000 bytes of PCM.
    const mono24k = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 };
    expect(
      estimateSpeechDurationMs(wrapPcmAsWav(new Uint8Array(96_000), mono24k), "audio/wav"),
    ).toBe(2000);
    // Stereo at the same rate holds half as much time in the same bytes.
    expect(
      estimateSpeechDurationMs(
        wrapPcmAsWav(new Uint8Array(96_000), { ...mono24k, channels: 2 }),
        "audio/wav",
      ),
    ).toBe(1000);
    expect(estimateSpeechDurationMs(Uint8Array.from([0xff, 0xfb]), "audio/wav")).toBe(0);
  });

  it("estimates an MP3 from the constant 128 kbps rate", () => {
    // 16,000 bytes at 128 kbps is exactly one second.
    expect(estimateSpeechDurationMs(new Uint8Array(16_000), "audio/mpeg")).toBe(1000);
    expect(estimateSpeechDurationMs(new Uint8Array(0), "audio/mpeg")).toBe(0);
  });
});
