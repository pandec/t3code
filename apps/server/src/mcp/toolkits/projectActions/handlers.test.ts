import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectActions from "../../../project/ProjectActions.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as ProjectActionsHandlers from "./handlers.ts";
import { ProjectActionsToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-project-actions");
const projectId = ProjectId.make("project-actions-tools");
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const makeLayer = (
  runtimeMode: RuntimeMode,
  caller: {
    activeRunId: RunId | null;
    /** Completes on each read of a thread shell. */
    readonly read?: Deferred.Deferred<void>;
  } = { activeRunId: RunId.make("run-1") },
) =>
  McpHttpServer.toolkitRegistration(ProjectActionsToolkit, ProjectActionsHandlers.layer).pipe(
    Layer.provide(ProjectActions.layer),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeed(
            Option.some({
              id: projectId,
              title: "Tools",
              workspaceRoot: "/repo",
              scripts: [],
            } as unknown as Project),
          ),
      }),
    ),
    Layer.provide(ServerSettings.layerTest({ projectSettingsFolded: true })),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          (caller.read === undefined ? Effect.void : Deferred.succeed(caller.read, undefined)).pipe(
            Effect.as({
              id: threadId,
              projectId,
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode,
              interactionMode: "default",
              activeRunId: caller.activeRunId,
              archivedAt: null,
              deletedAt: null,
            } as unknown as OrchestrationV2ThreadShell),
          ),
      }),
    ),
    Layer.provideMerge(ThreadCommandExecutor.layer),
  );

const call = (name: string, args: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name, arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-project-actions"),
        requestNamespace: "provider-session-project-actions",
        thread: {
          threadId,
          providerSessionId: "provider-session-project-actions",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"] as const),
        issuedAt: 1,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  });

it.effect("edits the calling thread's project actions as a full-access caller", () =>
  Effect.gen(function* () {
    const created = yield* call("t3_project_actions_upsert", { name: "Test", command: "vp test" });
    expect(created.structuredContent).toMatchObject({
      projectId,
      action: "created",
      projectAction: { id: "test", command: "vp test" },
    });
    const listed = yield* call("t3_project_actions_list");
    expect(listed.structuredContent).toMatchObject({
      projectId,
      title: "Tools",
      actions: [{ id: "test" }],
    });
    expect(
      declaredFailure(yield* call("t3_project_actions_remove", { actionId: "lint" })),
    ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("'lint'") });
    expect(
      (yield* call("t3_project_actions_remove", { actionId: "test" })).structuredContent,
    ).toEqual({ projectId, action: "removed", actionId: "test" });
  }).pipe(Effect.scoped, Effect.provide(makeLayer("full-access"))),
);

it.effect("lets a narrower caller list but not change actions", () =>
  Effect.gen(function* () {
    expect((yield* call("t3_project_actions_list")).isError).toBe(false);
    expect(
      declaredFailure(yield* call("t3_project_actions_upsert", { name: "Test", command: "x" })),
    ).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.scoped, Effect.provide(makeLayer("auto-accept-edits"))),
);

it.effect("refuses an edit when the caller's turn ends while it waits for its lock", () => {
  const caller = {
    activeRunId: RunId.make("run-1") as RunId | null,
    read: Deferred.makeUnsafe<void>(),
  };
  return Effect.gen(function* () {
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    // A turn-completion command holds the caller's lock.
    const holder = yield* executor
      .withLock(
        threadId,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(held);
    const upsert = yield* call("t3_project_actions_upsert", { name: "Test", command: "x" }).pipe(
      Effect.forkChild,
    );
    // The edit passed its first check and waits for the lock; the turn then ends.
    yield* Deferred.await(caller.read);
    caller.activeRunId = null;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    expect(declaredFailure(yield* Fiber.join(upsert))).toMatchObject({
      code: "parent_not_active",
    });
    caller.activeRunId = RunId.make("run-2");
    expect((yield* call("t3_project_actions_list")).structuredContent).toMatchObject({
      actions: [],
    });
  }).pipe(Effect.scoped, Effect.provide(makeLayer("full-access", caller)));
});
