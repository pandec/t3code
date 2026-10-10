import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2Command,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadArchiveScheduler from "../../../orchestration-v2/ThreadArchiveScheduler.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";

const callerId = ThreadId.make("thread:organize-caller");
const targetId = ThreadId.make("thread:organize-target");
const request = {
  requestId: CommandId.make("archive-request"),
  runId: null,
  worktreePath: null,
  requestedAt: "2026-10-04T09:59:00.000Z",
  status: "pending" as const,
};
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

const makeLayer = (
  modes: { readonly caller: RuntimeMode; readonly target: RuntimeMode },
  calls: { scheduled: Array<ThreadId>; dispatched: Array<OrchestrationV2Command> },
) =>
  McpHttpServer.layerThreadToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(NodeCrypto.layer),
    // Registration asks for every service the thread tools declare; these cases call neither.
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(
            liveThreadShell(threadId, {
              runtimeMode: threadId === targetId ? modes.target : modes.caller,
            }),
          ),
        getProjectThreadRecords: (input) =>
          Effect.succeed(idleThreadProjection(liveThreadShell(input.threadId)) as never),
        dispatch: (command) =>
          Effect.sync(() => {
            calls.dispatched.push(command as OrchestrationV2Command);
            return { sequence: 1 } as never;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadArchiveScheduler.ThreadArchiveScheduler)({
        schedule: (input) =>
          Effect.sync(() => {
            calls.scheduled.push(input.threadId);
            expect(input.afterTurn).toBe(true);
            return { archivedAt: null, request };
          }),
      }),
    ),
  );

const organize = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name: "t3_thread_organize", arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:organize"),
        requestNamespace: "provider-session:organize",
        thread: {
          threadId: callerId,
          providerSessionId: "provider-session:organize",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"] as const),
        issuedAt: 1,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  });

it.effect("archives a working thread through the deferred archive, not at once", () => {
  const calls = {
    scheduled: [] as Array<ThreadId>,
    dispatched: [] as Array<OrchestrationV2Command>,
  };
  return Effect.gen(function* () {
    const result = yield* organize({ action: "archive", threadId: targetId });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ archivedAt: null, request });
    expect(calls.scheduled).toEqual([targetId]);
    expect(calls.dispatched).toEqual([]);
    // Unarchive still dispatches directly.
    yield* organize({ action: "unarchive", threadId: targetId });
    expect(calls.dispatched).toMatchObject([{ type: "thread.unarchive", threadId: targetId }]);
  }).pipe(Effect.provide(makeLayer({ caller: "full-access", target: "full-access" }, calls)));
});

it.effect("refuses to archive a thread above the caller's modes", () => {
  const calls = {
    scheduled: [] as Array<ThreadId>,
    dispatched: [] as Array<OrchestrationV2Command>,
  };
  return Effect.gen(function* () {
    const result = yield* organize({ action: "archive", threadId: targetId });
    const text = result.content[0];
    expect(
      result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined,
    ).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(calls.scheduled).toEqual([]);
  }).pipe(Effect.provide(makeLayer({ caller: "auto-accept-edits", target: "full-access" }, calls)));
});
