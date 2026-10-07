import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type ThreadGroup,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as ThreadGroupsMcpService from "../../ThreadGroupsMcpService.ts";
import { ThreadGroupsToolkitHandlersLive } from "./handlers.ts";
import { ThreadGroupsToolkit, ThreadGroupsToolResult } from "./tools.ts";

const decodeValue = Schema.decodeUnknownEffect(ThreadGroupsToolResult);
const decodeFailure = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestratorMcpFailure));

const projectId = ProjectId.make("project:groups");
const callerId = ThreadId.make("thread:groups-caller");
const targetId = ThreadId.make("thread:groups-target");
const codex = ProviderInstanceId.make("codex");

const seeded: ReadonlyArray<ThreadGroup> = [
  {
    id: "top",
    name: "Top",
    orderKey: "m",
    aboveActive: true,
    revision: "0000000000000005:a",
    deleted: false,
  },
  { id: "gone", name: "Gone", orderKey: "p", revision: "0000000000000005:b", deleted: true },
];

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

const shell = (
  id: ThreadId,
  fields: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell =>
  ({
    id,
    projectId,
    providerInstanceId: codex,
    runtimeMode: "full-access",
    interactionMode: "default",
    activeRunId: RunId.make("run:groups"),
    archivedAt: null,
    deletedAt: null,
    customGroupId: null,
    lineage: { parentThreadId: null, relationshipToParent: null },
    ...fields,
  }) as unknown as OrchestrationV2ThreadShell;

const makeLayer = (options: {
  readonly callerActive?: boolean;
  readonly callerFields?: Partial<OrchestrationV2ThreadShell>;
  readonly shells: Map<ThreadId, OrchestrationV2ThreadShell>;
  readonly dispatched: Array<OrchestrationV2Command>;
}) => {
  const shells = options.shells;
  if (!shells.has(callerId)) {
    shells.set(
      callerId,
      shell(callerId, {
        ...(options.callerActive === false ? { activeRunId: null } : {}),
        ...options.callerFields,
      }),
    );
  }
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.sync(() => shells.get(threadId) ?? null),
    getProjectThreadRecords: (input) =>
      Effect.sync(() => ({ thread: shells.get(input.threadId) }) as never),
    getShellSnapshot: () =>
      Effect.sync(() => ({
        schemaVersion: 1,
        snapshotSequence: 1,
        threads: [...shells.values()],
        archivedThreads: [],
      })),
    dispatch: (command) =>
      Effect.sync(() => {
        options.dispatched.push(command as OrchestrationV2Command);
        if (command.type === "thread.custom-group.set") {
          const target = shells.get(command.threadId);
          if (target !== undefined) {
            shells.set(target.id, { ...target, customGroupId: command.customGroupId });
          }
        }
        return { sequence: options.dispatched.length } as never;
      }),
  });
  const settings = ServerSettings.layerTest({ threadGroups: seeded });
  return McpHttpServer.toolkitRegistration(
    ThreadGroupsToolkit,
    ThreadGroupsToolkitHandlersLive,
  ).pipe(
    Layer.provide(ThreadGroupsMcpService.layer),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(Layer.mergeAll(threads, settings, NodeServices.layer)),
  );
};

const call = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({ name: "t3_thread_groups", arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:groups"),
        requestNamespace: "provider-session:groups",
        thread: {
          threadId: callerId,
          providerSessionId: "provider-session:groups",
          providerInstanceId: codex,
        },
        client: undefined,
        capabilities: new Set(["orchestration"] as const),
        issuedAt: 1,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
    const text = result.content[0];
    // Declared failures come back as isError with the encoded failure as text.
    return result.isError === true && text?.type === "text"
      ? { failure: yield* decodeFailure(text.text).pipe(Effect.orDie) }
      : { value: yield* decodeValue(result.structuredContent).pipe(Effect.orDie) };
  });

it.effect("creates groups at the bottom, reuses exact names, and lists them around Active", () => {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
    [targetId, shell(targetId, { customGroupId: "top" })],
    [
      ThreadId.make("thread:groups-sub"),
      shell(ThreadId.make("thread:groups-sub"), {
        customGroupId: "top",
        lineage: {
          parentThreadId: targetId,
          relationshipToParent: "subagent",
          rootThreadId: targetId,
        },
      }),
    ],
    // Membership of a deleted group reads as Active, like the sidebar.
    [
      ThreadId.make("thread:groups-orphan"),
      shell(ThreadId.make("thread:groups-orphan"), { customGroupId: "gone" }),
    ],
  ]);
  return Effect.gen(function* () {
    const alpha = yield* call({ action: "create", name: "  Alpha " });
    expect(alpha.value).toMatchObject({
      action: "create",
      group: { name: "Alpha" },
      created: true,
    });
    const beta = yield* call({ action: "create", name: "Beta" });
    const again = yield* call({ action: "create", name: "Alpha" });
    expect(again.value).toEqual({ action: "create", group: alpha.value?.group, created: false });

    const settings = yield* ServerSettings.ServerSettingsService;
    const catalog = (yield* settings.getSettings).threadGroups;
    const created = (name: string) => catalog.find((group) => group.name === name)!;
    expect(catalog).toHaveLength(4);
    expect(created("Alpha").orderKey < created("Beta").orderKey).toBe(true);
    expect(created("Alpha").aboveActive).toBeUndefined();
    expect(created("Alpha").revision > "0000000000000005:b").toBe(true);

    const listed = yield* call({ action: "list" });
    expect(listed.value).toEqual({
      action: "list",
      groups: [
        { id: "top", name: "Top", threadCount: 1 },
        { id: null, name: "Active", threadCount: 2 },
        { id: alpha.value?.group?.id, name: "Alpha", threadCount: 0 },
        { id: beta.value?.group?.id, name: "Beta", threadCount: 0 },
      ],
    });
  }).pipe(Effect.scoped, Effect.provide(makeLayer({ shells, dispatched: [] })));
});

it.effect("moves a thread between groups and Active, reporting no-op moves", () => {
  const dispatched: Array<OrchestrationV2Command> = [];
  const shells = new Map([[targetId, shell(targetId, { customGroupId: "top" })]]);
  return Effect.gen(function* () {
    const toActive = yield* call({ action: "move_thread", threadId: targetId, groupId: null });
    expect(toActive.value).toEqual({
      action: "move_thread",
      threadId: targetId,
      group: null,
      previousGroup: { id: "top", name: "Top" },
      changed: true,
    });
    expect(dispatched).toMatchObject([
      { type: "thread.custom-group.set", threadId: targetId, customGroupId: null },
    ]);

    // Omitted threadId moves the calling thread; already there is a no-op.
    const back = yield* call({ action: "move_thread", groupId: "top" });
    expect(back.value).toMatchObject({ threadId: callerId, changed: true });
    const again = yield* call({ action: "move_thread", groupId: "top" });
    expect(again.value).toMatchObject({
      group: { id: "top", name: "Top" },
      previousGroup: { id: "top", name: "Top" },
      changed: false,
    });
    expect(dispatched).toHaveLength(2);

    expect(
      (yield* call({ action: "move_thread", threadId: targetId, groupId: "gone" })).failure,
    ).toMatchObject({ code: "invalid_request" });
    expect((yield* call({ action: "move_thread", threadId: targetId })).failure).toMatchObject({
      code: "invalid_request",
    });
    expect((yield* call({ action: "create" })).failure).toMatchObject({ code: "invalid_request" });
    expect(dispatched).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(makeLayer({ shells, dispatched })));
});

it.effect("needs the caller's live run to create or move, but not to list", () => {
  const dispatched: Array<OrchestrationV2Command> = [];
  const shells = new Map([[targetId, shell(targetId)]]);
  return Effect.gen(function* () {
    expect((yield* call({ action: "list" })).value).toMatchObject({ action: "list" });
    expect((yield* call({ action: "create", name: "Late" })).failure).toMatchObject({
      code: "parent_not_active",
    });
    expect(
      (yield* call({ action: "move_thread", threadId: targetId, groupId: "top" })).failure,
    ).toMatchObject({ code: "parent_not_active" });
    expect(dispatched).toEqual([]);
    const settings = yield* ServerSettings.ServerSettingsService;
    expect((yield* settings.getSettings).threadGroups).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(makeLayer({ shells, dispatched, callerActive: false })));
});

it.effect("refuses group creation to callers below full access", () => {
  const dispatched: Array<OrchestrationV2Command> = [];
  const shells = new Map([[targetId, shell(targetId)]]);
  return Effect.gen(function* () {
    expect((yield* call({ action: "create", name: "Restricted" })).failure).toMatchObject({
      code: "capability_denied",
    });
    expect((yield* call({ action: "list" })).value).toMatchObject({ action: "list" });
    const settings = yield* ServerSettings.ServerSettingsService;
    expect((yield* settings.getSettings).threadGroups).toHaveLength(2);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      makeLayer({ shells, dispatched, callerFields: { runtimeMode: "approval-required" } }),
    ),
  );
});
