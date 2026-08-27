// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ClaudeSessionForkError, forkClaudePersistedSession } from "./ClaudeSessionFork.ts";

const SOURCE_SESSION_ID = "11111111-1111-4111-8111-111111111111";

const withTempConfigDir = <A, E>(
  use: (configDirPath: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-fork-"))),
    use,
    (configDirPath) =>
      Effect.sync(() => {
        NodeFS.rmSync(configDirPath, { recursive: true, force: true });
      }),
  );

const writeSourceTranscript = (configDirPath: string) => {
  const projectDirectory = NodePath.join(configDirPath, "projects", "fixture-project");
  NodeFS.mkdirSync(projectDirectory, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(projectDirectory, `${SOURCE_SESSION_ID}.jsonl`),
    [
      `{"type":"user","uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","sessionId":"${SOURCE_SESSION_ID}","parentUuid":null,"timestamp":"2026-07-15T08:00:00.000Z","message":{"role":"user","content":"hello"}}`,
      `{"type":"assistant","uuid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","sessionId":"${SOURCE_SESSION_ID}","parentUuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","timestamp":"2026-07-15T08:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}`,
      "",
    ].join("\n"),
  );
  return projectDirectory;
};

it.effect("forks a real SDK transcript inside the configured Claude config dir", () =>
  withTempConfigDir((configDirPath) =>
    Effect.gen(function* () {
      const projectDirectory = writeSourceTranscript(configDirPath);
      const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

      const result = yield* forkClaudePersistedSession({
        sessionId: SOURCE_SESSION_ID,
        configDirPath,
      });

      expect(result.sessionId).not.toBe(SOURCE_SESSION_ID);
      expect(NodeFS.existsSync(NodePath.join(projectDirectory, `${result.sessionId}.jsonl`))).toBe(
        true,
      );
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(originalConfigDir);
    }),
  ),
);

it.effect("forks without touching the env when CLAUDE_CONFIG_DIR already matches", () =>
  withTempConfigDir((configDirPath) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = configDirPath;
        return previous;
      }),
      () =>
        Effect.gen(function* () {
          const projectDirectory = writeSourceTranscript(configDirPath);

          const result = yield* forkClaudePersistedSession({
            sessionId: SOURCE_SESSION_ID,
            configDirPath,
          });

          expect(
            NodeFS.existsSync(NodePath.join(projectDirectory, `${result.sessionId}.jsonl`)),
          ).toBe(true);
          expect(process.env.CLAUDE_CONFIG_DIR).toBe(configDirPath);
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
          } else {
            process.env.CLAUDE_CONFIG_DIR = previous;
          }
        }),
    ),
  ),
);

it.effect("fails with ClaudeSessionForkError and restores the env for unknown sessions", () =>
  withTempConfigDir((configDirPath) =>
    Effect.gen(function* () {
      const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

      const result = yield* forkClaudePersistedSession({
        sessionId: "99999999-9999-4999-8999-999999999999",
        configDirPath,
      }).pipe(Effect.flip);

      expect(result).toBeInstanceOf(ClaudeSessionForkError);
      expect(result.sessionId).toBe("99999999-9999-4999-8999-999999999999");
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(originalConfigDir);
    }),
  ),
);

it.effect("serializes concurrent forks so each targets its own config dir", () =>
  withTempConfigDir((firstConfigDir) =>
    withTempConfigDir((secondConfigDir) =>
      Effect.gen(function* () {
        const firstProject = writeSourceTranscript(firstConfigDir);
        const secondProject = writeSourceTranscript(secondConfigDir);

        const [first, second] = yield* Effect.all(
          [
            forkClaudePersistedSession({
              sessionId: SOURCE_SESSION_ID,
              configDirPath: firstConfigDir,
            }),
            forkClaudePersistedSession({
              sessionId: SOURCE_SESSION_ID,
              configDirPath: secondConfigDir,
            }),
          ],
          { concurrency: "unbounded" },
        );

        expect(NodeFS.existsSync(NodePath.join(firstProject, `${first.sessionId}.jsonl`))).toBe(
          true,
        );
        expect(NodeFS.existsSync(NodePath.join(secondProject, `${second.sessionId}.jsonl`))).toBe(
          true,
        );
      }),
    ),
  ),
);
