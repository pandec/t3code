import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { runClaudeHistoryProcess } from "./claudeHistoryProcess.ts";

interface RecordedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: { readonly env: NodeJS.ProcessEnv };
}

function fakeSpawner(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}) {
  const commands: Array<RecordedCommand> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    // Reads the command's private fields to assert what would be spawned.
    commands.push(command as unknown as RecordedCommand);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(result.stdout)),
        stderr: Stream.encodeText(Stream.make(result.stderr)),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { commands, spawner };
}

const decodeSessionMessages = Schema.decodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ uuid: Schema.String }))),
);
const decodeFork = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ sessionId: Schema.String })),
);

describe("runClaudeHistoryProcess", () => {
  it.effect.each([false, true])(
    "runs the worker under the pinned environment (executable host: %s)",
    (executable) => {
      const { commands, spawner } = fakeSpawner({ stdout: "[]", stderr: "", code: 0 });
      return Effect.gen(function* () {
        const stdout = yield* runClaudeHistoryProcess({
          method: "getSessionMessages",
          sessionId: "session-1",
          options: { dir: "/workspace" },
          environment: { CLAUDE_CONFIG_DIR: "/accounts/work/.claude" },
        });

        assert.equal(stdout, "[]");
        assert.equal(commands.length, 1);
        const command = commands[0]!;
        assert.equal(command.command, "/host/executable");
        if (executable) {
          assert.equal(command.args[0], "__claude-history");
        } else {
          assert.match(command.args[0]!, /claude-history-worker\.(ts|mjs)$/);
        }
        assert.deepEqual(command.args.slice(1), [
          "getSessionMessages",
          "session-1",
          '{"dir":"/workspace"}',
        ]);
        assert.equal(command.options.env.CLAUDE_CONFIG_DIR, "/accounts/work/.claude");
        assert.equal(command.options.env.ELECTRON_RUN_AS_NODE, "1");
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcess.IsExecutable, executable),
        Effect.provideService(HostProcess.ExecutablePath, "/host/executable"),
        Effect.provide(NodeServices.layer),
      );
    },
  );

  it.effect("fails with the worker's stderr when it exits unsuccessfully", () => {
    const { spawner } = fakeSpawner({ stdout: "", stderr: "Session not found.\n", code: 1 });
    return Effect.gen(function* () {
      const error = yield* runClaudeHistoryProcess({
        method: "forkSession",
        sessionId: "missing-session",
        options: {},
        environment: {},
      }).pipe(Effect.flip);

      assert.equal(error._tag, "ClaudeHistoryProcessError");
      assert.equal(error.detail, "Session not found.");
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect(
    "forks and reads a transcript stored only in the pinned config directory",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const configDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-history-config-",
          });
          const cwd = "/tmp/t3-claude-history-project";
          const projectDir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
          yield* fileSystem.makeDirectory(projectDir, { recursive: true });
          const sessionId = "11111111-1111-4111-8111-111111111111";
          const userId = "22222222-2222-4222-8222-222222222221";
          const assistantId = "22222222-2222-4222-8222-222222222222";
          const base = {
            sessionId,
            cwd,
            isSidechain: false,
            userType: "external",
            version: "2.1.0",
            timestamp: "2026-10-04T00:00:00.000Z",
          };
          yield* fileSystem.writeFileString(
            path.join(projectDir, `${sessionId}.jsonl`),
            [
              {
                ...base,
                type: "user",
                uuid: userId,
                parentUuid: null,
                message: { role: "user", content: "hello" },
              },
              {
                ...base,
                type: "assistant",
                uuid: assistantId,
                parentUuid: userId,
                message: {
                  role: "assistant",
                  id: "msg_1",
                  type: "message",
                  model: "claude-sonnet-4-6",
                  content: [{ type: "text", text: "hi" }],
                },
              },
            ]
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n",
          );
          // The server's own CLAUDE_CONFIG_DIR/HOME never see this transcript.
          const environment = { ...process.env, CLAUDE_CONFIG_DIR: configDir };

          const forked = decodeFork(
            yield* runClaudeHistoryProcess({
              method: "forkSession",
              sessionId,
              options: { dir: cwd },
              environment,
            }),
          );
          const forkedMessages = decodeSessionMessages(
            yield* runClaudeHistoryProcess({
              method: "getSessionMessages",
              sessionId: forked.sessionId,
              options: { dir: cwd },
              environment,
            }),
          );
          const subagentMessages = yield* runClaudeHistoryProcess({
            method: "getSubagentMessages",
            sessionId,
            options: { dir: cwd, agentId: "missing-agent", limit: 1 },
            environment,
          });

          assert.notEqual(forked.sessionId, sessionId);
          assert.isTrue(
            yield* fileSystem.exists(path.join(projectDir, `${forked.sessionId}.jsonl`)),
          );
          assert.equal(forkedMessages.length, 2);
          assert.equal(subagentMessages, "[]");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  );
});
