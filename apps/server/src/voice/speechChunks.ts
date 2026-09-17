import type { SpeechAudioMimeType } from "@t3tools/contracts";

import { appendWavAudio } from "./wavAudio.ts";

/**
 * Longest piece one OpenRouter request carries when a script is split for
 * parallel synthesis. Gemini TTS generates at roughly two to three times
 * real time, so a 3,000-character script takes one to two minutes as a
 * single request; five pieces of this size finished in under 30 seconds
 * side by side. A floor keeps pieces long enough that each keeps its own
 * prosody context.
 */
export const SPEECH_CHUNK_MAX_CHARS = 800;
const SPEECH_CHUNK_MIN_CHARS = 200;

/**
 * Splits a script at paragraph boundaries, then sentence boundaries,
 * targeting `maxChars` per piece. A cut mid-sentence gives the model no context
 * for pace or tone and is audible in the result; a cut between paragraphs
 * is where a reader would pause anyway. A single sentence longer than
 * `maxChars` stays whole rather than being sliced by character count.
 */
export function splitSpeechText(text: string, maxChars = SPEECH_CHUNK_MAX_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed.length > 0 ? [trimmed] : [];
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = "";
  };
  for (const paragraph of trimmed.split(/\n\s*\n/)) {
    const unit = paragraph.trim();
    if (unit.length === 0) continue;
    if (unit.length > maxChars) {
      // Too long for one piece even alone: fall through to sentences.
      for (const sentence of splitSentences(unit)) {
        appendUnit(sentence, " ");
      }
      continue;
    }
    appendUnit(unit, "\n\n");
  }
  flush();
  return chunks;

  function appendUnit(unit: string, separator: string) {
    if (current.length === 0) {
      current = unit;
    } else if (current.length + separator.length + unit.length <= maxChars) {
      current = `${current}${separator}${unit}`;
    } else {
      flush();
      current = unit;
    }
  }
}

/**
 * Sentence boundaries are a terminator followed by whitespace. Numbers and
 * abbreviations ("1.5k users", "e.g. this") are the false positives that
 * matter; the whitespace requirement handles the first and a minimum piece
 * length keeps the second from producing a fragment.
 */
function splitSentences(paragraph: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  const pattern = /[.!?]["')\]]*\s+/g;
  for (const match of paragraph.matchAll(pattern)) {
    const end = match.index + match[0].length;
    if (end - start < SPEECH_CHUNK_MIN_CHARS) continue;
    pieces.push(paragraph.slice(start, end).trim());
    start = end;
  }
  const tail = paragraph.slice(start).trim();
  if (tail.length > 0) {
    // A short tail joins the previous sentence rather than standing alone.
    if (tail.length < SPEECH_CHUNK_MIN_CHARS && pieces.length > 0) {
      pieces[pieces.length - 1] = `${pieces[pieces.length - 1]} ${tail}`;
    } else {
      pieces.push(tail);
    }
  }
  return pieces;
}

/**
 * Joins two recordings from the same synthesis pipeline into one playable
 * stream. Callers check that both use the same container; a WAV pair whose
 * sample rate or channel count differs (a settings change mid-turn moved to
 * another model) returns null rather than being spliced together as noise.
 * WAV segments are re-wrapped with a header covering both PCM payloads.
 *
 * For MP3: ElevenLabs returns CBR 44.1kHz mono and OpenRouter's MP3 output is
 * assumed CBR too (not checked per model), so bare frame streams concatenate
 * cleanly. Each segment can lead with an ID3v2 tag and a Xing/Info header
 * frame that declares that segment's frame count. Both are dropped from both
 * sides (a no-op on an already merged left side): a header frame surviving
 * into the merge caps the reported duration at the first segment, and without
 * one, CBR players derive the correct duration from the file size.
 */
export function appendSpeechAudio(
  previous: Uint8Array,
  next: Uint8Array,
  mimeType: SpeechAudioMimeType,
): Uint8Array | null {
  if (mimeType === "audio/wav") {
    return appendWavAudio(previous, next);
  }
  const left = stripLeadingXingFrame(stripLeadingId3v2Tag(previous));
  const right = stripLeadingXingFrame(stripLeadingId3v2Tag(next));
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

/**
 * The fields of an MPEG Layer III frame header this module needs. Frames
 * with CRC, reserved versions, free-format or invalid bit rates, and
 * reserved sample rates come back null so callers leave the bytes alone
 * rather than guess.
 */
export interface Mp3FrameHeader {
  readonly isMpeg1: boolean;
  /** Bits per second. */
  readonly bitRate: number;
  readonly frameLength: number;
  readonly isMono: boolean;
}

export function readMp3FrameHeader(bytes: Uint8Array): Mp3FrameHeader | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) {
    return null;
  }
  const versionBits = bytes[1]! & 0x18;
  const isMpeg1 = versionBits === 0x18;
  const isMpeg2 = versionBits === 0x10;
  const isMpeg25 = versionBits === 0;
  const isLayer3 = (bytes[1]! & 0x06) === 0x02;
  const hasCrc = (bytes[1]! & 0x01) === 0;
  if ((!isMpeg1 && !isMpeg2 && !isMpeg25) || !isLayer3 || hasCrc) {
    return null;
  }
  const bitrateIndex = (bytes[2]! >> 4) & 0x0f;
  const sampleRateIndex = (bytes[2]! >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 3) {
    return null;
  }
  const bitrateTable = isMpeg1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRateTable = isMpeg1
    ? [44100, 48000, 32000]
    : isMpeg2
      ? [22050, 24000, 16000]
      : [11025, 12000, 8000];
  const bitRate = bitrateTable[bitrateIndex]! * 1000;
  const sampleRate = sampleRateTable[sampleRateIndex]!;
  const padding = (bytes[2]! >> 1) & 0x01;
  const frameLength = Math.floor(((isMpeg1 ? 144 : 72) * bitRate) / sampleRate) + padding;
  const isMono = (bytes[3]! & 0xc0) === 0xc0;
  return { isMpeg1, bitRate, frameLength, isMono };
}

/**
 * Drops a leading Xing/Info frame from MPEG Layer III audio. Other layouts
 * are left untouched rather than matched against audio bytes.
 */
export function stripLeadingXingFrame(bytes: Uint8Array): Uint8Array {
  const header = readMp3FrameHeader(bytes);
  if (header === null || header.frameLength > bytes.byteLength) {
    return bytes;
  }
  const sideInfoLength = header.isMpeg1 ? (header.isMono ? 17 : 32) : header.isMono ? 9 : 17;
  const fourccOffset = 4 + sideInfoLength;
  const fourcc = String.fromCharCode(...bytes.subarray(fourccOffset, fourccOffset + 4));
  return fourcc === "Xing" || fourcc === "Info" ? bytes.subarray(header.frameLength) : bytes;
}

export function stripLeadingId3v2Tag(bytes: Uint8Array): Uint8Array {
  if (
    bytes.byteLength < 10 ||
    bytes[0] !== 0x49 || // "I"
    bytes[1] !== 0x44 || // "D"
    bytes[2] !== 0x33 // "3"
  ) {
    return bytes;
  }
  // The tag size is a 28-bit syncsafe integer and excludes the 10-byte header
  // and the optional 10-byte footer signalled by flag bit 0x10.
  const size =
    ((bytes[6]! & 0x7f) << 21) |
    ((bytes[7]! & 0x7f) << 14) |
    ((bytes[8]! & 0x7f) << 7) |
    (bytes[9]! & 0x7f);
  const tagLength = 10 + size + ((bytes[5]! & 0x10) !== 0 ? 10 : 0);
  return tagLength >= bytes.byteLength ? bytes : bytes.subarray(tagLength);
}
