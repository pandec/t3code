import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessExecutablePath, HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeSessionImport, makeCodexSessionImport } from "./ProviderSessionImport.ts";

const SOURCE_THREAD_ID = "01a0d5ef-9a99-7bf2-a24c-197fc5cc32ff";
const FORKED_THREAD_ID = "01a0d5ef-9a99-7bf2-a24c-197fc5cc3300";

interface RecordedRequest {
  readonly method: string;
  readonly params: unknown;
}

const decodeRpcMessage = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Unknown),
    }),
  ),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Codex thread record as the app-server returns it (shape from a recorded transcript). */
const codexThread = (input: { readonly id: string; readonly cwd: string }) => ({
  id: input.id,
  environments: [{ environmentId: "local", cwd: input.cwd, runtimeWorkspaceRoots: [input.cwd] }],
  extra: null,
  sessionId: input.id,
  forkedFromId: null,
  parentThreadId: null,
  preview: "Fix the parser",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  model: "gpt-5.4",
  reasoningEffort: null,
  createdAt: 1790295644,
  updatedAt: 1790295651,
  recencyAt: 1790295649,
  status: { type: "idle" },
  path: `/home/user/.codex/sessions/${input.id}.jsonl`,
  cwd: input.cwd,
  cliVersion: "0.156.1",
  originator: "codex_cli_rs",
  source: "cli",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "Parser work",
  daybreakEnabled: null,
  turns: [],
});

/**
 * A spawner whose child speaks the app-server's newline-delimited JSON-RPC,
 * answering each request with `respond(method, params)`.
 */
function fakeCodexAppServer(respond: (method: string, params: unknown) => unknown) {
  const requests: Array<RecordedRequest> = [];
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      const outgoing = yield* Queue.unbounded<string>();
      const decoder = new TextDecoder();
      let buffered = "";
      const handleLine = (line: string) =>
        Effect.gen(function* () {
          const message = decodeRpcMessage(line);
          if (message.method === undefined) return;
          requests.push({ method: message.method, params: message.params });
          if (message.id === undefined) return;
          const result = respond(message.method, message.params);
          yield* Queue.offer(outgoing, `${encodeJson({ id: message.id, result })}\n`);
        });
      const stdin = Sink.forEach((chunk: Uint8Array) =>
        Effect.gen(function* () {
          buffered += decoder.decode(chunk, { stream: true });
          let newline = buffered.indexOf("\n");
          while (newline >= 0) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            if (line.length > 0) yield* handleLine(line);
            newline = buffered.indexOf("\n");
          }
        }),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin,
        stdout: Stream.encodeText(Stream.fromQueue(outgoing)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { requests, spawner };
}

const initializeResult = {
  userAgent: "codex-test",
  codexHome: "/home/user/.codex",
  platformFamily: "unix",
  platformOs: "linux",
};

describe("makeCodexSessionImport", () => {
  it.effect("reads a thread recorded in the selected workspace and rejects one from another", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-import-" }),
        );
        let recordedCwd = workspace;
        const { requests, spawner } = fakeCodexAppServer((method) =>
          method === "initialize"
            ? initializeResult
            : { thread: codexThread({ id: SOURCE_THREAD_ID, cwd: recordedCwd }) },
        );
        const sessionImport = yield* makeCodexSessionImport({ binaryPath: "codex" }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        const imported = yield* sessionImport.readSession({
          nativeSessionId: SOURCE_THREAD_ID,
          cwd: workspace,
        });
        assert.equal(imported.nativeSessionId, SOURCE_THREAD_ID);
        assert.equal(imported.name, "Parser work");
        assert.deepEqual(requests.find((request) => request.method === "thread/read")?.params, {
          threadId: SOURCE_THREAD_ID,
          includeTurns: true,
        });

        // Codex resumes a thread only in the workspace it recorded.
        recordedCwd = "/somewhere/else";
        const mismatch = yield* sessionImport
          .readSession({ nativeSessionId: SOURCE_THREAD_ID, cwd: workspace })
          .pipe(Effect.flip);
        assert.equal(mismatch._tag, "ProviderSessionImportError");
        assert.include(mismatch.detail, "/somewhere/else");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("forks without copying turns and returns the new native thread id", () =>
    Effect.gen(function* () {
      const { requests, spawner } = fakeCodexAppServer((method) =>
        method === "initialize"
          ? initializeResult
          : {
              thread: codexThread({ id: FORKED_THREAD_ID, cwd: "/workspace" }),
              model: "gpt-5.4",
              modelProvider: "openai",
              serviceTier: null,
              disabledPluginIds: [],
              cwd: "/workspace",
              instructionSources: [],
              approvalPolicy: "on-request",
              approvalsReviewer: "user",
              sandbox: { type: "dangerFullAccess" },
              reasoningEffort: null,
            },
      );
      const sessionImport = yield* makeCodexSessionImport({ binaryPath: "codex" }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const forkedId = yield* sessionImport.forkSession({
        nativeSessionId: SOURCE_THREAD_ID,
        cwd: "/workspace",
      });

      assert.equal(forkedId, FORKED_THREAD_ID);
      assert.deepEqual(requests.find((request) => request.method === "thread/fork")?.params, {
        threadId: SOURCE_THREAD_ID,
        cwd: "/workspace",
        excludeTurns: true,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("makeClaudeSessionImport", () => {
  const forkWithWorkerOutput = (stdout: string) => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    return Effect.gen(function* () {
      const sessionImport = yield* makeClaudeSessionImport({
        config: { homePath: "/home/user/.claude" },
        environment: {},
      });
      return yield* sessionImport.forkSession({
        nativeSessionId: "11111111-1111-4111-8111-111111111111",
        cwd: "/workspace",
      });
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcessIsExecutable, false),
      Effect.provideService(HostProcessExecutablePath, "/host/node"),
      Effect.provide(NodeServices.layer),
    );
  };

  it.effect("returns the forked session id only when the worker reports a UUID", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* forkWithWorkerOutput('{"sessionId":"22222222-2222-4222-8222-222222222222"}'),
        "22222222-2222-4222-8222-222222222222",
      );
      const error = yield* forkWithWorkerOutput('{"sessionId":"../escape"}').pipe(Effect.flip);
      assert.equal(error._tag, "ProviderSessionImportError");
    }),
  );
});
