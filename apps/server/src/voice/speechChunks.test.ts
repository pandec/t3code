import { describe, expect, it } from "vite-plus/test";

import {
  appendSpeechAudio,
  splitSpeechText,
  stripLeadingId3v2Tag,
  stripLeadingXingFrame,
} from "./speechChunks.ts";
import { wrapPcmAsWav } from "./wavAudio.ts";

const id3Tag = (bodyLength: number, options?: { footer?: boolean }): Uint8Array => {
  const footer = options?.footer === true;
  const tag = new Uint8Array(10 + bodyLength + (footer ? 10 : 0));
  tag.set([0x49, 0x44, 0x33, 0x04, 0x00, footer ? 0x10 : 0x00]);
  tag[6] = (bodyLength >> 21) & 0x7f;
  tag[7] = (bodyLength >> 14) & 0x7f;
  tag[8] = (bodyLength >> 7) & 0x7f;
  tag[9] = bodyLength & 0x7f;
  tag.fill(0xaa, 10, 10 + bodyLength);
  return tag;
};

// A 417-byte MPEG1 layer III frame (128kbps, 44.1kHz, mono), the shape every
// ElevenLabs segment starts with. The fourcc lands at offset 21.
const headerFrame = (fourcc: string): Uint8Array => {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0xc0]);
  frame.set(
    [...fourcc].map((char) => char.charCodeAt(0)),
    21,
  );
  return frame;
};

// A 192-byte MPEG2 layer III frame (64kbps, 24kHz, mono). OpenRouter
// providers commonly return this lower sample-rate shape.
const mpeg2HeaderFrame = (fourcc: string): Uint8Array => {
  const frame = new Uint8Array(192);
  frame.set([0xff, 0xf3, 0x84, 0xc0]);
  frame.set(
    [...fourcc].map((char) => char.charCodeAt(0)),
    13,
  );
  return frame;
};

const frames = (...bytes: number[]) => Uint8Array.from(bytes);

const concat = (...parts: Uint8Array[]) => {
  const merged = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
};

const sentence = (index: number, length: number) =>
  `Sentence ${index} ${"x".repeat(Math.max(0, length - 12 - String(index).length))}.`;

describe("splitSpeechText", () => {
  it("keeps a short script whole and drops an empty one", () => {
    expect(splitSpeechText("  Hello there.  ", 100)).toEqual(["Hello there."]);
    expect(splitSpeechText("   ", 100)).toEqual([]);
  });

  it("packs whole paragraphs up to the limit and cuts between them", () => {
    const paragraphs = [sentence(1, 300), sentence(2, 300), sentence(3, 300), sentence(4, 300)];
    const chunks = splitSpeechText(paragraphs.join("\n\n"), 650);
    expect(chunks).toEqual([
      `${paragraphs[0]}\n\n${paragraphs[1]}`,
      `${paragraphs[2]}\n\n${paragraphs[3]}`,
    ]);
    expect(chunks.join("\n\n")).toBe(paragraphs.join("\n\n"));
  });

  it("falls back to sentence boundaries inside an oversized paragraph", () => {
    const sentences = [sentence(1, 250), sentence(2, 250), sentence(3, 250)];
    const chunks = splitSpeechText(sentences.join(" "), 520);
    expect(chunks).toEqual([`${sentences[0]} ${sentences[1]}`, sentences[2]]);
  });

  it("never cuts a sentence, even one longer than the limit", () => {
    const long = sentence(1, 900);
    expect(splitSpeechText(`${long}\n\n${sentence(2, 100)}`, 400)).toEqual([
      long,
      sentence(2, 100),
    ]);
  });

  it("does not treat a decimal point or a short abbreviation as a boundary", () => {
    const first = `The run covers roughly 1.5k users, e.g. the ones without a new password ${"y".repeat(220)}.`;
    const second = sentence(2, 250);
    expect(splitSpeechText(`${first} ${second}`, 300)).toEqual([first, second]);
  });
});

describe("stripLeadingId3v2Tag", () => {
  it("strips a leading tag, honoring the syncsafe size and the footer flag", () => {
    const audio = frames(0xff, 0xfb, 0x90, 0x64);

    expect(stripLeadingId3v2Tag(concat(id3Tag(20), audio))).toEqual(audio);
    expect(stripLeadingId3v2Tag(concat(id3Tag(20, { footer: true }), audio))).toEqual(audio);
    // 300 spans two syncsafe bytes: [.., 0x02, 0x2c].
    expect(stripLeadingId3v2Tag(concat(id3Tag(300), audio))).toEqual(audio);
  });

  it("returns untagged or degenerate input unchanged", () => {
    const audio = frames(0xff, 0xfb, 0x90, 0x64);
    expect(stripLeadingId3v2Tag(audio)).toBe(audio);

    const short = frames(0x49, 0x44, 0x33);
    expect(stripLeadingId3v2Tag(short)).toBe(short);

    // A tag that claims to cover the whole buffer leaves nothing to play.
    const tagOnly = id3Tag(20);
    expect(stripLeadingId3v2Tag(tagOnly)).toBe(tagOnly);
  });
});

describe("stripLeadingXingFrame", () => {
  it("drops a leading Xing or Info header frame", () => {
    const audio = frames(0xff, 0xfb, 0x90, 0x64, 0x01, 0x02);
    expect(stripLeadingXingFrame(concat(headerFrame("Info"), audio))).toEqual(audio);
    expect(stripLeadingXingFrame(concat(headerFrame("Xing"), audio))).toEqual(audio);
    expect(stripLeadingXingFrame(concat(mpeg2HeaderFrame("Info"), audio))).toEqual(audio);
  });

  it("leaves plain audio frames and non-frame data unchanged", () => {
    const audioFrame = concat(frames(0xff, 0xfb, 0x90, 0xc0), new Uint8Array(413));
    expect(stripLeadingXingFrame(audioFrame)).toBe(audioFrame);

    const notAFrame = frames(0x01, 0x02, 0x03, 0x04);
    expect(stripLeadingXingFrame(notAFrame)).toBe(notAFrame);

    // A header frame longer than the buffer cannot be stripped.
    const truncated = headerFrame("Info").subarray(0, 100);
    expect(stripLeadingXingFrame(truncated)).toBe(truncated);
  });
});

describe("appendSpeechAudio", () => {
  it("joins bare frame streams, dropping each segment's tag and header frame", () => {
    const first = concat(id3Tag(20), headerFrame("Info"), frames(0x01, 0x02));
    const second = concat(id3Tag(30), headerFrame("Info"), frames(0x03, 0x04));

    const merged = appendSpeechAudio(first, second, "audio/mpeg");
    expect(merged).toEqual(frames(0x01, 0x02, 0x03, 0x04));

    const mpeg2Merged = appendSpeechAudio(
      concat(mpeg2HeaderFrame("Info"), frames(0x05, 0x06)),
      concat(mpeg2HeaderFrame("Info"), frames(0x07, 0x08)),
      "audio/mpeg",
    );
    expect(mpeg2Merged).toEqual(frames(0x05, 0x06, 0x07, 0x08));
    // Re-appending to an already merged stream is stable.
    expect(appendSpeechAudio(merged!, second, "audio/mpeg")).toEqual(
      frames(0x01, 0x02, 0x03, 0x04, 0x03, 0x04),
    );
  });

  it("joins WAV recordings under one header and refuses mismatched formats", () => {
    const mono24k = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 };
    const first = wrapPcmAsWav(frames(0x01, 0x02), mono24k);
    const second = wrapPcmAsWav(frames(0x03, 0x04), mono24k);
    expect(appendSpeechAudio(first, second, "audio/wav")).toEqual(
      wrapPcmAsWav(frames(0x01, 0x02, 0x03, 0x04), mono24k),
    );
    expect(
      appendSpeechAudio(
        first,
        wrapPcmAsWav(frames(0x03, 0x04), { ...mono24k, channels: 2 }),
        "audio/wav",
      ),
    ).toBeNull();
    // A bare MP3 stream on the WAV path is not spliced in as noise.
    expect(appendSpeechAudio(first, frames(0xff, 0xfb), "audio/wav")).toBeNull();
  });
});
