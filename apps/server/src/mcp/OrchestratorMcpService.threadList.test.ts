import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

// Fork: t3_thread_list by worktree path.
const projectA = ProjectId.make("project:list-a");
const projectB = ProjectId.make("project:list-b");

const shell = (
  id: string,
  projectId: ProjectId,
  worktreePath: string | null,
  updatedAt: string,
): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(id),
    projectId,
    title: id,
    createdBy: "user",
    creationSource: "web",
    status: "idle",
    activityRunStatus: null,
    latestRunId: null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    linkedPullRequest: null,
    settledOverride: null,
    settledAt: null,
    lineage: { parentThreadId: null, relationshipToParent: null },
    visibleItemCount: 0,
    worktreePath,
    archivedAt: null,
    createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    updatedAt: DateTime.makeUnsafe(updatedAt),
  }) as unknown as OrchestrationV2ThreadShell;

const threads = [
  shell("thread:a-root", projectA, null, "2026-10-01T01:00:00Z"),
  shell("thread:a-tree", projectA, "/work/trees/feature", "2026-10-01T02:00:00Z"),
  shell("thread:b-tree", projectB, "/work/trees/feature/", "2026-10-01T03:00:00Z"),
  shell("thread:b-other", projectB, "/work/trees/feature-2", "2026-10-01T04:00:00Z"),
];

const layer = OrchestratorMcpService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            // Like the projection store, a project-scoped read returns only that project.
            getShellSnapshot: (options) =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 1,
                threads:
                  options?.projectId === undefined
                    ? threads
                    : threads.filter((thread) => thread.projectId === options.projectId),
                archivedThreads: [],
              }),
          }),
        ),
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      ),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(RemoteDelegation.RemoteDelegation)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      ServerSettings.layerTest(),
    ),
  ),
);

// A client signed in from outside a thread, so no calling thread is loaded.
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:list"),
  requestNamespace: "client:list",
  thread: undefined,
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

it.effect("lists the threads bound to a worktree and reports each one's checkout", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;

    const one = yield* service.listThreads(scope, { projectId: projectA });
    expect(one.threads.map((thread) => [thread.threadId, thread.worktreePath])).toEqual([
      ["thread:a-tree", "/work/trees/feature"],
      ["thread:a-root", null],
    ]);

    // Trailing slashes are ignored on both sides; a prefix is not a match.
    // The filter runs before pagination.
    const bound = yield* service.listThreads(scope, {
      allProjects: true,
      worktreePath: "/work/trees/feature/",
      limit: 1,
    });
    expect(bound.total).toBe(2);
    expect(bound.threads.map((thread) => thread.threadId)).toEqual(["thread:b-tree"]);
    expect(bound.nextCursor).toBe(1);
    const inProject = yield* service.listThreads(scope, {
      projectId: projectA,
      worktreePath: "/work/trees/feature",
    });
    expect(inProject.threads.map((thread) => thread.threadId)).toEqual(["thread:a-tree"]);
  }).pipe(Effect.provide(layer)),
);
