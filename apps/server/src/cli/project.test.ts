import { assert, it } from "@effect/vitest";

import { EnvironmentHttpConflictError, EnvironmentInternalError } from "@t3tools/contracts";

import { projectCommandErrorFromLiveServerRequest } from "./project.ts";
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
