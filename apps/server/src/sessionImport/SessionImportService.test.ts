// @effect-diagnostics nodeBuiltinImport:off - focused integration tests create real git worktrees.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  THREAD_IMPORT_MAX_MESSAGES,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
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
  readonly additionalInstances?: ReadonlyArray<ProviderInstance>;
  readonly bindingStarted?: Deferred.Deferred<void>;
  readonly dispatchStarted?: Deferred.Deferred<void>;
  readonly dispatchFails?: boolean;
  readonly historyMessages?: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly createdAt: string;
  }>;
  readonly importedModel?: string | null;
  readonly listedSessionName?: string | null;
  readonly metaUpdateFails?: boolean;
  readonly models?: ReadonlyArray<{
    readonly slug: string;
    readonly name?: string;
    readonly isCustom?: boolean;
    readonly capabilities?: {
      readonly optionDescriptors?: ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly type: "select";
        readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
      }>;
    } | null;
  }>;
  readonly workspaceRoot?: string;
  readonly replaceInstanceDuringRead?: boolean;
  readonly releaseBinding?: Deferred.Deferred<void>;
  readonly releaseDispatch?: Deferred.Deferred<void>;
  readonly sessionName?: string | null;
  readonly yieldBeforeRead?: boolean;
}

interface HarnessState {
  readonly bindings: Map<string, ProviderSessionRuntime>;
  readonly dispatched: Array<{ type: string; [key: string]: unknown }>;
  readonly callOrder: Array<"binding-upsert" | "dispatch" | "binding-delete">;
  readonly listCwds: Array<string>;
  readonly readCwds: Array<string>;
}

const makeHarness = (options?: HarnessOptions) => {
  const state: HarnessState = {
    bindings: new Map(),
    dispatched: [],
    callOrder: [],
    listCwds: [],
    readCwds: [],
  };

  let currentInstance: ProviderInstance;
  const instance = {
    instanceId,
    driverKind: ProviderDriverKind.make("claudeAgent"),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("claudeAgent"),
      continuationKey: "claude:home:/tmp/.claude",
    },
    displayName: "Claude",
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed({
        models: options?.models ?? [{ slug: "claude-sonnet-5" }, { slug: "claude-opus-4-8" }],
      }),
    },
    adapter: {
      listImportableSessions: (input: { cwd: string }) =>
        Effect.sync(() => {
          state.listCwds.push(input.cwd);
          return [
            {
              nativeSessionId: NATIVE_SESSION_ID,
              name: options?.listedSessionName ?? options?.sessionName ?? null,
              preview: "Remember the codeword PINEAPPLE-42.",
              messageCount: 2,
              updatedAt: "2026-07-16T10:00:01.000Z",
            },
          ];
        }),
      readImportableSession: (input: { destinationThreadId: ThreadId; cwd: string }) =>
        Effect.gen(function* () {
          state.readCwds.push(input.cwd);
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
            messages: options?.historyMessages ?? [
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
    getInstance: (id) =>
      Effect.succeed(
        id === instanceId
          ? currentInstance
          : options?.additionalInstances?.find((candidate) => candidate.instanceId === id),
      ),
    listInstances: Effect.sync(() => [currentInstance, ...(options?.additionalInstances ?? [])]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
  });

  const projectLayer = Layer.mock(ProjectionProjectRepository)({
    getById: () =>
      Effect.succeed(
        Option.some({
          projectId,
          title: "Project",
          workspaceRoot: options?.workspaceRoot ?? "/tmp",
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
      Effect.gen(function* () {
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
        if (options?.bindingStarted) {
          yield* Deferred.succeed(options.bindingStarted, undefined);
        }
        if (options?.releaseBinding) {
          yield* Deferred.await(options.releaseBinding);
        }
      }),
    getBinding: (threadId) =>
      Effect.succeed(
        Option.fromNullishOr(state.bindings.get(threadId)).pipe(
          Option.map((binding) => ({
            threadId: binding.threadId,
            provider: ProviderDriverKind.make(binding.providerName),
            ...(binding.providerInstanceId === null
              ? {}
              : { providerInstanceId: binding.providerInstanceId }),
            adapterKey: binding.adapterKey,
            status: binding.status,
            resumeCursor: binding.resumeCursor,
            runtimePayload: binding.runtimePayload,
            runtimeMode: binding.runtimeMode,
            lastSeenAt: binding.lastSeenAt,
            revision: binding.revision,
            providerInstanceIdWasLegacyNull: binding.providerInstanceId === null,
          })),
        ),
      ),
    refreshIfUnchanged: ({ binding, runtimePayloadPatch }) =>
      Effect.sync(() => {
        const current = state.bindings.get(binding.threadId);
        if (current === undefined || current.revision !== binding.revision) return false;
        const currentPayload =
          current.runtimePayload !== null &&
          typeof current.runtimePayload === "object" &&
          !Array.isArray(current.runtimePayload)
            ? current.runtimePayload
            : {};
        const patch =
          runtimePayloadPatch !== null &&
          typeof runtimePayloadPatch === "object" &&
          !Array.isArray(runtimePayloadPatch)
            ? runtimePayloadPatch
            : {};
        state.bindings.set(binding.threadId, {
          ...current,
          runtimePayload: { ...currentPayload, ...patch },
          revision: current.revision + 1,
        });
        return true;
      }),
  });

  const engineLayer = Layer.mock(OrchestrationEngineService)({
    dispatch: (command) => {
      state.callOrder.push("dispatch");
      return Effect.gen(function* () {
        if (options?.dispatchStarted) {
          yield* Deferred.succeed(options.dispatchStarted, undefined);
        }
        if (options?.releaseDispatch) {
          yield* Deferred.await(options.releaseDispatch);
        }
        if (
          options?.dispatchFails === true ||
          (options?.metaUpdateFails === true && command.type === "thread.meta.update")
        ) {
          return yield* Effect.die(new Error("dispatch failed"));
        }
        state.dispatched.push(command as unknown as HarnessState["dispatched"][number]);
        return { sequence: state.dispatched.length };
      });
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

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.sync(() =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

const makeGitWorktree = Effect.fn("makeGitWorktree")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const container = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-session-import-git-",
  });
  const root = NodePath.join(container, "repo");
  yield* fileSystem.makeDirectory(root);
  yield* runGit(root, ["init", "-b", "main"]);
  yield* runGit(root, ["config", "user.email", "test@example.com"]);
  yield* runGit(root, ["config", "user.name", "T3 Test"]);
  yield* fileSystem.writeFileString(NodePath.join(root, "README.md"), "test\n");
  yield* runGit(root, ["add", "README.md"]);
  yield* runGit(root, ["commit", "-m", "initial"]);
  yield* runGit(root, ["branch", "feature/session-import"]);
  const worktreePath = NodePath.join(container, "worktree");
  yield* runGit(root, ["worktree", "add", worktreePath, "feature/session-import"]);
  return { root, worktreePath };
});

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
        continuationKey: "claude:home:/tmp/.claude",
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

  it.effect("does not compensate a queued import when its caller is interrupted", () =>
    Effect.gen(function* () {
      const dispatchStarted = yield* Deferred.make<void>();
      const releaseDispatch = yield* Deferred.make<void>();
      const { state, layer } = makeHarness({ dispatchStarted, releaseDispatch });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      const fiber = yield* service
        .importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(dispatchStarted);

      fiber.interruptUnsafe();
      expect(state.bindings.size).toBe(1);
      yield* Deferred.succeed(releaseDispatch, undefined);
      yield* Fiber.await(fiber);

      expect(state.dispatched).toHaveLength(1);
      expect(state.callOrder).toEqual(["binding-upsert", "dispatch"]);
      expect(state.bindings.size).toBe(1);
    }),
  );

  it.effect("finishes dispatch when interrupted after binding persistence", () =>
    Effect.gen(function* () {
      const bindingStarted = yield* Deferred.make<void>();
      const releaseBinding = yield* Deferred.make<void>();
      const { state, layer } = makeHarness({ bindingStarted, releaseBinding });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      const fiber = yield* service
        .importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(bindingStarted);

      fiber.interruptUnsafe();
      yield* Deferred.succeed(releaseBinding, undefined);
      yield* Fiber.await(fiber);

      expect(state.dispatched).toHaveLength(1);
      expect(state.callOrder).toEqual(["binding-upsert", "dispatch"]);
      expect(state.bindings.size).toBe(1);
    }),
  );

  it.effect("compensates when an interrupted queued dispatch fails", () =>
    Effect.gen(function* () {
      const dispatchStarted = yield* Deferred.make<void>();
      const releaseDispatch = yield* Deferred.make<void>();
      const { state, layer } = makeHarness({
        dispatchFails: true,
        dispatchStarted,
        releaseDispatch,
      });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      const fiber = yield* service
        .importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(dispatchStarted);

      fiber.interruptUnsafe();
      yield* Deferred.succeed(releaseDispatch, undefined);
      yield* Fiber.await(fiber);

      expect(state.callOrder).toEqual(["binding-upsert", "dispatch", "binding-delete"]);
      expect(state.bindings.size).toBe(0);
    }),
  );

  it.effect("uses the current provider-assigned session name as the imported title", () =>
    Effect.gen(function* () {
      const { state, layer } = makeHarness({
        listedSessionName: "Old payment title",
        sessionName: "Payment retry spike",
      });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      yield* service.importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID });

      expect(state.dispatched[0]).toMatchObject({ title: "Payment retry spike" });
    }),
  );

  it.effect("prefers an explicit title over the provider-assigned session name", () =>
    Effect.gen(function* () {
      const { state, layer } = makeHarness({ sessionName: "Payment retry spike" });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: NATIVE_SESSION_ID,
        title: "💡 Carried title",
      });

      expect(state.dispatched[0]).toMatchObject({ title: "💡 Carried title" });
    }),
  );

  it.effect("imports the most recent messages and warns when history exceeds the cap", () =>
    Effect.gen(function* () {
      const overCap = THREAD_IMPORT_MAX_MESSAGES + 5;
      const { state, layer } = makeHarness({
        historyMessages: Array.from({ length: overCap }, (_, index) => ({
          role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
          text: `message ${index}`,
          createdAt: "2026-07-16T10:00:00.000Z",
        })),
      });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      const result = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: NATIVE_SESSION_ID,
      });

      expect(result.warnings).toMatchObject([{ code: "history-truncated" }]);
      const dispatched = state.dispatched[0] as unknown as {
        messages: ReadonlyArray<{ text: string }>;
      };
      expect(dispatched.messages).toHaveLength(THREAD_IMPORT_MAX_MESSAGES);
      expect(dispatched.messages[0]?.text).toBe("message 5");
      expect(dispatched.messages[THREAD_IMPORT_MAX_MESSAGES - 1]?.text).toBe(
        `message ${overCap - 1}`,
      );
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
      expect(error.existingThreadId).toBe([...state.bindings.keys()][0]);
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

  it.effect("deduplicates native sessions across instances sharing one continuation home", () =>
    Effect.gen(function* () {
      const secondaryInstanceId = ProviderInstanceId.make("claude-secondary");
      const secondary = {
        instanceId: secondaryInstanceId,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("claudeAgent"),
          continuationKey: "claude:home:/tmp/.claude",
        },
        enabled: false,
      } as unknown as ProviderInstance;
      const { state, layer } = makeHarness({ additionalInstances: [secondary] });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      const existing = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: NATIVE_SESSION_ID,
      });
      const existingBinding = state.bindings.get(existing.threadId);
      state.bindings.set(existing.threadId, {
        ...existingBinding!,
        providerInstanceId: secondaryInstanceId,
      });

      expect(yield* service.listCandidates({ projectId })).toHaveLength(0);
      const error = yield* service
        .importSession({ projectId, instanceId, nativeSessionId: NATIVE_SESSION_ID })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        reason: "already-imported",
        existingThreadId: existing.threadId,
      });
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

  it.effect("uses one canonical worktree cwd for listing, reading, binding, and metadata", () =>
    Effect.gen(function* () {
      const { root, worktreePath } = yield* makeGitWorktree();
      const { state, layer } = makeHarness({ workspaceRoot: root });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      yield* service.listCandidates({ projectId, cwd: worktreePath });
      const result = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: NATIVE_SESSION_ID,
        worktree: { branch: "feature/session-import", worktreePath },
      });
      const canonicalWorktree = yield* (yield* FileSystem.FileSystem).realPath(worktreePath);

      expect(state.listCwds).toEqual([canonicalWorktree]);
      expect(state.readCwds).toEqual([canonicalWorktree]);
      expect(state.bindings.get(result.threadId)?.runtimePayload).toMatchObject({
        cwd: canonicalWorktree,
        cwdAuthority: null,
      });
      expect(state.dispatched[1]).toMatchObject({
        type: "thread.meta.update",
        threadId: result.threadId,
        branch: "feature/session-import",
        worktreePath: canonicalWorktree,
      });
    }),
  );

  it.effect("rejects a mismatched or detached worktree before provider reads", () =>
    Effect.gen(function* () {
      const { root, worktreePath } = yield* makeGitWorktree();
      const wrongBranch = makeHarness({ workspaceRoot: root });
      const wrongBranchService = yield* makeSessionImportService.pipe(
        Effect.provide(wrongBranch.layer),
      );
      const mismatch = yield* wrongBranchService
        .importSession({
          projectId,
          instanceId,
          nativeSessionId: NATIVE_SESSION_ID,
          worktree: { branch: "main", worktreePath },
        })
        .pipe(Effect.flip);
      expect(mismatch.reason).toBe("invalid-worktree");
      expect(wrongBranch.state.readCwds).toHaveLength(0);

      yield* runGit(worktreePath, ["checkout", "--detach"]);
      const detached = makeHarness({ workspaceRoot: root });
      const detachedService = yield* makeSessionImportService.pipe(Effect.provide(detached.layer));
      const detachedError = yield* detachedService
        .importSession({
          projectId,
          instanceId,
          nativeSessionId: NATIVE_SESSION_ID,
          worktree: { branch: "feature/session-import", worktreePath },
        })
        .pipe(Effect.flip);
      expect(detachedError.reason).toBe("invalid-worktree");
      expect(detached.state.readCwds).toHaveLength(0);
    }),
  );

  it.effect("accepts a strict model override and persists its options", () =>
    Effect.gen(function* () {
      const models = [
        {
          slug: "claude-sonnet-5",
          name: "Sonnet",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select" as const,
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ];
      const { state, layer } = makeHarness({ models });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: NATIVE_SESSION_ID,
        modelSelection: {
          instanceId,
          model: "claude-sonnet-5",
          options: [{ id: "effort", value: "high" }],
        },
      });
      expect(state.dispatched[0]).toMatchObject({
        modelSelection: {
          instanceId,
          model: "claude-sonnet-5",
          options: [{ id: "effort", value: "high" }],
        },
      });
    }),
  );

  it.effect("rejects invalid model, option, and instance overrides", () =>
    Effect.gen(function* () {
      const models = [
        {
          slug: "claude-sonnet-5",
          name: "Sonnet",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select" as const,
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ];
      const invalidModelHarness = makeHarness({ models });
      const invalidModelService = yield* makeSessionImportService.pipe(
        Effect.provide(invalidModelHarness.layer),
      );
      const invalidModel = yield* invalidModelService
        .importSession({
          projectId,
          instanceId,
          nativeSessionId: NATIVE_SESSION_ID,
          modelSelection: { instanceId, model: "claude-unknown" },
        })
        .pipe(Effect.flip);
      expect(invalidModel.reason).toBe("invalid-model");

      const invalidOptionsHarness = makeHarness({ models });
      const invalidOptionsService = yield* makeSessionImportService.pipe(
        Effect.provide(invalidOptionsHarness.layer),
      );
      const invalidOptions = yield* invalidOptionsService
        .importSession({
          projectId,
          instanceId,
          nativeSessionId: NATIVE_SESSION_ID,
          modelSelection: {
            instanceId,
            model: "claude-sonnet-5",
            options: [{ id: "effort", value: "impossible" }],
          },
        })
        .pipe(Effect.flip);
      expect(invalidOptions.reason).toBe("invalid-options");

      const mismatchedHarness = makeHarness({ models });
      const mismatchedService = yield* makeSessionImportService.pipe(
        Effect.provide(mismatchedHarness.layer),
      );
      const mismatched = yield* mismatchedService
        .importSession({
          projectId,
          instanceId,
          nativeSessionId: NATIVE_SESSION_ID,
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude-other"),
            model: "claude-sonnet-5",
          },
        })
        .pipe(Effect.flip);
      expect(mismatched.reason).toBe("invalid-options");
    }),
  );

  it.effect("returns a warning when worktree metadata update fails after import", () =>
    Effect.gen(function* () {
      const { root, worktreePath } = yield* makeGitWorktree();
      const { state, layer } = makeHarness({ workspaceRoot: root, metaUpdateFails: true });
      const service = yield* makeSessionImportService.pipe(Effect.provide(layer));

      const result = yield* service.importSession({
        projectId,
        instanceId,
        nativeSessionId: NATIVE_SESSION_ID,
        worktree: { branch: "feature/session-import", worktreePath },
      });

      expect(result.warnings).toEqual([
        {
          code: "meta-update-failed",
          message: `Imported thread ${result.threadId}, but failed to attach worktree metadata.`,
        },
      ]);
      expect(state.bindings.has(result.threadId)).toBe(true);
      expect(state.bindings.get(result.threadId)?.runtimePayload).toMatchObject({
        cwdAuthority: "imported-session",
      });
      expect(state.dispatched[0]).toMatchObject({ type: "thread.import" });
    }),
  );
});
