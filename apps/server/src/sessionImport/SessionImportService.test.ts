import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderSessionRuntime } from "../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { makeSessionImportService } from "./SessionImportService.ts";

const projectId = ProjectId.make("project-1");
const instanceId = ProviderInstanceId.make("claude-main");
const NATIVE_SESSION_ID = "9fc85367-4ed9-4dc7-a44e-bee92408ff84";

interface HarnessOptions {
  readonly dispatchFails?: boolean;
  readonly importedModel?: string | null;
  readonly models?: ReadonlyArray<{ readonly slug: string; readonly isCustom?: boolean }>;
  readonly replaceInstanceDuringRead?: boolean;
  readonly sessionName?: string | null;
  readonly yieldBeforeRead?: boolean;
}

interface HarnessState {
  readonly bindings: Map<string, ProviderSessionRuntime>;
  readonly dispatched: Array<{ type: string; [key: string]: unknown }>;
  readonly callOrder: Array<"binding-upsert" | "dispatch" | "binding-delete">;
}

const makeHarness = (options?: HarnessOptions) => {
  const state: HarnessState = {
    bindings: new Map(),
    dispatched: [],
    callOrder: [],
  };

  let currentInstance: ProviderInstance;
  const instance = {
    instanceId,
    driverKind: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed({
        models: options?.models ?? [{ slug: "claude-sonnet-5" }, { slug: "claude-opus-4-8" }],
      }),
    },
    adapter: {
      listImportableSessions: () =>
        Effect.succeed([
          {
            nativeSessionId: NATIVE_SESSION_ID,
            name: options?.sessionName ?? null,
            preview: "Remember the codeword PINEAPPLE-42.",
            messageCount: 2,
            updatedAt: "2026-07-16T10:00:01.000Z",
          },
        ]),
      readImportableSession: (input: { destinationThreadId: ThreadId }) =>
        Effect.gen(function* () {
          if (options?.yieldBeforeRead === true) {
            yield* Effect.yieldNow;
          }
          if (options?.replaceInstanceDuringRead === true) {
            currentInstance = { ...instance, enabled: false } as unknown as ProviderInstance;
          }
          return {
            nativeSessionId: NATIVE_SESSION_ID,
            nativeCwd: "/private/tmp",
            name: options?.sessionName ?? null,
            messages: [
              {
                role: "user" as const,
                text: "Remember the codeword PINEAPPLE-42.",
                createdAt: "2026-07-16T10:00:00.000Z",
              },
              { role: "assistant" as const, text: "OK", createdAt: "2026-07-16T10:00:01.000Z" },
            ],
            model: options?.importedModel === undefined ? "claude-sonnet-5" : options.importedModel,
            resumeCursor: {
              threadId: input.destinationThreadId,
              resume: NATIVE_SESSION_ID,
              turnCount: 1,
            },
          };
        }),
    },
  } as unknown as ProviderInstance;
  currentInstance = instance;

  const registryLayer = Layer.mock(ProviderInstanceRegistry)({
    getInstance: (id) => Effect.succeed(id === instanceId ? currentInstance : undefined),
    listInstances: Effect.sync(() => [currentInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
  });

  const projectLayer = Layer.mock(ProjectionProjectRepository)({
    getById: () =>
      Effect.succeed(
        Option.some({
          projectId,
          title: "Project",
          workspaceRoot: "/tmp",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
        }),
      ),
  });

  const runtimeRepositoryLayer = Layer.mock(ProviderSessionRuntimeRepository)({
    list: () => Effect.succeed([...state.bindings.values()]),
    deleteByThreadId: ({ threadId }) =>
      Effect.sync(() => {
        state.callOrder.push("binding-delete");
        state.bindings.delete(threadId);
      }),
  });

  const directoryLayer = Layer.mock(ProviderSessionDirectory)({
    upsert: (binding) =>
      Effect.sync(() => {
        state.callOrder.push("binding-upsert");
        state.bindings.set(binding.threadId, {
          threadId: binding.threadId,
          providerName: binding.provider,
          providerInstanceId: binding.providerInstanceId ?? null,
          adapterKey: binding.adapterKey ?? binding.provider,
          runtimeMode: binding.runtimeMode ?? "full-access",
          status: binding.status ?? "running",
          lastSeenAt: "2026-07-16T10:00:00.000Z",
          resumeCursor: binding.resumeCursor ?? null,
          runtimePayload: binding.runtimePayload ?? null,
          revision: 1,
        });
      }),
  });

  const engineLayer = Layer.mock(OrchestrationEngineService)({
    dispatch: (command) => {
      state.callOrder.push("dispatch");
      if (options?.dispatchFails === true) {
        return Effect.die(new Error("dispatch failed"));
      }
      state.dispatched.push(command as unknown as HarnessState["dispatched"][number]);
      return Effect.succeed({ sequence: state.dispatched.length });
    },
  });

  const layer = Layer.mergeAll(
    registryLayer,
    projectLayer,
    runtimeRepositoryLayer,
    directoryLayer,
    engineLayer,
    NodeServices.layer,
  );

  return { state, layer };
};

it.layer(NodeServices.layer)("SessionImportService", (it) => {
  it.effect("imports a session: binding first, then dispatch, with stopped-binding fields", () =>
    Effect.gen(function* () {
      const { state, layer } = makeHarness();
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      const result = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: NATIVE_SESSION_ID,
      });

      expect(state.callOrder).toEqual(["binding-upsert", "dispatch"]);

      const binding = state.bindings.get(result.threadId);
      expect(binding).toBeDefined();
      expect(binding?.status).toBe("stopped");
      expect(binding?.runtimeMode).toBe("full-access");
      expect(binding?.providerInstanceId).toBe(instanceId);
      expect(binding?.resumeCursor).toMatchObject({ resume: NATIVE_SESSION_ID });
      expect(binding?.runtimePayload).toMatchObject({
        modelSelection: { instanceId, model: "claude-sonnet-5" },
        activeTurnId: null,
      });

      const command = state.dispatched[0];
      expect(command).toMatchObject({
        type: "thread.import",
        commandId: `import:${result.threadId}`,
        projectId,
        title: "Remember the codeword PINEAPPLE-42.",
        source: {
          provider: "claudeAgent",
          nativeSessionId: NATIVE_SESSION_ID,
        },
      });
      const messages = (command as unknown as { messages: Array<{ messageId: string }> }).messages;
      expect(messages.map((message) => message.messageId)).toEqual([
        `import:${result.threadId}:00000`,
        `import:${result.threadId}:00001`,
      ]);
    }),
  );

  it.effect("compensates the binding when dispatch fails, allowing a clean retry", () =>
    Effect.gen(function* () {
      const failing = makeHarness({ dispatchFails: true });
      const failingService = yield* makeSessionImportService.pipe(Effect.provide(failing.layer));

      const error = yield* failingService
        .importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID })
        .pipe(Effect.flip);
      expect(error.reason).toBe("import-failed");
      expect(failing.state.callOrder).toEqual(["binding-upsert", "dispatch", "binding-delete"]);
      // No orphan binding left behind: the candidate is visible again.
      expect(failing.state.bindings.size).toBe(0);
      const candidates = yield* failingService.listCandidates({ projectId });
      expect(candidates).toHaveLength(1);
    }),
  );

  it.effect("uses the current provider-assigned session name as the imported title", () =>
    Effect.gen(function* () {
      const { state, layer } = makeHarness({ sessionName: "Payment retry spike" });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      yield* service.importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID });

      expect(state.dispatched[0]).toMatchObject({ title: "Payment retry spike" });
    }),
  );

  it.effect("falls back to the first message when the provider name is blank", () =>
    Effect.gen(function* () {
      const { state, layer } = makeHarness({ sessionName: "   " });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      yield* service.importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID });

      expect(state.dispatched[0]).toMatchObject({
        title: "Remember the codeword PINEAPPLE-42.",
      });
    }),
  );

  it.effect("preserves a long Unicode provider-assigned session name exactly", () =>
    Effect.gen(function* () {
      const sessionName = `${"x".repeat(100)}😀\nsecond line`;
      const { state, layer } = makeHarness({ sessionName });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      yield* service.importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID });

      expect(state.dispatched[0]).toMatchObject({ title: sessionName });
    }),
  );

  it.effect("rejects an import whose native session is already bound", () =>
    Effect.gen(function* () {
      const { state, layer } = makeHarness();
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      yield* service.importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID });
      expect(state.bindings.size).toBe(1);

      const error = yield* service
        .importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID })
        .pipe(Effect.flip);
      expect(error.reason).toBe("already-imported");
      expect(state.bindings.size).toBe(1);

      // And the candidate disappears from the listing.
      const candidates = yield* service.listCandidates({ projectId });
      expect(candidates).toHaveLength(0);
    }),
  );

  it.effect("allows the same native session id from a different provider instance", () =>
    Effect.gen(function* () {
      const { state, layer } = makeHarness();
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      const existing = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: NATIVE_SESSION_ID,
      });
      const existingBinding = state.bindings.get(existing.threadId);
      expect(existingBinding).toBeDefined();
      state.bindings.set(existing.threadId, {
        ...existingBinding!,
        providerInstanceId: ProviderInstanceId.make("claude-secondary"),
      });

      const candidates = yield* service.listCandidates({ projectId });
      expect(candidates).toHaveLength(1);

      const imported = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: NATIVE_SESSION_ID,
      });
      expect(imported.threadId).not.toBe(existing.threadId);
      expect(state.bindings.size).toBe(2);
    }),
  );

  it.effect("serializes concurrent imports of the same native session", () =>
    Effect.gen(function* () {
      const { state, layer } = makeHarness({ yieldBeforeRead: true });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      const results = yield* Effect.all(
        [
          service
            .importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID })
            .pipe(Effect.result),
          service
            .importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );

      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      const failure = results.find((result) => result._tag === "Failure");
      expect(failure?._tag).toBe("Failure");
      if (failure?._tag === "Failure") {
        expect(failure.failure.reason).toBe("already-imported");
      }
      expect(state.bindings.size).toBe(1);
      expect(state.dispatched).toHaveLength(1);
    }),
  );

  it.effect("rejects the import when the provider instance changes during the native read", () =>
    Effect.gen(function* () {
      const { state, layer } = makeHarness({ replaceInstanceDuringRead: true });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      const error = yield* service
        .importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID })
        .pipe(Effect.flip);

      expect(error.reason).toBe("instance-not-found");
      expect(state.bindings.size).toBe(0);
      expect(state.dispatched).toHaveLength(0);
    }),
  );

  it.effect("falls back to the instance default model when the imported model is unknown", () =>
    Effect.gen(function* () {
      const { state, layer } = makeHarness({ importedModel: "claude-legacy-model" });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      yield* service.importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID });
      const command = state.dispatched[0] as unknown as { modelSelection: { model: string } };
      expect(command.modelSelection.model).toBe("claude-sonnet-5");
    }),
  );

  it.effect("prefers an advertised instance model over the driver-wide default", () =>
    Effect.gen(function* () {
      const { state, layer } = makeHarness({
        importedModel: "claude-legacy-model",
        models: [{ slug: "claude-opus-4-8" }],
      });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      yield* service.importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID });
      const command = state.dispatched[0] as unknown as { modelSelection: { model: string } };
      expect(command.modelSelection.model).toBe("claude-opus-4-8");
    }),
  );

  it.effect("prefers the advertised provider default over an earlier advertised model", () =>
    Effect.gen(function* () {
      const { state, layer } = makeHarness({
        importedModel: "claude-legacy-model",
        models: [{ slug: "claude-fable-5" }, { slug: "claude-sonnet-5" }],
      });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      yield* service.importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID });
      const command = state.dispatched[0] as unknown as { modelSelection: { model: string } };
      expect(command.modelSelection.model).toBe("claude-sonnet-5");
    }),
  );

  it.effect("uses the driver default when the enabled instance snapshot has no models", () =>
    Effect.gen(function* () {
      const { state, layer } = makeHarness({ importedModel: null, models: [] });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      yield* service.importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID });
      const command = state.dispatched[0] as unknown as { modelSelection: { model: string } };
      expect(command.modelSelection.model).toBe("claude-sonnet-5");
    }),
  );
});
