import { VOICE_TRANSCRIPTION_MAX_BYTES, VoiceTranscriptionRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeVoiceDataUrl,
  ElevenLabsTranscriptionResponse,
  VoiceTranscriptionError,
} from "./VoiceTranscription.ts";

const decodeElevenLabsTranscriptionResponse = Schema.decodeUnknownSync(
  ElevenLabsTranscriptionResponse,
);
const decodeVoiceTranscriptionRequest = Schema.decodeUnknownSync(VoiceTranscriptionRequest);

describe("decodeVoiceDataUrl", () => {
  it("decodes a matching supported audio data URL", () => {
    const bytes = decodeVoiceDataUrl({
      mimeType: "audio/mp4",
      dataUrl: "data:audio/mp4;base64,aGVsbG8=",
      durationMs: 1_000,
      sizeBytes: 5,
    });

    expect(bytes).toEqual(Uint8Array.from([104, 101, 108, 108, 111]));
  });

  it("rejects MIME mismatches and declared-size mismatches", () => {
    const mimeMismatch = decodeVoiceDataUrl({
      mimeType: "audio/mp4",
      dataUrl: "data:audio/webm;base64,aGVsbG8=",
      durationMs: 1_000,
      sizeBytes: 5,
    });
    const sizeMismatch = decodeVoiceDataUrl({
      mimeType: "audio/mp4",
      dataUrl: "data:audio/mp4;base64,aGVsbG8=",
      durationMs: 1_000,
      sizeBytes: 4,
    });

    expect(mimeMismatch).toBeInstanceOf(VoiceTranscriptionError);
    expect(sizeMismatch).toBeInstanceOf(VoiceTranscriptionError);
  });

  it("rejects audio above the server byte cap", () => {
    const base64 = Buffer.alloc(VOICE_TRANSCRIPTION_MAX_BYTES + 1).toString("base64");
    const result = decodeVoiceDataUrl({
      mimeType: "audio/mp4",
      dataUrl: `data:audio/mp4;base64,${base64}`,
      durationMs: 1_000,
      sizeBytes: VOICE_TRANSCRIPTION_MAX_BYTES + 1,
    });

    expect(result).toBeInstanceOf(VoiceTranscriptionError);
  });

  it("rejects audio shorter than the provider minimum", () => {
    expect(() =>
      decodeVoiceTranscriptionRequest({
        mimeType: "audio/mp4",
        dataUrl: "data:audio/mp4;base64,aGVsbG8=",
        durationMs: 99,
        sizeBytes: 5,
      }),
    ).toThrow();
  });

  it("accepts a successful response with a null detected language", () => {
    expect(
      decodeElevenLabsTranscriptionResponse({
        text: "hello",
        language_code: null,
      }),
    ).toEqual({ text: "hello", language_code: null });
  });
});
