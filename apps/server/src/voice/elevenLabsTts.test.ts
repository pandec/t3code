import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect } from "vite-plus/test";

import {
  ElevenLabsTtsError,
  speechFailureReasonFor,
  synthesizeElevenLabsSpeech,
} from "./elevenLabsTts.ts";

const respondWith = (body: ConstructorParameters<typeof Response>[0], init?: ResponseInit) =>
  HttpClient.make((request) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, new Response(body, init))),
  );

const synthesize = (httpClient: HttpClient.HttpClient) =>
  synthesizeElevenLabsSpeech({
    httpClient,
    apiKey: Redacted.make("test-key"),
    voiceId: "voice-1",
    ttsModel: "eleven_multilingual_v2",
    text: "Hello there.",
  });

const failureOf = (httpClient: HttpClient.HttpClient) => synthesize(httpClient).pipe(Effect.flip);

describe("synthesizeElevenLabsSpeech", () => {
  it.effect("returns the audio bytes and the vendor's billed character count", () =>
    Effect.gen(function* () {
      const synthesized = yield* synthesize(
        respondWith(Uint8Array.from([1, 2, 3]), { headers: { "character-cost": "12" } }),
      );
      expect(synthesized.bytes).toEqual(Uint8Array.from([1, 2, 3]));
      expect(synthesized.mimeType).toBe("audio/mpeg");
      expect(synthesized.cost).toEqual({ usd: null, billedCharacters: 12 });

      const withoutHeader = yield* synthesize(respondWith(Uint8Array.from([1])));
      expect(withoutHeader.cost).toEqual({ usd: null, billedCharacters: null });
    }),
  );

  it.effect("distinguishes an exhausted quota from other rejections", () =>
    Effect.gen(function* () {
      // The shape ElevenLabs actually returns for an exhausted quota (a 401,
      // like a bad key).
      const quota = yield* failureOf(
        respondWith(
          '{"detail":{"status":"quota_exceeded","message":"This request exceeds your quota of 30738."}}',
          { status: 401 },
        ),
      );
      expect(quota).toBeInstanceOf(ElevenLabsTtsError);
      expect(quota.reason).toBe("quota_exceeded");
      expect(speechFailureReasonFor(quota)).toBe("provider_quota_exceeded");

      const badKey = yield* failureOf(
        respondWith('{"detail":{"status":"invalid_api_key"}}', { status: 401 }),
      );
      expect(badKey.reason).toBe("request_failed");
      expect(speechFailureReasonFor(badKey)).toBe("provider_failed");

      const notJson = yield* failureOf(respondWith("Service Unavailable", { status: 503 }));
      expect(notJson.reason).toBe("request_failed");
    }),
  );

  it.effect("rejects an empty audio body", () =>
    Effect.gen(function* () {
      const empty = yield* failureOf(respondWith(null, { status: 200 }));
      expect(empty.reason).toBe("empty_audio");
    }),
  );
});
