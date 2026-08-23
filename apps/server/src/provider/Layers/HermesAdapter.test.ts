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
  TurnId,
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
import { hermesPromptSettlementBelongsToContext, makeHermesAdapter } from "./HermesAdapter.ts";

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

it("requires a settlement to match the originating Hermes generation", () => {
  const turnId = TurnId.make("turn-1");
  assert.isFalse(
    hermesPromptSettlementBelongsToContext({
      liveAcpSessionId: "shared-session",
      expectedAcpSessionId: "shared-session",
      liveSessionGenerationId: "generation-2",
      originatingSessionGenerationId: "generation-1",
      liveActiveTurnId: turnId,
      liveSessionActiveTurnId: turnId,
      turnId,
    }),
  );
  assert.isTrue(
    hermesPromptSettlementBelongsToContext({
      liveAcpSessionId: "shared-session",
      expectedAcpSessionId: "shared-session",
      liveSessionGenerationId: "generation-1",
      originatingSessionGenerationId: "generation-1",
      liveActiveTurnId: turnId,
      liveSessionActiveTurnId: turnId,
      turnId,
    }),
  );
});

it.layer(hermesAdapterTestLayer)("HermesAdapter", (it) => {
  it.effect("surfaces terminal-only Hermes authentication during session startup", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_ADVERTISED_AUTH_METHOD_ID: "hermes-setup",
            T3_ACP_ADVERTISED_AUTH_METHOD_TYPE: "terminal",
          }),
        ),
      );
      const error = yield* Effect.flip(
        adapter.startSession({
          threadId: ThreadId.make("hermes-auth-setup"),
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        }),
      );
      expect(error.message).toContain("hermes --setup");
    }),
  );

  it.effect("starts a session and maps ACP prompt streaming to canonical events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-core");
      const adapter = yield* makeTestAdapter(yield* Effect.promise(() => makeMockHermesWrapper()));
      const events: Array<ProviderRuntimeEvent> = [];
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
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
        schemaVersion: 2,
        sessionId: "mock-session-1",
        defaultModelId: "openai-codex:gpt-5.6-sol",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello hermes",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "anthropic:claude-sonnet-5",
        },
      });
      yield* Deferred.await(completed);
      const [updatedSession] = yield* adapter.listSessions();
      assert.equal(updatedSession?.model, "anthropic:claude-sonnet-5");
      const turnStarted = events.find((event) => event.type === "turn.started");
      assert.equal(
        turnStarted?.type === "turn.started" ? turnStarted.payload.model : undefined,
        "anthropic:claude-sonnet-5",
      );
      const turnCompleted = events.find((event) => event.type === "turn.completed");
      assert.isString(session.sessionGenerationId);
      assert.equal(
        turnCompleted?.type === "turn.completed"
          ? turnCompleted.payload.sessionGenerationId
          : undefined,
        session.sessionGenerationId,
      );
      assert.includeMembers(
        events.map((event) => event.type),
        ["session.started", "thread.started", "turn.started", "content.delta", "turn.completed"],
      );
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("stamps session exit events with the session generation", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-exit-generation");
      const adapter = yield* makeTestAdapter(yield* Effect.promise(() => makeMockHermesWrapper()));
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      const exited = events.find((event) => event.type === "session.exited");
      assert.isString(session.sessionGenerationId);
      assert.equal(
        exited?.type === "session.exited" ? exited.payload.sessionGenerationId : undefined,
        session.sessionGenerationId,
      );
    }),
  );

  it.effect("echoes the default sentinel at session start and after sendTurn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-default-model");
      const adapter = yield* makeTestAdapter(yield* Effect.promise(() => makeMockHermesWrapper()));
      const events: Array<ProviderRuntimeEvent> = [];
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "default",
        },
      });
      assert.equal(session.model, "default");

      yield* adapter.sendTurn({
        threadId,
        input: "use the Hermes default",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "default",
        },
      });
      yield* Deferred.await(completed);

      const [updatedSession] = yield* adapter.listSessions();
      assert.equal(updatedSession?.model, "default");
      const turnStarted = events.find((event) => event.type === "turn.started");
      assert.equal(
        turnStarted?.type === "turn.started" ? turnStarted.payload.model : undefined,
        "default",
      );
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps the session model selection when a turn carries no selection", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-model-carry-over");
      const adapter = yield* makeTestAdapter(yield* Effect.promise(() => makeMockHermesWrapper()));
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "anthropic:claude-sonnet-5",
        },
      });

      // A turn without a model selection (CLI/action-driven turns) must not
      // collapse a concrete selection back to the sentinel.
      yield* adapter.sendTurn({ threadId, input: "no selection attached", attachments: [] });
      yield* Deferred.await(completed);

      const [updatedSession] = yield* adapter.listSessions();
      assert.equal(updatedSession?.model, "anthropic:claude-sonnet-5");
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores the Hermes-configured model when the sentinel is reselected mid-thread", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-sentinel-restore-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const threadId = ThreadId.make("hermes-sentinel-restore");
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() =>
          makeMockHermesWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
        ),
      );
      const completions: Array<ProviderRuntimeEvent> = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed"
          ? Effect.sync(() => {
              completions.push(event);
            })
          : Effect.void,
      ).pipe(Effect.forkChild);
      const waitForCompletions = (count: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            if (completions.length >= count) {
              return;
            }
            yield* Effect.sleep("25 millis");
          }
          return yield* Effect.die(
            new Error(`Timed out waiting for ${count} Hermes turn completions`),
          );
        });

      // The mock reports `openai-codex:gpt-5.6-sol` as its configured model, so
      // that is what the sentinel must resolve to.
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "default" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "switch to a concrete model",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "anthropic:claude-sonnet-5",
        },
      });
      yield* waitForCompletions(1);

      yield* adapter.sendTurn({
        threadId,
        input: "switch back to the Hermes default",
        attachments: [],
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "default" },
      });
      yield* waitForCompletions(2);

      const requests = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      const setModelIds = requests
        .split(/\r?\n/u)
        .filter((line) => line.includes('"session/set_model"'))
        .flatMap((line) => line.match(/"modelId":"([^"]+)"/u)?.[1] ?? []);
      assert.deepEqual(setModelIds, ["anthropic:claude-sonnet-5", "openai-codex:gpt-5.6-sol"]);

      const [updatedSession] = yield* adapter.listSessions();
      assert.equal(updatedSession?.model, "default");
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("preserves the configured default across resume before reselecting the sentinel", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-resume-default-model");
      const firstAdapter = yield* makeTestAdapter(
        yield* Effect.promise(() => makeMockHermesWrapper()),
      );
      const firstSession = yield* firstAdapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "anthropic:claude-sonnet-5",
        },
      });
      yield* firstAdapter.stopSession(threadId);

      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-resume-default-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const resumedAdapter = yield* makeTestAdapter(
        yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_INITIAL_MODEL_ID: "anthropic:claude-sonnet-5",
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          }),
        ),
      );
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(resumedAdapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
      ).pipe(Effect.forkChild);
      const resumedSession = yield* resumedAdapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "anthropic:claude-sonnet-5",
        },
        resumeCursor: firstSession.resumeCursor,
      });
      assert.deepEqual(resumedSession.resumeCursor, firstSession.resumeCursor);

      yield* resumedAdapter.sendTurn({
        threadId,
        input: "restore the configured default after resume",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "default",
        },
      });
      yield* Deferred.await(completed);

      const requests = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      const setModelIds = requests
        .split(/\r?\n/u)
        .filter((line) => line.includes('"session/set_model"'))
        .flatMap((line) => line.match(/"modelId":"([^"]+)"/u)?.[1] ?? []);
      assert.deepEqual(setModelIds, ["openai-codex:gpt-5.6-sol"]);
      const [updatedSession] = yield* resumedAdapter.listSessions();
      assert.equal(updatedSession?.model, "default");
      yield* Fiber.interrupt(eventsFiber);
      yield* resumedAdapter.stopSession(threadId);
    }),
  );

  // ProviderService recovery omits `modelSelection` when the persisted binding
  // carries none. That is NOT a request for the sentinel: it must leave the
  // Hermes model alone rather than reset a concrete pin back to the default.
  it.effect("leaves the model untouched when resume carries no model selection", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-resume-without-selection");
      const firstAdapter = yield* makeTestAdapter(
        yield* Effect.promise(() => makeMockHermesWrapper()),
      );
      const firstSession = yield* firstAdapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "anthropic:claude-sonnet-5",
        },
      });
      assert.deepEqual(firstSession.resumeCursor, {
        schemaVersion: 2,
        sessionId: "mock-session-1",
        defaultModelId: "openai-codex:gpt-5.6-sol",
      });
      yield* firstAdapter.stopSession(threadId);

      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-resume-no-selection-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const resumedAdapter = yield* makeTestAdapter(
        yield* Effect.promise(() =>
          makeMockHermesWrapper({
            // Hermes persisted the concrete override this thread was pinned to.
            T3_ACP_INITIAL_MODEL_ID: "anthropic:claude-sonnet-5",
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          }),
        ),
      );
      const resumedSession = yield* resumedAdapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: firstSession.resumeCursor,
      });

      // No selection carried => no needless switch back to the Hermes default,
      // and the effective model is reported rather than collapsed to "default".
      const requests = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      // Guards the notInclude below from passing on an empty/unwritten log.
      assert.include(requests, "session/load");
      assert.notInclude(requests, "session/set_model");
      assert.equal(resumedSession.model, "anthropic:claude-sonnet-5");
      assert.deepEqual(resumedSession.resumeCursor, firstSession.resumeCursor);
      yield* resumedAdapter.stopSession(threadId);
    }),
  );

  it.effect("resumes without a model selection even when no default was restorable", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-resume-no-selection-unknown-default");
      const firstAdapter = yield* makeTestAdapter(
        yield* Effect.promise(() => makeMockHermesWrapper({ T3_ACP_OMIT_SESSION_MODELS: "1" })),
      );
      const firstSession = yield* firstAdapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "default",
        },
      });
      assert.deepEqual(firstSession.resumeCursor, {
        schemaVersion: 2,
        sessionId: "mock-session-1",
        defaultModelId: null,
      });
      yield* firstAdapter.stopSession(threadId);

      // A null default only blocks an explicit sentinel request. Recovery that
      // carries no selection at all must not be hard-failed.
      const resumedAdapter = yield* makeTestAdapter(
        yield* Effect.promise(() => makeMockHermesWrapper({ T3_ACP_OMIT_SESSION_MODELS: "1" })),
      );
      const resumedSession = yield* resumedAdapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: firstSession.resumeCursor,
      });
      assert.equal(resumedSession.model, "default");
      yield* resumedAdapter.stopSession(threadId);
    }),
  );

  it.effect("upgrades a legacy default cursor using the reported setup model", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter(yield* Effect.promise(() => makeMockHermesWrapper()));
      const threadId = ThreadId.make("hermes-legacy-default-resume");
      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "default",
        },
        resumeCursor: { schemaVersion: 1, sessionId: "legacy-session" },
      });
      assert.deepEqual(session.resumeCursor, {
        schemaVersion: 2,
        sessionId: "legacy-session",
        defaultModelId: "openai-codex:gpt-5.6-sol",
      });
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "rejects default resume when neither legacy nor v2 cursors can recover its identity",
    () =>
      Effect.gen(function* () {
        const cases = [
          {
            threadId: ThreadId.make("hermes-legacy-unknown-default"),
            resumeCursor: { schemaVersion: 1, sessionId: "legacy-unknown-session" },
          },
          {
            threadId: ThreadId.make("hermes-v2-unknown-default"),
            resumeCursor: {
              schemaVersion: 2,
              sessionId: "v2-unknown-session",
              defaultModelId: null,
            },
          },
        ] as const;
        yield* Effect.forEach(
          cases,
          ({ threadId, resumeCursor }) =>
            Effect.gen(function* () {
              const adapter = yield* makeTestAdapter(
                yield* Effect.promise(() =>
                  makeMockHermesWrapper({ T3_ACP_OMIT_SESSION_MODELS: "1" }),
                ),
              );
              const error = yield* Effect.flip(
                adapter.startSession({
                  threadId,
                  provider: ProviderDriverKind.make("hermes"),
                  cwd: process.cwd(),
                  runtimeMode: "full-access",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("hermes"),
                    model: "default",
                  },
                  resumeCursor,
                }),
              );
              assert.equal(error._tag, "ProviderAdapterRequestError");
              assert.include(error.message, "did not report a restorable default model");
            }),
          { discard: true },
        );
      }),
  );

  it.effect("rejects a concurrent sentinel steer after Hermes omits its configured model", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-unknown-default-model-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const threadId = ThreadId.make("hermes-unknown-default-model");
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_OMIT_SESSION_MODELS: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            T3_ACP_FIRST_PROMPT_DELAY_MS: "300",
          }),
        ),
      );
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
      ).pipe(Effect.forkChild);
      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "default",
        },
      });
      assert.deepEqual(session.resumeCursor, {
        schemaVersion: 2,
        sessionId: "mock-session-1",
        defaultModelId: null,
      });
      yield* adapter.sendTurn({
        threadId,
        input: "switch to a concrete model",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "anthropic:claude-sonnet-5",
        },
      });
      yield* waitForFileContent(requestLogPath, "switch to a concrete model");

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "restore an unknown default",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("hermes"),
            model: "default",
          },
        }),
      );
      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.include(error.message, "cannot safely restore it");
      const requestsAfterRejectedSteer = yield* Effect.promise(() =>
        NodeFSP.readFile(requestLogPath, "utf8"),
      );
      assert.equal((requestsAfterRejectedSteer.match(/session\/prompt/gu) ?? []).length, 1);
      yield* Deferred.await(completed);
      const [updatedSession] = yield* adapter.listSessions();
      assert.equal(updatedSession?.model, "anthropic:claude-sonnet-5");
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("reports prompt failures through terminal events after sendTurn returns", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-prompt-failure");
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() => makeMockHermesWrapper({ T3_ACP_FAIL_PROMPT: "1" })),
      );
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

      const startedTurn = yield* adapter.sendTurn({
        threadId,
        input: "fail in background",
        attachments: [],
      });
      assert.equal(startedTurn.threadId, threadId);
      const terminal = yield* Deferred.await(completed);
      assert.equal(terminal.payload.state, "failed");
      assert.include(
        terminal.payload.state === "failed" ? terminal.payload.errorMessage : "",
        "Mock prompt failure",
      );
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("retains an early prompt failure until the final steer settles", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-mixed-outcome-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_FAIL_FIRST_PROMPT: "1",
            T3_ACP_FIRST_PROMPT_DELAY_MS: "150",
            T3_ACP_SECOND_PROMPT_DELAY_MS: "300",
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          }),
        ),
      );
      const threadId = ThreadId.make("hermes-mixed-outcome");
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const terminalEvents: Array<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>> = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed"
          ? Effect.sync(() => terminalEvents.push(event)).pipe(
              Effect.andThen(Deferred.succeed(completed, event)),
            )
          : Effect.void,
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const original = yield* adapter.sendTurn({
        threadId,
        input: "fails first",
        attachments: [],
      });
      yield* waitForFileContent(requestLogPath, "fails first");
      const steer = yield* adapter.sendTurn({
        threadId,
        input: "succeeds last",
        attachments: [],
      });
      assert.equal(steer.turnId, original.turnId);
      yield* Effect.sleep("225 millis");
      assert.lengthOf(terminalEvents, 0);
      const terminal = yield* Deferred.await(completed);
      assert.equal(terminal.payload.state, "failed");
      assert.include(
        terminal.payload.state === "failed" ? terminal.payload.errorMessage : "",
        "Mock prompt failure",
      );
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
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
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : event.type === "turn.completed"
            ? Deferred.succeed(completed, undefined)
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
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
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
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "leave a tool open", attachments: [] });
      yield* Deferred.await(completed);
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
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "anthropic:claude-sonnet-5",
        },
      });

      const first = yield* adapter
        .sendTurn({
          threadId,
          input: "first prompt",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("hermes"),
            model: "anthropic:claude-sonnet-5",
          },
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* waitForFileContent(requestLogPath, "first prompt");
      yield* adapter.sendTurn({
        threadId,
        input: "steer prompt",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "default",
        },
      });
      const requestsAfterSteer = yield* waitForFileContent(requestLogPath, "steer prompt");
      assert.equal((requestsAfterSteer.match(/session\/prompt/gu) ?? []).length, 2);
      assert.notInclude(
        events.map((event) => event.type),
        "turn.completed",
      );

      yield* Fiber.join(first);
      yield* Deferred.await(completed);
      assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
      assert.isAtLeast(events.filter((event) => event.type === "content.delta").length, 2);
      const [updatedSession] = yield* adapter.listSessions();
      assert.equal(updatedSession?.model, "default");
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

  it.effect("validates attachments before mutating the Hermes model", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-model-attachment-failure-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() =>
          makeMockHermesWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
        ),
      );
      const threadId = ThreadId.make("hermes-model-attachment-failure");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "default",
        },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "must not switch",
          attachments: [
            {
              type: "image",
              id: "missing-image",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
          modelSelection: {
            instanceId: ProviderInstanceId.make("hermes"),
            model: "anthropic:claude-sonnet-5",
          },
        }),
      );
      assert.equal(error._tag, "ProviderAdapterRequestError");
      const requests = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      assert.notInclude(requests, "session/set_model");
      assert.notInclude(requests, "session/prompt");
      const [session] = yield* adapter.listSessions();
      assert.equal(session?.model, "default");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not launch a prompt when sendTurn is interrupted during model preparation", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-send-interrupt-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const adapter = yield* makeTestAdapter(
        yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            T3_ACP_SET_MODEL_DELAY_MS: "250",
          }),
        ),
      );
      const threadId = ThreadId.make("hermes-send-interrupt");
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
      ).pipe(Effect.forkChild);
      const initialSession = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "must not launch",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("hermes"),
            model: "anthropic:claude-sonnet-5",
          },
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* waitForFileContent(requestLogPath, "session/set_model");
      yield* Fiber.interrupt(sendFiber);
      const requestsAfterInterrupt = yield* Effect.promise(() =>
        NodeFSP.readFile(requestLogPath, "utf8"),
      );
      assert.notInclude(requestsAfterInterrupt, "session/prompt");
      assert.isEmpty(yield* adapter.listSessions());

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: initialSession.resumeCursor,
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "anthropic:claude-sonnet-5",
        },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "restore default after interrupted recovery",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "default",
        },
      });
      yield* Deferred.await(completed);
      const requests = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      const setModelIds = requests
        .split(/\r?\n/u)
        .filter((line) => line.includes('"session/set_model"'))
        .flatMap((line) => line.match(/"modelId":"([^"]+)"/u)?.[1] ?? []);
      assert.deepEqual(setModelIds.slice(-2), [
        "anthropic:claude-sonnet-5",
        "openai-codex:gpt-5.6-sol",
      ]);
      const [restoredSession] = yield* adapter.listSessions();
      assert.equal(restoredSession?.model, "default");
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
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
      yield* waitForFileContent(requestLogPath, '"text":"hang"');
      const startedTurn = yield* Fiber.join(send);
      assert.equal(startedTurn.threadId, threadId);
      yield* adapter.interruptTurn(threadId);
      assert.equal((yield* Deferred.await(completed)).payload.state, "cancelled");
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
