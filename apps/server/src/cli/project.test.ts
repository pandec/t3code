import { assert, it } from "@effect/vitest";

import { EnvironmentHttpConflictError, EnvironmentInternalError } from "@t3tools/contracts";

import { projectCommandErrorFromLiveServerRequest, projectListSummary } from "./project.ts";
import {
  CliOrchestrationConflictError,
  CliOrchestrationDeclaredResponseError,
  CliOrchestrationRequestError,
} from "./orchestration.ts";

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

it("includes the thread env-mode override in project list summaries", () => {
  const shell = {
    id: "project-1",
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: null,
    defaultThreadEnvMode: "worktree",
    scripts: [],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  } as unknown as Parameters<typeof projectListSummary>[0];

  assert.strictEqual(projectListSummary(shell).defaultThreadEnvMode, "worktree");
  assert.isNull(
    projectListSummary({ ...shell, defaultThreadEnvMode: undefined }).defaultThreadEnvMode,
  );
});
