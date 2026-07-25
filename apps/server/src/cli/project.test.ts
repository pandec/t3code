import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EnvironmentHttpConflictError, EnvironmentInternalError } from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  projectCommandErrorFromLiveServerRequest,
  requireCurrentOfflineSchema,
} from "./project.ts";
import {
  CliOrchestrationConflictError,
  CliOrchestrationDeclaredResponseError,
  CliOrchestrationReadTimeoutError,
  CliOrchestrationRequestError,
} from "./orchestration.ts";

const fallbackTimeoutError = new CliOrchestrationReadTimeoutError({
  operation: "callLiveServer",
  phase: "discovery",
  timeoutMillis: 3_000,
});

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

it.effect("accepts the read-only fallback when the migration ledger is current", () =>
  Effect.gen(function* () {
    yield* requireCurrentOfflineSchema(fallbackTimeoutError);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("refuses the read-only fallback when the migration ledger is missing or behind", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id > 1`;
    const behindError = yield* requireCurrentOfflineSchema(fallbackTimeoutError).pipe(Effect.flip);
    assert.strictEqual(behindError, fallbackTimeoutError);

    yield* sql`DROP TABLE effect_sql_migrations`;
    const missingError = yield* requireCurrentOfflineSchema(fallbackTimeoutError).pipe(Effect.flip);
    assert.strictEqual(missingError, fallbackTimeoutError);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

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
