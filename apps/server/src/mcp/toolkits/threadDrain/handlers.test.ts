import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import { ThreadDrainToolkitHandlersLive } from "./handlers.ts";
import { ThreadDrainStatusResult, ThreadDrainToolkit } from "./tools.ts";

const decodeValue = Schema.decodeUnknownEffect(ThreadDrainStatusResult);
const decodeFailure = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestratorMcpFailure));

const callerId = ThreadId.make("thread:drain-caller");
const targetId = ThreadId.make("thread:drain-target");
const otherProject = ProjectId.make("project:drain-other");

interface TargetState {
  readonly archived?: boolean;
  readonly runs?: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "ordinal">>;
  readonly pendingTasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly runActive?: boolean;
}

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

const makeLayer = (target: TargetState | null, scopes: Array<string>) => {
  const thread = (id: ThreadId) =>
    ({
      id,
      projectId: otherProject,
      providerInstanceId: ProviderInstanceId.make("codex"),
      archivedAt:
        id === targetId && target?.archived === true
          ? DateTime.makeUnsafe("2026-10-06T00:00:00Z")
          : null,
      deletedAt: null,
    }) as unknown as OrchestrationV2ThreadShell;
  return McpHttpServer.toolkitRegistration(ThreadDrainToolkit, ThreadDrainToolkitHandlersLive).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(threadId === targetId && target === null ? null : thread(threadId)),
        getProjectThreadRecords: (input) =>
          Effect.succeed({ thread: thread(input.threadId), runs: target?.runs ?? [] } as never),
        getBackgroundWorkDrain: (input) =>
          Effect.sync(() => {
            scopes.push(input.scope);
            const pendingTasks = target?.pendingTasks ?? [];
            return {
              threadId: input.threadId,
              scope: input.scope,
              liveness: pendingTasks.length === 0 ? null : "monitoring",
              runActive: target?.runActive === true,
              pendingTasks,
              drained: target?.runActive !== true && pendingTasks.length === 0,
            };
          }),
      }),
    ),
  );
};

const check = (args: Record<string, unknown> = { threadId: targetId }) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({ name: "t3_thread_drain_status", arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:drain"),
        requestNamespace: "provider-session:drain",
        thread: {
          threadId: callerId,
          providerSessionId: "provider-session:drain",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"] as const),
        issuedAt: 1,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
    const text = result.content[0];
    return result.isError === true && text?.type === "text"
      ? { failure: yield* decodeFailure(text.text).pipe(Effect.orDie) }
      : { value: yield* decodeValue(result.structuredContent).pipe(Effect.orDie) };
  });

const run = (ordinal: number, status: OrchestrationV2Run["status"]) => ({
  id: RunId.make(`run:drain-${ordinal}`),
  ordinal,
  status,
});

it.effect.each([
  {
    name: "a finished archived thread in another project is quiet",
    target: { archived: true, runs: [run(1, "completed")] },
    expected: {
      archived: true,
      quiet: true,
      activeRun: null,
      queuedRunCount: 0,
      backgroundWork: { liveness: null, tasks: [] },
    },
  },
  {
    name: "a foreground run keeps the thread busy",
    target: { runs: [run(1, "completed"), run(2, "waiting")], runActive: true },
    expected: { quiet: false, activeRun: { runId: "run:drain-2", status: "waiting" } },
  },
  {
    name: "a queued run keeps the thread busy",
    target: { runs: [run(1, "completed"), run(2, "queued")] },
    expected: { quiet: false, activeRun: null, queuedRunCount: 1 },
  },
  {
    name: "background work that survives the turn keeps the thread busy",
    target: {
      runs: [run(1, "completed")],
      pendingTasks: [{ taskId: "watch", kind: "monitor", description: "CI" } as const],
    },
    expected: {
      quiet: false,
      backgroundWork: {
        liveness: "monitoring",
        tasks: [{ taskId: "watch", kind: "monitor", description: "CI" }],
      },
    },
  },
])("$name", ({ target, expected }) => {
  const scopes: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* check();
    expect(result.value).toMatchObject({ threadId: targetId, ...expected });
    expect(scopes).toEqual(["all"]);
  }).pipe(Effect.scoped, Effect.provide(makeLayer(target, scopes)));
});

it.effect("defaults to the calling thread and reports a missing thread", () =>
  Effect.gen(function* () {
    expect((yield* check({})).value).toMatchObject({ threadId: callerId, quiet: true });
    expect((yield* check()).failure).toMatchObject({ code: "thread_not_found" });
  }).pipe(Effect.scoped, Effect.provide(makeLayer(null, []))),
);
