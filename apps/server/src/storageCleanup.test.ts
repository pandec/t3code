import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import {
  readStorageCleanupThreads,
  storageCleanupActivityAt,
  storageCleanupPullRequestMerged,
  storageCleanupThreadIdle,
  storageCleanupWorktreeInUse,
} from "./storageCleanup.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS, [])).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS, [])).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS, [])).toBe(false);
    },
  );

  it.each(["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"] as const)(
    "allows cleanup once its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS, [])).toBe(true);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while background work is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingBackgroundTasks: [{ taskId: "task-1", kind: "command" }],
          },
          NOW_MS,
          [],
        ),
      ).toBe(false);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while a runtime request is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-1"),
              kind: "command",
              createdAt: at(0),
            },
          },
          NOW_MS,
          [],
        ),
      ).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS, []),
    ).toBe(false);
  });

  it("retains an interrupted thread whose queue Stop held", () => {
    // The shell presents the interrupted run; the held queued run stays pending.
    expect(
      storageCleanupThreadIdle(candidateWithStatus("interrupted"), NOW_MS, [
        { status: "interrupted" },
        { status: "queued" },
      ]),
    ).toBe(false);
    expect(
      storageCleanupThreadIdle(candidateWithStatus("interrupted"), NOW_MS, [
        { status: "interrupted" },
      ]),
    ).toBe(true);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS, []),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

describe("V2 storage cleanup live-use protection", () => {
  const candidateId = ThreadId.make("thread-1");
  /** A real checkout plus a symlinked alias, so canonical path handling is exercised. */
  const setup = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const worktreePath = path.join(root, "worktree");
    const alias = path.join(root, "alias");
    yield* fs.makeDirectory(worktreePath);
    yield* fs.symlink(worktreePath, alias);
    const owner = shell({ branch: "feature", worktreePath });
    const inUse = (
      threads: ReadonlyArray<OrchestrationV2ThreadShell>,
      sessionCwds: ReadonlyArray<string> = [],
      id: ThreadId | null = candidateId,
    ) => storageCleanupWorktreeInUse({ worktreePath, candidateId: id, threads, sessionCwds });
    return { root, worktreePath, alias, owner, inUse, path };
  });
  const other = (overrides: Partial<OrchestrationV2ThreadShell>) =>
    shell({ id: ThreadId.make("thread-2"), ...overrides });
  const pendingSwitch = (targetPath: string, status: "pending" | "completed" = "pending") => ({
    requestId: CommandId.make("switch"),
    runId: RunId.make("run"),
    sourceWorktreePath: null,
    sourceBranch: null,
    targetPath,
    requestedAt: "2026-06-10T11:00:00.000Z",
    status,
  });

  effectIt.effect("treats aliases and nested checkouts of another thread as shared", () =>
    Effect.gen(function* () {
      const { worktreePath, alias, owner, inUse, path } = yield* setup;
      assert.isFalse(yield* inUse([owner]));
      assert.isTrue(yield* inUse([owner, other({ worktreePath: alias })]));
      assert.isTrue(yield* inUse([owner, other({ worktreePath: path.join(alias, "nested") })]));
      // A deleted thread's checkout is in use by any remaining owner.
      assert.isTrue(yield* inUse([owner], [], null));
      assert.isFalse(
        yield* inUse([other({ worktreePath: path.join(path.dirname(worktreePath), "sibling") })]),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("keeps a worktree with a pending move into or out of it", () =>
    Effect.gen(function* () {
      const { root, worktreePath, alias, owner, inUse } = yield* setup;
      assert.isTrue(yield* inUse([owner, other({ worktreeSwitch: pendingSwitch(alias) })]));
      assert.isFalse(
        yield* inUse([owner, other({ worktreeSwitch: pendingSwitch(alias, "completed") })]),
      );
      const moveOut = { ...pendingSwitch(root), sourceWorktreePath: worktreePath };
      assert.isTrue(yield* inUse([{ ...owner, worktreeSwitch: moveOut }]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("keeps a worktree whose thread has a pending archive", () =>
    Effect.gen(function* () {
      const { worktreePath, owner, inUse } = yield* setup;
      const archiveRequest = {
        requestId: CommandId.make("archive"),
        runId: null,
        worktreePath,
        removeWorktree: true,
        requestedAt: "2026-06-10T11:00:00.000Z",
        status: "pending" as const,
      };
      assert.isTrue(yield* inUse([{ ...owner, archiveRequest }]));
      assert.isFalse(
        yield* inUse([{ ...owner, archiveRequest: { ...archiveRequest, status: "error" } }]),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("keeps a worktree a live provider session runs in, through an alias", () =>
    Effect.gen(function* () {
      const { alias, owner, inUse, path } = yield* setup;
      assert.isTrue(yield* inUse([owner], [path.join(alias, "packages")]));
      assert.isFalse(yield* inUse([owner], [path.dirname(alias)]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("V2 storage cleanup thread read", () => {
  effectIt.effect("includes archived threads, which archive snapshots list separately", () =>
    Effect.gen(function* () {
      const active = shell({ id: ThreadId.make("active") });
      const archived = shell({ id: ThreadId.make("archived"), archivedAt: at(-DAY_MS) });
      const { threads } = yield* readStorageCleanupThreads().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getShellSnapshot: (options) =>
                Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: 0,
                  threads: options?.location === "archive" ? [] : [active],
                  archivedThreads: options?.location === "archive" ? [archived] : [],
                }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
          ),
        ),
      );
      assert.deepStrictEqual(
        threads.map((thread) => thread.id),
        [active.id, archived.id],
      );
    }),
  );
});

describe("merged pull request cleanup", () => {
  const HEAD_SHA = "a".repeat(40);
  const integrated = {
    branch: "feature",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    integrated: true,
  };
  const squashed = { ...integrated, integrated: false };
  const pullRequest = (
    overrides: Partial<NonNullable<Parameters<typeof storageCleanupPullRequestMerged>[0]>> = {},
  ) => ({
    state: "merged" as const,
    headRef: "feature",
    baseRef: "main",
    headSha: HEAD_SHA,
    ...overrides,
  });

  it("removes a worktree whose head reached the default branch through a merged pull request", () => {
    expect(storageCleanupPullRequestMerged(pullRequest({ headSha: null }), integrated)).toBe(true);
  });

  it("removes a squash-merged worktree when the pull request names its exact head", () => {
    expect(storageCleanupPullRequestMerged(pullRequest(), squashed)).toBe(true);
  });

  it.each([
    ["has a later commit than the merged head", { headSha: "c".repeat(40) }],
    ["was merged into a release branch", { baseRef: "release" }],
    ["was merged into its stack parent", { baseRef: "stack-parent" }],
    ["was merged without a reported head commit", { headSha: null }],
    ["belongs to a different branch", { headRef: "other" }],
    ["is still open", { state: "open" }],
    ["was closed without merging", { state: "closed" }],
  ] as const)("keeps a squash worktree whose pull request %s", (_name, overrides) => {
    expect(storageCleanupPullRequestMerged(pullRequest(overrides), squashed)).toBe(false);
  });

  it("keeps a worktree with no pull request, or one that is not merged", () => {
    expect(storageCleanupPullRequestMerged(null, squashed)).toBe(false);
    expect(storageCleanupPullRequestMerged(null, integrated)).toBe(false);
    expect(storageCleanupPullRequestMerged(pullRequest({ state: "open" }), integrated)).toBe(false);
  });
});
