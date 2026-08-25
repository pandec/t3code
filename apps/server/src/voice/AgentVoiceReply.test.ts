import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ThreadId, TurnId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import {
  AgentVoiceReply,
  appendSpeechAudio,
  layer as agentVoiceReplyLayer,
  stripLeadingId3v2Tag,
  stripLeadingXingFrame,
} from "./AgentVoiceReply.ts";

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

    const merged = appendSpeechAudio(first, second);
    expect(merged).toEqual(frames(0x01, 0x02, 0x03, 0x04));
    // Re-appending to an already merged stream is stable.
    expect(appendSpeechAudio(merged, second)).toEqual(frames(0x01, 0x02, 0x03, 0x04, 0x03, 0x04));
  });
});

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
      Layer.mergeAll(
        SqliteClient.layerMemory(),
        ServerConfig.layerTest(process.cwd(), { prefix: "agent-voice-reply-test-" }),
        ServerSettingsModule.layerTest(),
        Layer.succeed(HttpClient.HttpClient, stubHttpClient),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ELEVENLABS_API_KEY: "test-key" } })),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
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
