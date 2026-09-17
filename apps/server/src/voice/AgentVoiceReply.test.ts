import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ThreadId, TurnId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ServerSettingsModule from "../serverSettings.ts";
import { AgentVoiceReply, layer as agentVoiceReplyLayer } from "./AgentVoiceReply.ts";
import * as TtsService from "./TtsService.ts";
import type { SynthesizedSpeech } from "./ttsTypes.ts";
import { wrapPcmAsWav } from "./wavAudio.ts";

const emptySecretStore = ServerSecretStore.ServerSecretStore.of({
  get: () => Effect.succeedNone,
  set: () => Effect.void,
  create: () => Effect.void,
  getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  remove: () => Effect.void,
});

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
// ElevenLabs segment here starts with. The fourcc lands at offset 21.
const headerFrame = (fourcc: string): Uint8Array => {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0xc0]);
  frame.set(
    [...fourcc].map((char) => char.charCodeAt(0)),
    21,
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

describe("stage", () => {
  const threadId = "thread-voice" as ThreadId;
  const turnOne = "turn-1" as TurnId;
  const turnTwo = "turn-2" as TurnId;

  const segment = (marker: number) =>
    concat(id3Tag(20), headerFrame("Info"), frames(marker, marker));

  // Each stage call synthesizes the next queued segment.
  const segmentQueue: Uint8Array[] = [];
  const stubHttpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      const bytes = segmentQueue.shift();
      if (!bytes) throw new Error("no segment queued");
      return HttpClientResponse.fromWeb(request, new Response(bytes));
    }),
  );

  const TestLayer = agentVoiceReplyLayer.pipe(
    Layer.provideMerge(
      TtsService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, stubHttpClient),
            Layer.succeed(ServerSecretStore.ServerSecretStore, emptySecretStore),
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { ELEVENLABS_API_KEY: "test-key" } }),
            ),
          ),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        SqliteClient.layerMemory(),
        ServerConfig.layerTest(process.cwd(), { prefix: "agent-voice-reply-test-" }),
        // The pre-OpenRouter default is ElevenLabs; the stub above answers as it.
        ServerSettingsModule.layerTest({ voice: { tts: { provider: "elevenlabs" } } }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  effectIt.effect("checks the selected agent profile before synthesis", () =>
    Effect.gen(function* () {
      const service = yield* AgentVoiceReply;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      expect(yield* service.available).toBe(true);
      yield* settings.updateSettings({ voice: { agentReplyTts: { provider: "openrouter" } } });
      expect(yield* service.available).toBe(false);
      expect(
        yield* service.stage({ threadId, script: "Unavailable." }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } });
      yield* settings.updateSettings({ voice: { agentReplyTts: null } });
      expect(yield* service.available).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  effectIt.effect("keeps staged WAV audio on merge failure and cleans up both containers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const tts = yield* TtsService.TtsService;
      const wav = (marker: number) =>
        wrapPcmAsWav(frames(marker, marker), {
          sampleRate: 24_000,
          channels: 1,
          bitsPerSample: 16,
        });
      let next: SynthesizedSpeech = {
        bytes: wav(1),
        mimeType: "audio/wav",
        cost: { usd: null, billedCharacters: null },
      };
      const service = yield* AgentVoiceReply.pipe(
        Effect.provide(
          Layer.fresh(agentVoiceReplyLayer).pipe(
            Layer.provide(
              Layer.succeed(TtsService.TtsService, {
                ...tts,
                synthesize: () => Effect.sync(() => next),
              }),
            ),
          ),
        ),
      );
      const speechPath = (speechId: string, extension = ".wav") =>
        `${config.attachmentsDir}/${speechId}${extension}`;
      yield* sql`CREATE TABLE projection_thread_sessions (thread_id TEXT, active_turn_id TEXT)`;
      yield* sql`INSERT INTO projection_thread_sessions VALUES (${threadId}, ${turnOne})`;
      const first = yield* service.stage({ threadId, script: "First." });
      next = { ...next, bytes: wav(2) };
      const second = yield* service.stage({ threadId, script: "Second." });
      expect(second.mimeType).toBe("audio/wav");
      expect(yield* fileSystem.exists(speechPath(first.speechId))).toBe(false);
      expect(Uint8Array.from(yield* fileSystem.readFile(speechPath(second.speechId)))).toEqual(
        wrapPcmAsWav(frames(1, 1, 2, 2), { sampleRate: 24_000, channels: 1, bitsPerSample: 16 }),
      );
      next = { ...next, bytes: segment(3), mimeType: "audio/mpeg" };
      expect(
        yield* service.stage({ threadId, script: "Wrong container." }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "storage_failed" } });
      next = { ...next, bytes: wav(3).subarray(0, 44), mimeType: "audio/wav" };
      expect(
        yield* service.stage({ threadId, script: "Truncated." }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "storage_failed" } });
      expect(yield* fileSystem.readDirectory(config.attachmentsDir)).toEqual([
        `${second.speechId}.wav`,
      ]);
      const claimed = yield* service.claimStagedForTurn(threadId, turnOne);
      expect(claimed?.attachment).toEqual(second);

      next = { ...next, bytes: wav(4) };
      const third = yield* service.stage({ threadId, script: "Another WAV." });
      yield* sql`UPDATE projection_thread_sessions SET active_turn_id = ${turnTwo}`;
      next = { ...next, bytes: segment(5), mimeType: "audio/mpeg" };
      const fourth = yield* service.stage({ threadId, script: "New turn MP3." });
      expect(yield* fileSystem.exists(speechPath(third.speechId))).toBe(false);
      yield* service.discardStaged(threadId);
      expect(yield* fileSystem.exists(speechPath(fourth.speechId, ".mp3"))).toBe(false);
      expect(yield* fileSystem.exists(speechPath(second.speechId))).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  effectIt.effect("appends same-turn calls into one recording, replaces on a newer turn", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const agentVoiceReply = yield* AgentVoiceReply;
      const speechPath = (speechId: string) => `${serverConfig.attachmentsDir}/${speechId}.mp3`;

      yield* sql`
        CREATE TABLE projection_thread_sessions (
          thread_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          active_turn_id TEXT,
          updated_at TEXT NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
        VALUES (${threadId}, ${"running"}, ${turnOne}, ${"2026-08-25T00:00:00Z"})
      `;

      // First call: stored byte-identical to what synthesis returned.
      segmentQueue.push(segment(0x01));
      const first = yield* agentVoiceReply.stage({ threadId, script: "First part." });
      expect(first.transcript).toBe("First part.");
      // Length is recorded from the bytes: an MP3 is read at its constant 128 kbps.
      expect(first.durationMs).toBe(Math.round((segment(0x01).byteLength * 8 * 1000) / 128_000));
      expect(Uint8Array.from(yield* fileSystem.readFile(speechPath(first.speechId)))).toEqual(
        segment(0x01),
      );

      // Second call in the same turn: one merged entry, joined transcript,
      // bare-frame audio in call order, superseded file removed.
      segmentQueue.push(segment(0x02));
      const second = yield* agentVoiceReply.stage({ threadId, script: "Second part." });
      expect(second.transcript).toBe("First part.\n\nSecond part.");
      const mergedBytes = Uint8Array.from(yield* fileSystem.readFile(speechPath(second.speechId)));
      expect(mergedBytes).toEqual(frames(0x01, 0x01, 0x02, 0x02));
      expect(second.sizeBytes).toBe(mergedBytes.byteLength);
      expect(second.durationMs).toBe(Math.round((mergedBytes.byteLength * 8 * 1000) / 128_000));
      expect(yield* fileSystem.exists(speechPath(first.speechId))).toBe(false);

      // A call from a newer turn replaces instead of appending.
      yield* sql`UPDATE projection_thread_sessions SET active_turn_id = ${turnTwo}`;
      segmentQueue.push(segment(0x03));
      const third = yield* agentVoiceReply.stage({ threadId, script: "Next turn." });
      expect(third.transcript).toBe("Next turn.");
      expect(Uint8Array.from(yield* fileSystem.readFile(speechPath(third.speechId)))).toEqual(
        segment(0x03),
      );
      expect(yield* fileSystem.exists(speechPath(second.speechId))).toBe(false);

      // Claim is exact-turn and one-shot.
      expect(yield* agentVoiceReply.claimStagedForTurn(threadId, turnOne)).toBeUndefined();
      const claimed = yield* agentVoiceReply.claimStagedForTurn(threadId, turnTwo);
      expect(claimed?.attachment.speechId).toBe(third.speechId);
      expect(yield* agentVoiceReply.claimStagedForTurn(threadId, turnTwo)).toBeUndefined();
    }).pipe(Effect.provide(TestLayer)),
  );
});
