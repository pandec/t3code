import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { layerTest, ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { makeScratchWorkspace } from "./scratchWorkspace.ts";

const projectId = ProjectId.make("scratch-project");
const createdAt = "2026-10-01T00:00:00.000Z";
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const createCommand = (
  threadId: string,
): Extract<OrchestrationCommand, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(threadId),
  threadId: ThreadId.make(threadId),
  projectId,
  title: "Convert these PNGs",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt,
});

const fixture = (isRepository: boolean) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const scratchRoot = path.join(config.baseDir, "scratch");
    return yield* makeScratchWorkspace.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(GitWorkflowService)({ isRepository: () => Effect.succeed(isRepository) }),
          Layer.mock(ProjectionSnapshotQuery)({
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: projectId,
                  title: "No project",
                  workspaceRoot: scratchRoot,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt,
                  updatedAt: createdAt,
                }),
              ),
          }),
        ),
      ),
    );
  });
const testLayer = layerTest("/tmp", { prefix: "t3-scratch-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("allocates ordinary creates and bootstrapped starts through the same preparation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scratch = yield* fixture(false);
    const ordinary = yield* scratch.prepareCommand(createCommand("a1b2c3d4-first"));
    assert.equal(ordinary.type, "thread.create");
    if (ordinary.type !== "thread.create") return;
    assert.isNotNull(ordinary.worktreePath);
    assert.isTrue(yield* fs.exists(ordinary.worktreePath!));

    const {
      type: _type,
      commandId: _commandId,
      threadId: _threadId,
      ...createThread
    } = createCommand("a1b2c3d4-second");
    const bootstrapped = yield* scratch.prepareCommand({
      type: "thread.turn.start",
      commandId: CommandId.make("turn-command"),
      threadId: ThreadId.make("a1b2c3d4-second"),
      message: {
        messageId: MessageId.make("message"),
        role: "user",
        text: "Convert these PNGs",
        attachments: [],
      },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: { createThread },
      createdAt,
    });
    if (bootstrapped.type !== "thread.turn.start") return assert.fail("Expected turn start");
    const folder = bootstrapped.bootstrap?.createThread?.worktreePath;
    assert.isString(folder);
    assert.notEqual(folder, ordinary.worktreePath);
    assert.equal(path.dirname(folder!), yield* scratch.resolveWorkspaceRoot);
    assert.equal(path.basename(folder!), "2026-10-01-convert-these-pngs-a1b2c3d4second");
    assert.isTrue(yield* fs.exists(folder!));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not allocate inside a repository or replace an explicit folder", () =>
  Effect.gen(function* () {
    const unavailable = yield* fixture(true);
    const original = createCommand("thread-original");
    assert.deepEqual(yield* unavailable.prepareCommand(original), original);
    const available = yield* fixture(false);
    const explicit = { ...original, worktreePath: "/existing/folder" };
    assert.deepEqual(yield* available.prepareCommand(explicit), explicit);
  }).pipe(Effect.provide(testLayer)),
);
