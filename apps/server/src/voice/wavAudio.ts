/**
 * Canonical 44-byte RIFF/WAVE container around raw PCM. OpenRouter's Gemini
 * TTS route only serves headerless 16-bit little-endian PCM, which no client
 * player accepts as-is; wrapping it here keeps the attachment a plain audio
 * file that `<audio>` and the native players decode without a codec step.
 */
export interface PcmFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
}

const WAV_HEADER_BYTES = 44;
const DEFAULT_PCM_FORMAT: PcmFormat = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 };

/**
 * Reads `rate` and `channels` from a `audio/pcm;rate=24000;channels=1`
 * content type. Missing or malformed parameters fall back to Gemini's
 * documented 24 kHz mono output; the bit depth is never advertised and is
 * always 16.
 */
export function parsePcmContentType(contentType: string | undefined): PcmFormat {
  const params = new Map<string, string>();
  for (const part of (contentType ?? "").split(";").slice(1)) {
    const [key, value] = part.split("=", 2);
    if (key && value) params.set(key.trim().toLowerCase(), value.trim());
  }
  const positiveInt = (value: string | undefined, fallback: number) => {
    const parsed = value === undefined ? Number.NaN : Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    sampleRate: positiveInt(params.get("rate"), DEFAULT_PCM_FORMAT.sampleRate),
    channels: positiveInt(params.get("channels"), DEFAULT_PCM_FORMAT.channels),
    bitsPerSample: DEFAULT_PCM_FORMAT.bitsPerSample,
  };
}

const makeWavBuffer = (pcmBytes: number, format: PcmFormat): Uint8Array => {
  const wav = new Uint8Array(WAV_HEADER_BYTES + pcmBytes);
  const view = new DataView(wav.buffer);
  const blockAlign = (format.channels * format.bitsPerSample) / 8;
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      wav[offset + index] = text.charCodeAt(index);
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, format.bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, pcmBytes, true);
  return wav;
};

/**
 * A trailing partial sample frame (a stream cut mid-sample) is dropped: it
 * would break block alignment and, being odd-sized, leave the data chunk
 * without the RIFF pad byte `readWavPcm` requires.
 */
export function wrapPcmAsWav(pcm: Uint8Array, format: PcmFormat): Uint8Array {
  const blockAlign = (format.channels * format.bitsPerSample) / 8;
  const wholeFrames = pcm.subarray(0, pcm.byteLength - (pcm.byteLength % blockAlign));
  const wav = makeWavBuffer(wholeFrames.byteLength, format);
  wav.set(wholeFrames, WAV_HEADER_BYTES);
  return wav;
}

/**
 * The PCM payload of a WAV file, or null when the bytes are not a PCM WAV
 * this module could have produced. Chunk-walks so a stray LIST chunk from
 * another writer does not break the merge.
 */
export function readWavPcm(bytes: Uint8Array): { format: PcmFormat; pcm: Uint8Array } | null {
  if (
    bytes.byteLength < WAV_HEADER_BYTES ||
    ascii(bytes, 0) !== "RIFF" ||
    ascii(bytes, 8) !== "WAVE"
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffEnd = 8 + view.getUint32(4, true);
  if (riffEnd > bytes.byteLength || riffEnd < WAV_HEADER_BYTES) return null;
  let format: PcmFormat | null = null;
  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const chunkId = ascii(bytes, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    const chunkEnd = body + chunkSize;
    if (chunkEnd + (chunkSize % 2) > riffEnd) return null;
    if (chunkId === "fmt " && chunkSize >= 16 && body + 16 <= bytes.byteLength) {
      if (view.getUint16(body, true) !== 1) return null;
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (chunkId === "data") {
      if (format === null) return null;
      return { format, pcm: bytes.subarray(body, chunkEnd) };
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  return null;
}

/**
 * Joins two WAV recordings into one. Both come from the same synthesis
 * profile, so the left format is authoritative; a right side that cannot be
 * parsed or differs in format is refused (null) rather than spliced in as
 * noise.
 */
export function appendWavAudio(previous: Uint8Array, next: Uint8Array): Uint8Array | null {
  const left = readWavPcm(previous);
  const right = readWavPcm(next);
  if (
    left === null ||
    right === null ||
    left.format.sampleRate !== right.format.sampleRate ||
    left.format.channels !== right.format.channels ||
    left.format.bitsPerSample !== right.format.bitsPerSample
  ) {
    return null;
  }
  const wav = makeWavBuffer(left.pcm.byteLength + right.pcm.byteLength, left.format);
  wav.set(left.pcm, WAV_HEADER_BYTES);
  wav.set(right.pcm, WAV_HEADER_BYTES + left.pcm.byteLength);
  return wav;
}

const ascii = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));
