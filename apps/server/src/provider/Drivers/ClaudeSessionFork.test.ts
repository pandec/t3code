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

const writeSourceTranscript = (configDirPath: string, projectKey = "fixture-project") => {
  const projectDirectory = NodePath.join(configDirPath, "projects", projectKey);
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
        const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
        // Passing `dir` makes the SDK resolve it (awaited realpath) before it
        // reads CLAUDE_CONFIG_DIR, so an unserialized implementation would
        // read the other fork's override and fail to find its transcript.
        const makeWorkspace = (configDirPath: string) => {
          const workspace = NodeFS.realpathSync(
            NodeFS.mkdtempSync(NodePath.join(configDirPath, "ws-")),
          );
          const projectKey = workspace.replace(/[^a-zA-Z0-9]/g, "-");
          return { workspace, projectDirectory: writeSourceTranscript(configDirPath, projectKey) };
        };
        const first = makeWorkspace(firstConfigDir);
        const second = makeWorkspace(secondConfigDir);

        const [firstFork, secondFork] = yield* Effect.all(
          [
            forkClaudePersistedSession({
              sessionId: SOURCE_SESSION_ID,
              dir: first.workspace,
              configDirPath: firstConfigDir,
            }),
            forkClaudePersistedSession({
              sessionId: SOURCE_SESSION_ID,
              dir: second.workspace,
              configDirPath: secondConfigDir,
            }),
          ],
          { concurrency: "unbounded" },
        );

        expect(
          NodeFS.existsSync(NodePath.join(first.projectDirectory, `${firstFork.sessionId}.jsonl`)),
        ).toBe(true);
        expect(
          NodeFS.existsSync(
            NodePath.join(second.projectDirectory, `${secondFork.sessionId}.jsonl`),
          ),
        ).toBe(true);
        expect(process.env.CLAUDE_CONFIG_DIR).toBe(originalConfigDir);
      }),
    ),
  ),
);
