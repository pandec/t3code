import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadArchiveScheduler from "../../../orchestration-v2/ThreadArchiveScheduler.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ArchiveToolkitHandlersLive } from "./handlers.ts";
import { ArchiveToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-archive-tools");
const archivedAt = DateTime.makeUnsafe("2026-10-04T10:00:00.000Z");
const request = {
  requestId: CommandId.make("archive-request"),
  runId: null,
  worktreePath: null,
  requestedAt: "2026-10-04T09:59:00.000Z",
  status: "completed" as const,
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
  scheduled: Array<{ readonly afterTurn: boolean; readonly removeWorktree: boolean | undefined }>,
  options: {
    readonly shell?: "missing" | "deleted" | undefined;
    readonly serviceCalls?: Array<string>;
  } = {},
) =>
  McpServer.toolkit(ArchiveToolkit).pipe(
    Layer.provide(ArchiveToolkitHandlersLive),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        // Archived on purpose: status must stay readable after the archive ran.
        getThreadShell: () =>
          Effect.succeed(
            options.shell === "missing"
              ? null
              : ({
                  id: threadId,
                  providerInstanceId: ProviderInstanceId.make(owner),
                  archivedAt,
                  deletedAt: options.shell === "deleted" ? archivedAt : null,
                } as unknown as OrchestrationV2ThreadShell),
          ),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ThreadArchiveScheduler.ThreadArchiveScheduler)({
        schedule: (input) => {
          options.serviceCalls?.push("schedule");
          scheduled.push({ afterTurn: input.afterTurn, removeWorktree: input.removeWorktree });
          return Effect.succeed({ archivedAt: null, request: { ...request, status: "pending" } });
        },
        status: () => {
          options.serviceCalls?.push("status");
          return Effect.succeed({ archivedAt, request });
        },
        cancel: () => {
          options.serviceCalls?.push("cancel");
          return Effect.succeed({ archivedAt, request });
        },
      }),
    ),
  );

const call = (name: string, args: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name, arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-archive-tools"),
        requestNamespace: "provider-session-archive-tools",
        thread: {
          threadId,
          providerSessionId: "provider-session-archive-tools",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"] as const),
        issuedAt: 1,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  });

it.effect("schedules after the turn and reports status for an archived thread", () => {
  const scheduled: Array<{
    readonly afterTurn: boolean;
    readonly removeWorktree: boolean | undefined;
  }> = [];
  return Effect.gen(function* () {
    const scheduledResult = yield* call("archive_thread");
    expect(scheduledResult.isError).toBe(false);
    yield* call("archive_thread", { removeWorktree: true });
    expect(scheduled).toEqual([
      { afterTurn: true, removeWorktree: false },
      { afterTurn: true, removeWorktree: true },
    ]);
    const status = yield* call("archive_thread_status");
    expect(status.isError).toBe(false);
    expect(status.structuredContent).toEqual({
      archivedAt: "2026-10-04T10:00:00.000Z",
      request,
    });
  }).pipe(Effect.scoped, Effect.provide(makeLayer("codex", scheduled)));
});

it.effect("rejects a provider that no longer owns the thread", () => {
  const scheduled: Array<{
    readonly afterTurn: boolean;
    readonly removeWorktree: boolean | undefined;
  }> = [];
  return Effect.gen(function* () {
    const result = yield* call("archive_thread");
    expect(declaredFailure(result)).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      code: "parent_not_active",
    });
    expect(scheduled).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(makeLayer("claude", scheduled)));
});

const archiveTools = ["archive_thread", "archive_thread_status", "cancel_thread_archive"] as const;

it.effect.each([
  { owner: "claude", shell: undefined, code: "parent_not_active" },
  { owner: "codex", shell: "missing" as const, code: "thread_not_found" },
  { owner: "codex", shell: "deleted" as const, code: "thread_not_found" },
])(
  "every archive tool refuses a $code caller before reaching the service",
  ({ owner, shell, code }) => {
    const serviceCalls: Array<string> = [];
    return Effect.gen(function* () {
      for (const name of archiveTools) {
        const result = yield* call(name);
        expect(declaredFailure(result)).toMatchObject({ _tag: "OrchestratorMcpFailure", code });
      }
      expect(serviceCalls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(makeLayer(owner, [], { shell, serviceCalls })));
  },
);

// Targeting another thread: status reads any thread, schedule and cancel need
// the caller's live run and a target within the caller's modes.
const targetId = ThreadId.make("thread-archive-target");
const broadId = ThreadId.make("thread-archive-broad");

const makeTargetLayer = (calls: Array<string>, options: { readonly callerLive?: boolean } = {}) => {
  const shell = (id: ThreadId) =>
    ({
      id,
      projectId: ProjectId.make("project-archive-tools"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: id === broadId ? "full-access" : "auto-accept-edits",
      interactionMode: "default",
      activeRunId: id === threadId && options.callerLive === false ? null : RunId.make("run-1"),
      archivedAt: id === targetId ? archivedAt : null,
      deletedAt: null,
    }) as unknown as OrchestrationV2ThreadShell;
  const record = (operation: string) => (id: ThreadId) => {
    calls.push(`${operation}:${id}`);
    return Effect.succeed({ archivedAt: null, request });
  };
  return McpServer.toolkit(ArchiveToolkit).pipe(
    Layer.provide(ArchiveToolkitHandlersLive),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(shell(id)),
        getProjectThreadRecords: (input) =>
          Effect.succeed({ thread: shell(input.threadId) } as never),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ThreadArchiveScheduler.ThreadArchiveScheduler)({
        schedule: (input) => {
          calls.push(`schedule:${input.threadId}:${input.afterTurn}:${input.removeWorktree}`);
          return Effect.succeed({ archivedAt: null, request });
        },
        status: record("status"),
        cancel: (input) => record("cancel")(input.threadId),
      }),
    ),
  );
};

it.effect("schedules, reads, and cancels another thread's archive", () => {
  const calls: Array<string> = [];
  return Effect.gen(function* () {
    for (const [name, args] of [
      ["archive_thread", { threadId: targetId, removeWorktree: true }],
      ["archive_thread_status", { threadId: targetId }],
      ["cancel_thread_archive", { threadId: targetId }],
    ] as const) {
      expect((yield* call(name, args)).isError).toBe(false);
    }
    expect(calls).toEqual([
      `schedule:${targetId}:true:true`,
      `status:${targetId}`,
      `cancel:${targetId}`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(makeTargetLayer(calls)));
});

it.effect("refuses to change a target with broader modes but still reads its status", () => {
  const calls: Array<string> = [];
  return Effect.gen(function* () {
    for (const name of ["archive_thread", "cancel_thread_archive"]) {
      expect(declaredFailure(yield* call(name, { threadId: broadId }))).toMatchObject({
        code: "runtime_mode_escalation_denied",
      });
    }
    expect((yield* call("archive_thread_status", { threadId: broadId })).isError).toBe(false);
    expect(calls).toEqual([`status:${broadId}`]);
  }).pipe(Effect.scoped, Effect.provide(makeTargetLayer(calls)));
});

it.effect("refuses to archive another thread once the caller's run ended", () => {
  const calls: Array<string> = [];
  return Effect.gen(function* () {
    expect(declaredFailure(yield* call("archive_thread", { threadId: targetId }))).toMatchObject({
      code: "parent_not_active",
    });
    expect(calls).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(makeTargetLayer(calls, { callerLive: false })));
});
