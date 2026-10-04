import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShellSnapshot,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  ArchiveWorktreeRemoval,
  layer as archiveWorktreeRemovalLayer,
  WORKTREE_KEPT_DETAIL,
} from "./ArchiveWorktreeRemoval.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("archive-removal");
const projectId = ProjectId.make("archive-removal-project");

interface Fixture {
  repository: string;
  worktreePath: string | null;
  projects: Array<Pick<OrchestrationProjectShell, "id" | "workspaceRoot">>;
  otherThreads: Array<{
    id: ThreadId;
    projectId: ProjectId;
    worktreePath: string | null;
    worktreeSwitch?: { status: "pending"; targetPath: string };
    archived?: boolean;
  }>;
  /** False once a message or unarchive reopened the thread. */
  archived: boolean;
}
const fixture: Fixture = {
  repository: "",
  worktreePath: null,
  projects: [],
  otherThreads: [],
  archived: true,
};

// Thread and project reads come from the fixture; Git, the file system and the
// effect outbox table are real.
const TestLayer = archiveWorktreeRemovalLayer.pipe(
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.sync(
          () =>
            ({
              thread: {
                id: threadId,
                projectId,
                worktreePath: fixture.worktreePath,
                archivedAt: fixture.archived ? "2026-01-01T00:00:00.000Z" : null,
                deletedAt: null,
                archiveRequest: {
                  status: "pending",
                  removeWorktree: true,
                  worktreePath: fixture.worktreePath,
                },
              },
            }) as never,
        ),
      getShellSnapshot: (options) =>
        Effect.sync(
          () =>
            ({
              threads: fixture.otherThreads
                .filter(
                  (thread) => (thread.archived === true) === (options?.location === "archive"),
                )
                .map((thread) => ({ ...thread, deletedAt: null })),
            }) as unknown as OrchestrationV2ThreadShellSnapshot,
        ),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: () => Effect.sync(() => fixture.projects as Array<OrchestrationProjectShell>),
      getShell: () =>
        Effect.sync(() =>
          Option.some({
            id: projectId,
            workspaceRoot: fixture.repository,
          } as OrchestrationProjectShell),
        ),
    }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-archive-removal-" })),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "ArchiveWorktreeRemoval.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

/** A repository with one commit and a linked worktree on `branch` (detached when null). */
const setup = (branch: string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-archive-removal-" }),
    );
    const repository = path.join(root, "repo");
    const worktreePath = path.join(root, "worktree");
    yield* fs.makeDirectory(repository);
    yield* git(repository, ["init"]);
    yield* git(repository, ["config", "user.email", "test@test.com"]);
    yield* git(repository, ["config", "user.name", "Test"]);
    yield* fs.writeFileString(path.join(repository, "README.md"), "# test\n");
    yield* git(repository, ["add", "."]);
    yield* git(repository, ["commit", "-m", "initial"]);
    yield* git(
      repository,
      branch === null
        ? ["worktree", "add", "--detach", worktreePath]
        : ["worktree", "add", "-b", branch, worktreePath],
    );
    fixture.repository = repository;
    fixture.worktreePath = worktreePath;
    fixture.projects = [{ id: projectId, workspaceRoot: repository }];
    fixture.otherThreads = [];
    fixture.archived = true;
    yield* (yield* SqlClient.SqlClient)`DELETE FROM orchestration_v2_effect_outbox`;
    return { repository, worktreePath };
  });

/** An archive-queued stop of `stoppedThreadId`'s provider session, in `status`. */
const seedSessionStop = (status: "pending" | "failed", stoppedThreadId: ThreadId = threadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-01-01T00:00:00.000Z";
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox
        (effect_id, command_id, thread_id, effect_type, payload_json, status,
          available_at, created_at, updated_at)
      VALUES (${`effect:archive:detach:${stoppedThreadId}`}, 'archive', ${stoppedThreadId},
        'provider-session.detach', '{}', ${status}, ${now}, ${now}, ${now})
    `;
  });

it.layer(TestLayer)("archive worktree removal", (it) => {
  it.effect("removes a clean, unshared worktree and keeps its branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const removal = yield* ArchiveWorktreeRemoval;
      const { repository, worktreePath } = yield* setup("feature/archive");
      assert.isNull(yield* removal.blocker(threadId));
      assert.isNull(yield* removal.remove({ threadId, worktreePath }));
      assert.isFalse(yield* fs.exists(worktreePath));
      assert.equal(
        yield* git(repository, ["branch", "--list", "feature/archive"]),
        "feature/archive",
      );
      // Already gone: nothing left to remove.
      assert.isNull(yield* removal.remove({ threadId, worktreePath }));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a dirty worktree, though a running turn may still clean it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const removal = yield* ArchiveWorktreeRemoval;
      const { worktreePath } = yield* setup("feature/dirty");
      yield* fs.writeFileString(path.join(worktreePath, "notes.txt"), "draft\n");
      assert.isNull(yield* removal.blocker(threadId));
      assert.equal(yield* removal.remove({ threadId, worktreePath }), WORKTREE_KEPT_DETAIL.dirty);
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses shared, project-owned, detached, and main checkouts", () =>
    Effect.gen(function* () {
      const removal = yield* ArchiveWorktreeRemoval;
      const { repository, worktreePath } = yield* setup("feature/shared");
      fixture.otherThreads = [{ id: ThreadId.make("other-thread"), projectId, worktreePath }];
      assert.equal(yield* removal.blocker(threadId), WORKTREE_KEPT_DETAIL.shared);
      assert.equal(yield* removal.remove({ threadId, worktreePath }), WORKTREE_KEPT_DETAIL.shared);

      fixture.otherThreads = [];
      fixture.projects.push({ id: ProjectId.make("nested-project"), workspaceRoot: worktreePath });
      assert.equal(
        yield* removal.remove({ threadId, worktreePath }),
        WORKTREE_KEPT_DETAIL.projectCheckout,
      );

      fixture.worktreePath = repository;
      assert.equal(
        yield* removal.remove({ threadId, worktreePath: repository }),
        WORKTREE_KEPT_DETAIL.notWorktree,
      );

      const detached = yield* setup(null);
      assert.equal(
        yield* removal.remove({ threadId, worktreePath: detached.worktreePath }),
        WORKTREE_KEPT_DETAIL.detached,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a worktree another thread is switching into, through an alias too", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const removal = yield* ArchiveWorktreeRemoval;
      const { repository, worktreePath } = yield* setup("feature/move-target");
      const alias = path.join(path.dirname(worktreePath), "alias");
      yield* fs.symlink(worktreePath, alias);
      fixture.otherThreads = [
        {
          id: ThreadId.make("moving-thread"),
          projectId,
          worktreePath: repository,
          worktreeSwitch: { status: "pending", targetPath: alias },
        },
      ];
      assert.equal(yield* removal.blocker(threadId), WORKTREE_KEPT_DETAIL.pendingMove);
      assert.equal(
        yield* removal.remove({ threadId, worktreePath }),
        WORKTREE_KEPT_DETAIL.pendingMove,
      );
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the worktree and its sessions once the thread is reopened", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const removal = yield* ArchiveWorktreeRemoval;
      const { worktreePath } = yield* setup("feature/reopened");
      fixture.archived = false;
      assert.equal(
        yield* removal.remove({ threadId, worktreePath }),
        WORKTREE_KEPT_DETAIL.reopened,
      );
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.scoped),
  );

  it.effect("waits for the archive's session stop before removing the worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const removal = yield* ArchiveWorktreeRemoval;
      const { worktreePath } = yield* setup("feature/stopping");
      yield* seedSessionStop("pending");

      const timingOut = yield* Effect.forkChild(removal.remove({ threadId, worktreePath }));
      yield* TestClock.adjust("31 seconds");
      assert.equal(yield* Fiber.join(timingOut), WORKTREE_KEPT_DETAIL.sessionStillStopping);
      assert.isTrue(yield* fs.exists(worktreePath));

      const removing = yield* Effect.forkChild(removal.remove({ threadId, worktreePath }));
      yield* TestClock.adjust("1 second");
      assert.isTrue(yield* fs.exists(worktreePath));
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'`;
      yield* TestClock.adjust("250 millis");
      assert.isNull(yield* Fiber.join(removing));
      assert.isFalse(yield* fs.exists(worktreePath));
    }).pipe(Effect.scoped),
  );

  it.effect("waits for another archived thread's session stop in the same worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const removal = yield* ArchiveWorktreeRemoval;
      const { worktreePath } = yield* setup("feature/shared-archived");
      const sharing = ThreadId.make("archived-sharing-thread");
      fixture.otherThreads = [{ id: sharing, projectId, worktreePath, archived: true }];
      yield* seedSessionStop("pending", sharing);

      const removing = yield* Effect.forkChild(removal.remove({ threadId, worktreePath }));
      yield* TestClock.adjust("31 seconds");
      assert.equal(yield* Fiber.join(removing), WORKTREE_KEPT_DETAIL.sessionStillStopping);
      assert.isTrue(yield* fs.exists(worktreePath));

      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'`;
      assert.isNull(yield* removal.remove({ threadId, worktreePath }));
      assert.isFalse(yield* fs.exists(worktreePath));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the worktree when the archive's session stop failed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const removal = yield* ArchiveWorktreeRemoval;
      const { worktreePath } = yield* setup("feature/stop-failed");
      yield* seedSessionStop("failed");
      assert.equal(
        yield* removal.remove({ threadId, worktreePath }),
        WORKTREE_KEPT_DETAIL.sessionStopFailed,
      );
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.scoped),
  );

  it.effect("needs a worktree to remove", () =>
    Effect.gen(function* () {
      const removal = yield* ArchiveWorktreeRemoval;
      yield* setup("feature/none");
      fixture.worktreePath = null;
      assert.equal(yield* removal.blocker(threadId), WORKTREE_KEPT_DETAIL.noWorktree);
    }).pipe(Effect.scoped),
  );
});
