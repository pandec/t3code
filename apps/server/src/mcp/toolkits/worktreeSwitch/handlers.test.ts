import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadWorktreeSwitchScheduler from "../../../orchestration-v2/ThreadWorktreeSwitchScheduler.ts";
import { WorktreeSwitchError } from "../../../orchestration-v2/worktreeSwitch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
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

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const makeLayer = (
  owner: string,
  requested: Array<{ threadId: ThreadId; targetPath: string }>,
  options: {
    readonly shell?: "missing" | "deleted" | undefined;
    readonly serviceCalls?: Array<string>;
    readonly activeRunId?: RunId | null;
  } = {},
) =>
  McpHttpServer.toolkitRegistration(WorktreeSwitchToolkit, WorktreeSwitchToolkitHandlersLive).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed(
            options.shell === "missing"
              ? null
              : ({
                  id: threadId,
                  providerInstanceId: ProviderInstanceId.make(owner),
                  archivedAt: null,
                  activeRunId:
                    options.activeRunId === undefined ? RunId.make("run-1") : options.activeRunId,
                  deletedAt:
                    options.shell === "deleted"
                      ? DateTime.makeUnsafe("2026-10-04T10:00:00.000Z")
                      : null,
                } as unknown as OrchestrationV2ThreadShell),
          ),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler)({
        request: (input) => {
          options.serviceCalls?.push("request");
          requested.push({ threadId: input.threadId, targetPath: input.targetPath });
          return input.targetPath.startsWith("/")
            ? Effect.succeed({ request })
            : Effect.fail(
                new WorktreeSwitchError({
                  message: "Pass an absolute path to an existing worktree.",
                }),
              );
        },
        status: () => {
          options.serviceCalls?.push("status");
          return Effect.succeed({ request });
        },
        cancel: () => {
          options.serviceCalls?.push("cancel");
          return Effect.succeed({ request });
        },
      }),
    ),
  );

const threadCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-worktree-switch-tools"),
  requestNamespace: "provider-session-worktree-switch-tools",
  thread: {
    threadId,
    providerSessionId: "provider-session-worktree-switch-tools",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "worktree"] as const),
  issuedAt: 1,
};

const callAs = (
  scope: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const call = (name: string, args: Record<string, unknown> = {}) => callAs(threadCaller, name, args);

it.effect("requests a switch for the credential's thread and reports failures", () => {
  const requested: Array<{ threadId: ThreadId; targetPath: string }> = [];
  return Effect.gen(function* () {
    const result = yield* call("switch_worktree", { path: "/repo-worktree" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ request });
    expect(requested).toEqual([{ threadId, targetPath: "/repo-worktree" }]);
    const refused = yield* call("switch_worktree", { path: "relative" });
    expect(declaredFailure(refused)).toMatchObject({
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
    expect(declaredFailure(result)).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      code: "parent_not_active",
    });
    expect(requested).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(makeLayer("claude", requested)));
});

const switchTools = [
  ["switch_worktree", { path: "/repo-worktree" }],
  ["worktree_switch_status", {}],
  ["cancel_worktree_switch", {}],
] as const;

it.effect.each([
  { owner: "claude", shell: undefined, code: "parent_not_active" },
  { owner: "codex", shell: "missing" as const, code: "thread_not_found" },
  { owner: "codex", shell: "deleted" as const, code: "thread_not_found" },
])(
  "every switch tool refuses a $code caller before reaching the service",
  ({ owner, shell, code }) => {
    const serviceCalls: Array<string> = [];
    return Effect.gen(function* () {
      for (const [name, args] of switchTools) {
        const result = yield* call(name, args);
        expect(declaredFailure(result)).toMatchObject({ _tag: "OrchestratorMcpFailure", code });
      }
      expect(serviceCalls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(makeLayer(owner, [], { shell, serviceCalls })));
  },
);

it.effect("acts for an owning thread between runs but never for a client outside T3", () => {
  const requested: Array<{ threadId: ThreadId; targetPath: string }> = [];
  return Effect.gen(function* () {
    // Ownership, not a live run: a switch requested as the turn ends still lands.
    const idle = yield* call("switch_worktree", { path: "/repo-worktree" });
    expect(idle.isError).toBe(false);
    expect(requested).toEqual([{ threadId, targetPath: "/repo-worktree" }]);
    const outside: McpInvocationContext.McpInvocationScope = {
      ...threadCaller,
      requestNamespace: "client:session",
      thread: undefined,
      client: { sessionId: "session", label: "Claude Code", access: "full-access" },
    };
    for (const [name, args] of switchTools) {
      const refused = yield* callAs(outside, name, args);
      expect(declaredFailure(refused)).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "thread_credential_required",
      });
    }
    expect(requested).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(makeLayer("codex", requested, { activeRunId: null })));
});
