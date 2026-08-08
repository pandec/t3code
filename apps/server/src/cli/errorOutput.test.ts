import { assert, it } from "@effect/vitest";
import * as CliError from "effect/unstable/cli/CliError";

import {
  CliOrchestrationOutcomeUnknownError,
  CliOrchestrationReadTimeoutError,
  CliOrchestrationWaitOutcomeUnknownError,
} from "./orchestration.ts";
import { isCliJsonOutputRequested, serializeCliError } from "./errorOutput.ts";

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

it("marks a server death during wait as an unknown outcome", () => {
  const serialized = serializeCliError(
    new CliOrchestrationWaitOutcomeUnknownError({
      operation: "waitLiveServer",
      pid: 123,
      cause: new Error("server exited"),
    }),
  );

  assert.strictEqual(serialized.code, "CliOrchestrationWaitOutcomeUnknownError");
  assert.strictEqual(serialized.outcome, "unknown");
  assert.deepStrictEqual(serialized.detail, { operation: "waitLiveServer", pid: 123 });
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

it("unwraps Effect CLI usage errors without serializing the help control envelope", () => {
  const serialized = serializeCliError(
    new CliError.ShowHelp({
      commandPath: ["t3", "status"],
      errors: [
        new CliError.UnrecognizedOption({
          option: "--wat",
          command: ["t3", "status"],
          suggestions: [],
        }),
      ],
    }),
  );

  assert.strictEqual(serialized.code, "UnrecognizedOption");
  assert.include(serialized.message, "--wat");
  assert.deepStrictEqual(serialized.detail, { option: "--wat" });
  assert.notInclude(JSON.stringify(serialized), "commandPath");
});

it("selects JSON mode only for commands, not CLI action flags or trailing operands", () => {
  assert.isTrue(isCliJsonOutputRequested(["status", "--json"]));
  assert.isFalse(isCliJsonOutputRequested(["status", "--json", "--help"]));
  assert.isFalse(isCliJsonOutputRequested(["--version", "--json"]));
  assert.isFalse(isCliJsonOutputRequested(["thread", "send", "--", "--json"]));
});
