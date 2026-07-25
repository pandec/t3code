import { assert, it } from "@effect/vitest";

import {
  CliOrchestrationOutcomeUnknownError,
  CliOrchestrationReadTimeoutError,
} from "./orchestration.ts";
import { serializeCliError } from "./errorOutput.ts";

it("serializes tagged errors with their code, message, and primitive fields", () => {
  const serialized = serializeCliError(
    new CliOrchestrationReadTimeoutError({
      operation: "callLiveServer",
      phase: "discovery",
      timeoutMillis: 3_000,
    }),
  );

  assert.strictEqual(serialized.code, "CliOrchestrationReadTimeoutError");
  assert.include(serialized.message, "discovery");
  assert.deepStrictEqual(serialized.detail, {
    operation: "callLiveServer",
    phase: "discovery",
    timeoutMillis: 3_000,
  });
  assert.isUndefined(serialized.outcome);
});

it("never serializes the cause chain", () => {
  const serialized = serializeCliError(
    new CliOrchestrationOutcomeUnknownError({
      operation: "dispatchLiveServer",
      cause: new Error("secret token abc123 leaked in a stack trace"),
    }),
  );

  assert.notInclude(JSON.stringify(serialized), "abc123");
});

it("marks a lost acknowledgement as an unknown outcome", () => {
  const serialized = serializeCliError(
    new CliOrchestrationOutcomeUnknownError({
      operation: "dispatchLiveServer",
      cause: new Error("Server acknowledgement timed out."),
    }),
  );

  assert.strictEqual(serialized.code, "CliOrchestrationOutcomeUnknownError");
  assert.strictEqual(serialized.outcome, "unknown");
});

it("serializes plain errors and unknown values", () => {
  assert.deepStrictEqual(serializeCliError(new Error("boom")), {
    code: "Error",
    message: "boom",
  });
  assert.deepStrictEqual(serializeCliError("boom"), {
    code: "UnknownError",
    message: "boom",
  });
});
