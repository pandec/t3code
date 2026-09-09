// @effect-diagnostics nodeBuiltinImport:off - CLI fixtures create and remove real workspace directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import {
  EnvironmentHttpConflictError,
  EnvironmentInternalError,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  CliOrchestrationConflictError,
  CliOrchestrationDeclaredResponseError,
  CliOrchestrationRequestError,
} from "./orchestration.ts";
import { projectCommandErrorFromLiveServerRequest, projectListSummary } from "./project.ts";
import { findActiveProjectTarget, ProjectNotFoundError } from "./projectTarget.ts";

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "orchestration_snapshot_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, CliOrchestrationDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, CliOrchestrationRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});

it("preserves actionable project action conflicts from the live server", () => {
  const cause = new EnvironmentHttpConflictError({
    message: "Project actions changed after they were read. List them and retry.",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, CliOrchestrationConflictError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(
    error.message,
    "Project actions changed after they were read. List them and retry.",
  );
  assert.strictEqual(error.cause, cause);
});

it("includes project settings in project list summaries", () => {
  const shell = {
    id: "project-1",
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: null,
    defaultThreadEnvMode: "worktree",
    autoPull: true,
    scripts: [],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  } as unknown as Parameters<typeof projectListSummary>[0];

  assert.strictEqual(projectListSummary(shell).defaultThreadEnvMode, "worktree");
  assert.isTrue(projectListSummary(shell).autoPull);
  assert.isNull(
    projectListSummary({ ...shell, defaultThreadEnvMode: undefined }).defaultThreadEnvMode,
  );
  assert.isFalse(projectListSummary({ ...shell, autoPull: undefined }).autoPull);
});

it.layer(NodeServices.layer)("project target lookup", (it) => {
  const findTarget = (
    projects: Parameters<typeof findActiveProjectTarget>[0]["projects"],
    identifier: string,
  ) => findActiveProjectTarget({ projects, identifier }).pipe(Effect.provide(WorkspacePaths.layer));

  it.effect("looks up a project by ID after its workspace disappears", () =>
    Effect.gen(function* () {
      const project = {
        id: ProjectId.make("project-missing-by-id"),
        title: "Missing workspace",
        workspaceRoot: "/missing/project-by-id",
      };

      const resolved = yield* findTarget([project], project.id);

      assert.strictEqual(resolved.id, project.id);
      assert.strictEqual(resolved.workspaceRoot, project.workspaceRoot);
    }),
  );

  it.effect("looks up a project by its exact stored path after the workspace disappears", () =>
    Effect.gen(function* () {
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-project-target-missing-"),
      );
      NodeFS.renameSync(workspaceRoot, `${workspaceRoot}-moved`);
      const project = {
        id: ProjectId.make("project-missing-by-path"),
        title: "Moved workspace",
        workspaceRoot,
      };

      const resolved = yield* findTarget([project], workspaceRoot);

      assert.strictEqual(resolved.id, project.id);
      assert.strictEqual(resolved.workspaceRoot, workspaceRoot);
    }),
  );

  it.effect("matches normalized paths for existing workspaces", () =>
    Effect.gen(function* () {
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-project-target-normalized-"),
      );
      const project = {
        id: ProjectId.make("project-normalized-path"),
        title: "Normalized workspace",
        workspaceRoot,
      };

      const resolved = yield* findTarget([project], `${workspaceRoot}${NodePath.sep}.`);

      assert.strictEqual(resolved.id, project.id);
    }),
  );

  it.effect("keeps symlink project records distinct", () =>
    Effect.gen(function* () {
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-project-target-symlink-"),
      );
      const aliasRoot = `${workspaceRoot}-alias`;
      NodeFS.symlinkSync(workspaceRoot, aliasRoot, "dir");
      const original = {
        id: ProjectId.make("project-symlink-original"),
        title: "Original",
        workspaceRoot,
      };
      const alias = {
        id: ProjectId.make("project-symlink-alias"),
        title: "Alias",
        workspaceRoot: aliasRoot,
      };

      const resolvedOriginal = yield* findTarget([original, alias], workspaceRoot);
      const resolvedAlias = yield* findTarget([original, alias], `${aliasRoot}${NodePath.sep}.`);

      assert.strictEqual(resolvedOriginal.id, original.id);
      assert.strictEqual(resolvedAlias.id, alias.id);
    }),
  );

  it.effect("rejects a project identifier from an unrelated server snapshot", () =>
    Effect.gen(function* () {
      const error = yield* findTarget(
        [
          {
            id: ProjectId.make("project-on-selected-server"),
            title: "Selected server project",
            workspaceRoot: "/missing/selected-server-project",
          },
        ],
        "project-from-another-server",
      ).pipe(Effect.flip);

      assert.instanceOf(error, ProjectNotFoundError);
      assert.strictEqual(error.identifier, "project-from-another-server");
      assert.strictEqual(error.activeProjectCount, 1);
    }),
  );
});
