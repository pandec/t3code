import { describe, expect, it } from "vite-plus/test";

import { appendWavAudio, parsePcmContentType, readWavPcm, wrapPcmAsWav } from "./wavAudio.ts";

const mono24k = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 };

describe("parsePcmContentType", () => {
  it("reads rate and channels, defaulting to Gemini's 24 kHz mono", () => {
    expect(parsePcmContentType("audio/pcm;rate=16000;channels=2")).toEqual({
      sampleRate: 16_000,
      channels: 2,
      bitsPerSample: 16,
    });
    expect(parsePcmContentType("audio/pcm; rate=44100 ; Channels=1")).toEqual({
      ...mono24k,
      sampleRate: 44_100,
    });
    expect(parsePcmContentType("audio/pcm")).toEqual(mono24k);
    expect(parsePcmContentType(undefined)).toEqual(mono24k);
    expect(parsePcmContentType("audio/pcm;rate=abc;channels=0")).toEqual(mono24k);
  });
});

describe("wrapPcmAsWav", () => {
  it("writes a canonical 44-byte header the reader round-trips", () => {
    const pcm = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const wav = wrapPcmAsWav(pcm, mono24k);
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    const view = new DataView(wav.buffer);
    expect(view.getUint32(4, true)).toBe(36 + pcm.byteLength);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(48_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    expect(readWavPcm(wav)).toEqual({ format: mono24k, pcm });
  });

  it("drops a trailing partial sample frame so the data chunk stays aligned", () => {
    const wav = wrapPcmAsWav(Uint8Array.from([1, 2, 3, 4, 5]), mono24k);
    expect(readWavPcm(wav)).toEqual({ format: mono24k, pcm: Uint8Array.from([1, 2, 3, 4]) });
    const stereo = wrapPcmAsWav(Uint8Array.from([1, 2, 3, 4, 5, 6]), { ...mono24k, channels: 2 });
    expect(readWavPcm(stereo)?.pcm).toEqual(Uint8Array.from([1, 2, 3, 4]));
  });
});

describe("readWavPcm", () => {
  it("rejects non-WAV and non-PCM input", () => {
    expect(readWavPcm(Uint8Array.from([0xff, 0xfb, 0x90, 0xc0]))).toBeNull();
    expect(readWavPcm(new Uint8Array(10))).toBeNull();
    const floatWav = wrapPcmAsWav(Uint8Array.from([1, 2]), mono24k);
    new DataView(floatWav.buffer).setUint16(20, 3, true); // IEEE float
    expect(readWavPcm(floatWav)).toBeNull();
  });

  it("refuses truncated or out-of-container chunks instead of merging partial audio", () => {
    const valid = wrapPcmAsWav(Uint8Array.from([1, 2, 3, 4]), mono24k);
    const truncated = valid.subarray(0, valid.byteLength - 2);
    expect(readWavPcm(truncated)).toBeNull();
    expect(appendWavAudio(valid, truncated)).toBeNull();
    const oversizedData = valid.slice();
    new DataView(oversizedData.buffer).setUint32(40, 100, true);
    expect(readWavPcm(oversizedData)).toBeNull();
    const shortContainer = valid.slice();
    new DataView(shortContainer.buffer).setUint32(4, 36, true);
    expect(readWavPcm(shortContainer)).toBeNull();
  });

  it("skips foreign chunks before the data chunk", () => {
    const wav = wrapPcmAsWav(Uint8Array.from([7, 8]), mono24k);
    const list = new Uint8Array(8 + 3 + 1); // odd-sized chunk plus pad byte
    list.set([0x4c, 0x49, 0x53, 0x54]); // "LIST"
    new DataView(list.buffer).setUint32(4, 3, true);
    const withList = new Uint8Array(wav.byteLength + list.byteLength);
    withList.set(wav.subarray(0, 36), 0);
    withList.set(list, 36);
    withList.set(wav.subarray(36), 36 + list.byteLength);
    new DataView(withList.buffer).setUint32(4, withList.byteLength - 8, true);
    expect(readWavPcm(withList)?.pcm).toEqual(Uint8Array.from([7, 8]));
  });
});

describe("appendWavAudio", () => {
  it("concatenates the PCM under a header that covers both", () => {
    const merged = appendWavAudio(
      wrapPcmAsWav(Uint8Array.from([1, 2]), mono24k),
      wrapPcmAsWav(Uint8Array.from([3, 4]), mono24k),
    );
    expect(merged).toEqual(wrapPcmAsWav(Uint8Array.from([1, 2, 3, 4]), mono24k));
  });

  it("refuses to splice recordings of different formats", () => {
    expect(
      appendWavAudio(
        wrapPcmAsWav(Uint8Array.from([1, 2]), mono24k),
        wrapPcmAsWav(Uint8Array.from([3, 4]), { ...mono24k, sampleRate: 16_000 }),
      ),
    ).toBeNull();
  });
});
