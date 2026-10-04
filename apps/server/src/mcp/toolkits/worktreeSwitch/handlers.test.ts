import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadWorktreeSwitchScheduler from "../../../orchestration-v2/ThreadWorktreeSwitchScheduler.ts";
import { WorktreeSwitchError } from "../../../orchestration-v2/worktreeSwitch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { WorktreeSwitchToolkitHandlersLive } from "./handlers.ts";
import { WorktreeSwitchToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-worktree-switch-tools");
const request = {
  requestId: CommandId.make("switch-request"),
  runId: RunId.make("run-1"),
  sourceWorktreePath: null,
  sourceBranch: "main",
  targetPath: "/repo-worktree",
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

const makeLayer = (owner: string, requested: Array<{ threadId: ThreadId; targetPath: string }>) =>
  McpServer.toolkit(WorktreeSwitchToolkit).pipe(
    Layer.provide(WorktreeSwitchToolkitHandlersLive),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            id: threadId,
            providerInstanceId: ProviderInstanceId.make(owner),
            archivedAt: null,
            deletedAt: null,
          } as unknown as OrchestrationV2ThreadShell),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler)({
        request: (input) => {
          requested.push({ threadId: input.threadId, targetPath: input.targetPath });
          return input.targetPath.startsWith("/")
            ? Effect.succeed({ request })
            : Effect.fail(
                new WorktreeSwitchError({
                  message: "Pass an absolute path to an existing worktree.",
                }),
              );
        },
        status: () => Effect.succeed({ request }),
      }),
    ),
  );

const call = (name: string, args: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name, arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-worktree-switch-tools"),
        threadId,
        providerSessionId: "provider-session-worktree-switch-tools",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["orchestration", "worktree"] as const),
        issuedAt: 1,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  });

it.effect("requests a switch for the credential's thread and reports failures", () => {
  const requested: Array<{ threadId: ThreadId; targetPath: string }> = [];
  return Effect.gen(function* () {
    const result = yield* call("switch_worktree", { path: "/repo-worktree" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ request });
    expect(requested).toEqual([{ threadId, targetPath: "/repo-worktree" }]);
    const refused = yield* call("switch_worktree", { path: "relative" });
    expect(refused.structuredContent).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      code: "invalid_request",
      message: "Pass an absolute path to an existing worktree.",
    });
    const status = yield* call("worktree_switch_status");
    expect(status.structuredContent).toEqual({ request });
  }).pipe(Effect.scoped, Effect.provide(makeLayer("codex", requested)));
});

it.effect("rejects a provider that no longer owns the thread", () => {
  const requested: Array<{ threadId: ThreadId; targetPath: string }> = [];
  return Effect.gen(function* () {
    const result = yield* call("switch_worktree", { path: "/repo-worktree" });
    expect(result.structuredContent).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      code: "parent_not_active",
    });
    expect(requested).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(makeLayer("claude", requested)));
});
