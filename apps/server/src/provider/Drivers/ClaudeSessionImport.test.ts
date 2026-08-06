import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";

import {
  claudeProjectDirectoryName,
  findClaudeSessionCwd,
  parseClaudeTranscript,
  readClaudeSessionTranscript,
} from "./ClaudeSessionImport.ts";

const SESSION_ID = "9fc85367-4ed9-4dc7-a44e-bee92408ff84";

const toJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function entry(input: {
  uuid: string;
  parentUuid: string | null;
  type: "user" | "assistant";
  content: unknown;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  model?: string;
}): string {
  return toJsonLine({
    type: input.type,
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    ...(input.isSidechain !== undefined ? { isSidechain: input.isSidechain } : {}),
    ...(input.isMeta !== undefined ? { isMeta: input.isMeta } : {}),
    timestamp: input.timestamp ?? "2026-07-16T10:00:00.000Z",
    sessionId: SESSION_ID,
    message: {
      role: input.type,
      content: input.content,
      ...(input.model !== undefined ? { model: input.model } : {}),
    },
  });
}

const run = (lines: ReadonlyArray<string>) =>
  parseClaudeTranscript({ sessionId: SESSION_ID, lines });

describe("parseClaudeTranscript", () => {
  it.effect("extracts user and assistant text from the main chain", () =>
    Effect.gen(function* () {
      const result = yield* run([
        toJsonLine({ type: "queue-operation", operation: "enqueue" }),
        entry({
          uuid: "u1",
          parentUuid: null,
          type: "user",
          content: [{ type: "text", text: "Remember the codeword PINEAPPLE-42." }],
        }),
        entry({
          uuid: "a1",
          parentUuid: "u1",
          type: "assistant",
          content: [{ type: "text", text: "OK" }],
          model: "claude-sonnet-5",
        }),
        toJsonLine({ type: "last-prompt", prompt: "x" }),
      ]);
      expect(result.messages).toEqual([
        {
          role: "user",
          text: "Remember the codeword PINEAPPLE-42.",
          createdAt: "2026-07-16T10:00:00.000Z",
        },
        { role: "assistant", text: "OK", createdAt: "2026-07-16T10:00:00.000Z" },
      ]);
      expect(result.model).toBe("claude-sonnet-5");
    }),
  );

  it.effect("captures the latest custom-title record as the session name", () =>
    Effect.gen(function* () {
      const result = yield* run([
        entry({ uuid: "u1", parentUuid: null, type: "user", content: "hello" }),
        toJsonLine({ type: "custom-title", customTitle: "first-name", sessionId: SESSION_ID }),
        toJsonLine({ type: "custom-title", customTitle: "final-name", sessionId: SESSION_ID }),
        toJsonLine({ type: "custom-title", customTitle: "   ", sessionId: SESSION_ID }),
      ]);
      expect(result.name).toBe("final-name");
    }),
  );

  it.effect("returns a null name when no custom-title record exists", () =>
    Effect.gen(function* () {
      const result = yield* run([
        entry({ uuid: "u1", parentUuid: null, type: "user", content: "hello" }),
      ]);
      expect(result.name).toBeNull();
    }),
  );

  it.effect("supports plain string message content", () =>
    Effect.gen(function* () {
      const result = yield* run([
        entry({ uuid: "u1", parentUuid: null, type: "user", content: "plain text prompt" }),
      ]);
      expect(result.messages).toEqual([
        { role: "user", text: "plain text prompt", createdAt: "2026-07-16T10:00:00.000Z" },
      ]);
    }),
  );

  it.effect("skips sidechain entries and tool-only entries", () =>
    Effect.gen(function* () {
      const result = yield* run([
        entry({
          uuid: "u1",
          parentUuid: null,
          type: "user",
          content: [{ type: "text", text: "main question" }],
        }),
        entry({
          uuid: "s1",
          parentUuid: "u1",
          type: "assistant",
          content: [{ type: "text", text: "sidechain noise" }],
          isSidechain: true,
        }),
        entry({
          uuid: "a1",
          parentUuid: "u1",
          type: "assistant",
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }],
        }),
        entry({
          uuid: "u2",
          parentUuid: "a1",
          type: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "output" }],
        }),
        entry({
          uuid: "a2",
          parentUuid: "u2",
          type: "assistant",
          content: [{ type: "text", text: "final answer" }],
        }),
      ]);
      expect(result.messages).toEqual([
        { role: "user", text: "main question", createdAt: "2026-07-16T10:00:00.000Z" },
        { role: "assistant", text: "final answer", createdAt: "2026-07-16T10:00:00.000Z" },
      ]);
    }),
  );

  it.effect("keeps chain linkage through benign records and skips isMeta entries", () =>
    Effect.gen(function* () {
      // Mirrors real files: attachments sit between messages in the ancestry
      // chain, and harness-injected isMeta user entries are not conversation.
      const result = yield* run([
        entry({
          uuid: "u1",
          parentUuid: null,
          type: "user",
          content: [{ type: "text", text: "real question" }],
        }),
        toJsonLine({ type: "attachment", uuid: "att1", parentUuid: "u1" }),
        entry({
          uuid: "meta1",
          parentUuid: "att1",
          type: "user",
          content: [{ type: "text", text: "skill scaffolding" }],
          isMeta: true,
        }),
        entry({
          uuid: "a1",
          parentUuid: "meta1",
          type: "assistant",
          content: [{ type: "text", text: "real answer" }],
        }),
      ]);
      expect(result.messages.map((message) => message.text)).toEqual([
        "real question",
        "real answer",
      ]);
    }),
  );

  it.effect("follows the active ancestry chain across a rewind branch", () =>
    Effect.gen(function* () {
      // u1 -> a1 -> u2a -> a2a (abandoned branch), then a rewind creates
      // u2b -> a2b from a1. The active chain must exclude the u2a branch.
      const result = yield* run([
        entry({
          uuid: "u1",
          parentUuid: null,
          type: "user",
          content: [{ type: "text", text: "start" }],
        }),
        entry({
          uuid: "a1",
          parentUuid: "u1",
          type: "assistant",
          content: [{ type: "text", text: "first answer" }],
        }),
        entry({
          uuid: "u2a",
          parentUuid: "a1",
          type: "user",
          content: [{ type: "text", text: "abandoned follow-up" }],
        }),
        entry({
          uuid: "a2a",
          parentUuid: "u2a",
          type: "assistant",
          content: [{ type: "text", text: "abandoned answer" }],
        }),
        entry({
          uuid: "u2b",
          parentUuid: "a1",
          type: "user",
          content: [{ type: "text", text: "rewound follow-up" }],
        }),
        entry({
          uuid: "a2b",
          parentUuid: "u2b",
          type: "assistant",
          content: [{ type: "text", text: "rewound answer" }],
        }),
      ]);
      expect(result.messages.map((message) => message.text)).toEqual([
        "start",
        "first answer",
        "rewound follow-up",
        "rewound answer",
      ]);
    }),
  );

  it.effect("keeps the last real model when a synthetic assistant record follows it", () =>
    Effect.gen(function* () {
      const result = yield* run([
        entry({ uuid: "u1", parentUuid: null, type: "user", content: "question" }),
        entry({
          uuid: "a1",
          parentUuid: "u1",
          type: "assistant",
          content: "real answer",
          model: "claude-opus-4-8",
        }),
        entry({
          uuid: "a2",
          parentUuid: "a1",
          type: "assistant",
          content: "synthetic notice",
          model: "<synthetic>",
        }),
      ]);

      expect(result.model).toBe("claude-opus-4-8");
      expect(result.messages.at(-1)?.text).toBe("synthetic notice");
    }),
  );

  it.effect("fails loudly on an unrecognized record type", () =>
    Effect.gen(function* () {
      const error = yield* run([
        entry({
          uuid: "u1",
          parentUuid: null,
          type: "user",
          content: [{ type: "text", text: "hello" }],
        }),
        toJsonLine({ type: "brand-new-record-kind", data: 1 }),
      ]).pipe(Effect.flip);
      expect(error._tag).toBe("ClaudeTranscriptParseError");
      expect(error.line).toBe(2);
      expect(error.detail).toContain("brand-new-record-kind");
    }),
  );

  it.effect("fails loudly on invalid JSON", () =>
    Effect.gen(function* () {
      const error = yield* run(["{not json"]).pipe(Effect.flip);
      expect(error._tag).toBe("ClaudeTranscriptParseError");
      expect(error.detail).toContain("not valid JSON");
    }),
  );
});

describe("claudeProjectDirectoryName", () => {
  it("escapes every non-alphanumeric character to a dash", () => {
    expect(claudeProjectDirectoryName("/private/tmp/t3-spike-claude-repo")).toBe(
      "-private-tmp-t3-spike-claude-repo",
    );
    expect(claudeProjectDirectoryName("/Users/user/.dotfiles")).toBe("-Users-user--dotfiles");
  });
});

describe("readClaudeSessionTranscript", () => {
  it.effect("reads sessions directly from a custom Claude config directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-claude-custom-config-",
      });
      const configDirPath = path.join(root, ".claude-work");
      const canonicalCwd = "/tmp/custom-project";
      const sessionsPath = path.join(
        configDirPath,
        "projects",
        claudeProjectDirectoryName(canonicalCwd),
      );
      yield* fileSystem.makeDirectory(sessionsPath, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(sessionsPath, `${SESSION_ID}.jsonl`),
        entry({ uuid: "u1", parentUuid: null, type: "user", content: "hello" }),
      );

      const transcript = yield* readClaudeSessionTranscript({
        configDirPath,
        canonicalCwd,
        sessionId: SESSION_ID,
      });
      expect(transcript.messages.map((message) => message.text)).toEqual(["hello"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a non-UUID session id before resolving a transcript path", () =>
    Effect.gen(function* () {
      const error = yield* readClaudeSessionTranscript({
        configDirPath: "/tmp/home/.claude",
        canonicalCwd: "/tmp/project",
        sessionId: "../other-project/session",
      }).pipe(Effect.flip);

      expect(error._tag).toBe("ClaudeSessionImportIoError");
      expect(error.detail).toContain("not a valid persisted session UUID");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("findClaudeSessionCwd", () => {
  const writeTranscript = Effect.fn("writeTranscript")(function* (input: {
    readonly configDirPath: string;
    readonly cwd: string;
    readonly lines: ReadonlyArray<string>;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(
      input.configDirPath,
      "projects",
      claudeProjectDirectoryName(input.cwd),
    );
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    const filePath = path.join(directory, `${SESSION_ID}.jsonl`);
    yield* fileSystem.writeFileString(filePath, `${input.lines.join("\n")}\n`);
    return filePath;
  });

  it.effect("reports the directory a session moved into, not the one it started in", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cwd-" });
      const configDirPath = path.join(root, ".claude");
      const workspaceRoot = "/tmp/project-moved";
      const worktree = "/tmp/project-moved/.claude/worktrees/feature";

      // Claude relocates the transcript into the new cwd's project directory,
      // and its trailing entries carry that cwd. The first entry keeps the
      // directory the session started in, which is what makes reading the tail
      // (rather than the head) the whole point.
      yield* writeTranscript({
        configDirPath,
        cwd: worktree,
        lines: [
          toJsonLine({ type: "user", uuid: "u1", cwd: workspaceRoot }),
          toJsonLine({ type: "assistant", uuid: "a1", cwd: worktree }),
          toJsonLine({ type: "last-prompt", cwd: null }),
        ],
      });

      const resolved = yield* findClaudeSessionCwd({ configDirPath, sessionId: SESSION_ID });
      expect(resolved).toBe(worktree);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers the most recently written copy when a stale one is left behind", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cwd-stale-" });
      const configDirPath = path.join(root, ".claude");
      const workspaceRoot = "/tmp/project-stale";
      const worktree = "/tmp/project-stale/.claude/worktrees/feature";

      const stalePath = yield* writeTranscript({
        configDirPath,
        cwd: workspaceRoot,
        lines: [toJsonLine({ type: "assistant", uuid: "a1", cwd: workspaceRoot })],
      });
      const livePath = yield* writeTranscript({
        configDirPath,
        cwd: worktree,
        lines: [toJsonLine({ type: "assistant", uuid: "a2", cwd: worktree })],
      });
      const staleTime = DateTime.toDate(DateTime.makeUnsafe(1_000));
      const liveTime = DateTime.toDate(DateTime.makeUnsafe(9_000_000));
      yield* fileSystem.utimes(stalePath, staleTime, staleTime);
      yield* fileSystem.utimes(livePath, liveTime, liveTime);

      const resolved = yield* findClaudeSessionCwd({ configDirPath, sessionId: SESSION_ID });
      expect(resolved).toBe(worktree);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns null for a missing transcript or a non-UUID session id", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-cwd-absent-" });
      const configDirPath = path.join(root, ".claude");

      expect(yield* findClaudeSessionCwd({ configDirPath, sessionId: SESSION_ID })).toBeNull();
      expect(
        yield* findClaudeSessionCwd({
          configDirPath,
          sessionId: "../other-project/session",
        }),
      ).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
