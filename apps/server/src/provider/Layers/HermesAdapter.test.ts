// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { makeHermesAdapter } from "./HermesAdapter.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockHermesWrapper(extraEnv?: Record<string, string>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-mock-"));
  const wrapperPath = NodePath.join(directory, "hermes");
  const envExports = Object.entries({
    T3_ACP_USE_HERMES_MODES: "1",
    ...extraEnv,
  })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh
${envExports}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}
`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(
  filePath: string,
  expectedContent: string,
  attempts = 80,
): Effect.Effect<string> {
  const loop = (remaining: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remaining <= 0) {
        return yield* Effect.die(
          new Error(`Timed out waiting for ${expectedContent} in ${filePath}`),
        );
      }
      const contents = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (contents.includes(expectedContent)) {
        return contents;
      }
      yield* Effect.sleep("25 millis");
      return yield* loop(remaining - 1);
    });
  return loop(attempts);
}

const hermesAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string) =>
  makeHermesAdapter(
    decodeHermesSettings({ enabled: true, binaryPath, requireGateway: false }),
  ).pipe(Effect.orDie);

it.layer(hermesAdapterTestLayer)("HermesAdapter", (it) => {
  it.effect("starts a session and maps ACP prompt streaming to canonical events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-core");
      const adapter = yield* makeTestAdapter(yield* Effect.promise(() => makeMockHermesWrapper()));
      const events: Array<ProviderRuntimeEvent> = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "anthropic:claude-sonnet-5",
        },
      });
      assert.equal(session.provider, "hermes");
      assert.equal(session.model, "anthropic:claude-sonnet-5");
      assert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({ threadId, input: "hello hermes", attachments: [] });
      yield* Effect.yieldNow;
      assert.includeMembers(
        events.map((event) => event.type),
        ["session.started", "thread.started", "turn.started", "content.delta", "turn.completed"],
      );
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("uses provider permission kinds to select the agent option id", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-permission-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            T3_ACP_EMIT_TOOL_CALLS: "1",
            T3_ACP_ALLOW_ONCE_OPTION_ID: "hermes-allow-once",
          }),
        ),
      );
      const threadId = ThreadId.make("hermes-permission");
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "use a tool", attachments: [] });
      const requests = yield* waitForFileContent(requestLogPath, "hermes-allow-once");
      assert.include(requests, "hermes-allow-once");
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("settles open Hermes tool cards before the final turn completion", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() =>
          makeMockHermesWrapper({ T3_ACP_EMIT_HERMES_OPEN_TOOL_CALL: "1" }),
        ),
      );
      const threadId = ThreadId.make("hermes-tool-settle");
      const events: Array<ProviderRuntimeEvent> = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "leave a tool open", attachments: [] });
      yield* Effect.yieldNow;
      const toolCompletionIndex = events.findIndex(
        (event) => event.type === "item.completed" && String(event.itemId) === "hermes-open-tool-1",
      );
      const turnCompletionIndex = events.findIndex((event) => event.type === "turn.completed");
      assert.isAtLeast(toolCompletionIndex, 0);
      assert.isAbove(turnCompletionIndex, toolCompletionIndex);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps a steered turn open until the last-resolving original prompt", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-steer-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            T3_ACP_FIRST_PROMPT_DELAY_MS: "300",
          }),
        ),
      );
      const threadId = ThreadId.make("hermes-steer");
      const events: Array<ProviderRuntimeEvent> = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const first = yield* adapter
        .sendTurn({ threadId, input: "first prompt", attachments: [] })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* waitForFileContent(requestLogPath, "first prompt");
      yield* adapter.sendTurn({ threadId, input: "steer prompt", attachments: [] });
      const requestsAfterSteer = yield* waitForFileContent(requestLogPath, "steer prompt");
      assert.equal((requestsAfterSteer.match(/session\/prompt/gu) ?? []).length, 2);
      assert.notInclude(
        events.map((event) => event.type),
        "turn.completed",
      );

      yield* Fiber.join(first);
      yield* Effect.yieldNow;
      assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
      assert.isAtLeast(events.filter((event) => event.type === "content.delta").length, 2);
      const snapshot = yield* adapter.readThread(threadId);
      expect(snapshot.turns).toMatchObject([
        {
          items: [
            { prompt: [{ type: "text", text: "first prompt" }] },
            { prompt: [{ type: "text", text: "steer prompt" }] },
          ],
        },
      ]);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("rejects an empty replay-free Hermes session/load response as pruned", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() => makeMockHermesWrapper({ T3_ACP_EMPTY_LOAD_SESSION: "1" })),
      );
      const error = yield* Effect.flip(
        adapter.startSession({
          threadId: ThreadId.make("hermes-pruned"),
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "pruned-session" },
        }),
      );
      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.include(error.message, "Hermes no longer has this session");
    }),
  );

  it.effect("resets a resumed dont_ask session to default outside full access", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-resume-mode-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            T3_ACP_INITIAL_MODE_ID: "dont_ask",
          }),
        ),
      );
      const threadId = ThreadId.make("hermes-resume-mode");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "live-session" },
      });
      const requests = yield* waitForFileContent(requestLogPath, "session/set_mode");
      assert.include(requests, '"modeId":"default"');
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("interrupts a running prompt and emits a cancelled turn", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-interrupt-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          }),
        ),
      );
      const threadId = ThreadId.make("hermes-interrupt");
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, event) : Effect.void,
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const send = yield* adapter
        .sendTurn({ threadId, input: "hang", attachments: [] })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.sleep("50 millis");
      yield* adapter.interruptTurn(threadId);
      assert.equal((yield* Deferred.await(completed)).payload.state, "cancelled");
      yield* Fiber.join(send);
      yield* adapter.sendTurn({ threadId, input: "after cancellation", attachments: [] });
      const requests = yield* waitForFileContent(requestLogPath, "after cancellation");
      assert.isBelow(requests.indexOf("session/cancel"), requests.indexOf("after cancellation"));
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("sends SIGTERM when the Hermes session stops", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-stop-")),
      );
      const exitLogPath = NodePath.join(directory, "exit.log");
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() => makeMockHermesWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath })),
      );
      const threadId = ThreadId.make("hermes-stop");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);
      assert.include(yield* waitForFileContent(exitLogPath, "SIGTERM"), "SIGTERM");
    }),
  );
});
