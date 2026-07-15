// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { forkClaudePersistedSession } from "./ClaudeSessionFork.ts";

it.layer(NodeServices.layer)("ClaudeSessionFork", (it) => {
  it.effect("forks a real SDK transcript inside the configured Claude HOME", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-fork-"))),
      (homePath) =>
        Effect.gen(function* () {
          const sourceSessionId = "11111111-1111-4111-8111-111111111111";
          const projectDirectory = NodePath.join(
            homePath,
            ".claude",
            "projects",
            "fixture-project",
          );
          NodeFS.mkdirSync(projectDirectory, { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(projectDirectory, `${sourceSessionId}.jsonl`),
            [
              `{"type":"user","uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","sessionId":"${sourceSessionId}","parentUuid":null,"timestamp":"2026-07-15T08:00:00.000Z","message":{"role":"user","content":"hello"}}`,
              `{"type":"assistant","uuid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","sessionId":"${sourceSessionId}","parentUuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","timestamp":"2026-07-15T08:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}`,
              "",
            ].join("\n"),
          );
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const originalHome = process.env.HOME;

          const result = yield* forkClaudePersistedSession({
            sessionId: sourceSessionId,
            environment: { ...process.env, HOME: homePath },
            spawner,
          });

          expect(result.sessionId).not.toBe(sourceSessionId);
          expect(
            NodeFS.existsSync(NodePath.join(projectDirectory, `${result.sessionId}.jsonl`)),
          ).toBe(true);
          expect(process.env.HOME).toBe(originalHome);
        }),
      (homePath) =>
        Effect.sync(() => {
          NodeFS.rmSync(homePath, { recursive: true, force: true });
        }),
    ),
  );
});
