import { describe, expect, it } from "vite-plus/test";

import { estimateSpeechDurationMs } from "./speechDuration.ts";
import { wrapPcmAsWav } from "./wavAudio.ts";

describe("estimateSpeechDurationMs", () => {
  it("uses the MP3 frame bitrate and excludes leading metadata", () => {
    const mpeg1 = new Uint8Array(16_000);
    mpeg1.set([0xff, 0xfb, 0x90, 0xc0]); // MPEG1, 128 kbps.
    expect(estimateSpeechDurationMs(mpeg1, "audio/mpeg")).toBe(1000);

    const mpeg2 = new Uint8Array(16_000);
    mpeg2.set([0xff, 0xf3, 0x84, 0xc0]); // MPEG2, 64 kbps.
    expect(estimateSpeechDurationMs(mpeg2, "audio/mpeg")).toBe(2000);
    mpeg2[1] = 0xe3; // MPEG2.5 uses the same bitrate table.
    expect(estimateSpeechDurationMs(mpeg2, "audio/mpeg")).toBe(2000);

    const tagged = new Uint8Array(10 + 16_000 + mpeg1.byteLength);
    tagged.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 125, 0]);
    tagged.set(mpeg1, 10 + 16_000);
    expect(estimateSpeechDurationMs(tagged, "audio/mpeg")).toBe(1000);
  });

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

  it("falls back to 128 kbps for an unrecognized MP3 header", () => {
    // 16,000 bytes at 128 kbps is exactly one second.
    expect(estimateSpeechDurationMs(new Uint8Array(16_000), "audio/mpeg")).toBe(1000);
    expect(estimateSpeechDurationMs(new Uint8Array(0), "audio/mpeg")).toBe(0);
  });
});
