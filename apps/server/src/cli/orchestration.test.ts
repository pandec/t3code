import { AuthSessionId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  causeChainHasSqliteBusy,
  cliLiveServerReadTimeoutsFromMillis,
  CliOrchestrationReadTimeoutError,
  defaultCliLiveServerReadTimeouts,
  resolveCliLiveServerReadTimeouts,
  withCliOrchestrationSession,
} from "./orchestration.ts";

it.effect("uses phase-specific defaults when no override is given", () =>
  Effect.gen(function* () {
    const timeouts = yield* resolveCliLiveServerReadTimeouts(Option.none());

    assert.deepStrictEqual(timeouts, defaultCliLiveServerReadTimeouts);
    assert.strictEqual(Duration.toMillis(timeouts.discovery), 3_000);
    assert.strictEqual(Duration.toMillis(timeouts.read), 10_000);
  }),
);

it.effect("applies the flag override to reads and keeps discovery short", () =>
  Effect.gen(function* () {
    const timeouts = yield* resolveCliLiveServerReadTimeouts(Option.some(15_000));

    assert.strictEqual(Duration.toMillis(timeouts.read), 15_000);
    assert.strictEqual(Duration.toMillis(timeouts.discovery), 3_000);
  }),
);

it("shrinks the discovery timeout when the override is below the discovery default", () => {
  const timeouts = cliLiveServerReadTimeoutsFromMillis(500);

  assert.strictEqual(Duration.toMillis(timeouts.read), 500);
  assert.strictEqual(Duration.toMillis(timeouts.discovery), 500);
});

it.effect("ignores non-positive overrides", () =>
  Effect.gen(function* () {
    const timeouts = yield* resolveCliLiveServerReadTimeouts(Option.some(0));

    assert.deepStrictEqual(timeouts, defaultCliLiveServerReadTimeouts);
  }),
);

const withEnv = (env: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));

it.effect("reads the environment override when no flag is given", () =>
  Effect.gen(function* () {
    const timeouts = yield* resolveCliLiveServerReadTimeouts(Option.none()).pipe(
      withEnv({ T3CODE_CLI_TIMEOUT_MS: "12000" }),
    );

    assert.strictEqual(Duration.toMillis(timeouts.read), 12_000);
    assert.strictEqual(Duration.toMillis(timeouts.discovery), 3_000);
  }),
);

it.effect("prefers the flag override over the environment override", () =>
  Effect.gen(function* () {
    const timeouts = yield* resolveCliLiveServerReadTimeouts(Option.some(4_000)).pipe(
      withEnv({ T3CODE_CLI_TIMEOUT_MS: "12000" }),
    );

    assert.strictEqual(Duration.toMillis(timeouts.read), 4_000);
  }),
);

it("names the timed-out phase and the configured timeout in the error", () => {
  const error = new CliOrchestrationReadTimeoutError({
    operation: "callLiveServer",
    phase: "snapshot",
    timeoutMillis: 10_000,
  });

  assert.include(error.message, "snapshot");
  assert.include(error.message, "10000ms");
  assert.include(error.message, "--timeout-ms");
});

it("detects SQLITE_BUSY codes and lock messages through nested cause chains", () => {
  assert.isTrue(causeChainHasSqliteBusy({ code: "SQLITE_BUSY" }));
  assert.isTrue(causeChainHasSqliteBusy(new Error("database is locked")));
  assert.isTrue(
    causeChainHasSqliteBusy({
      cause: { reason: new Error("SqlError: database is locked (5)") },
    }),
  );
  assert.isFalse(causeChainHasSqliteBusy(new Error("no such table: auth_sessions")));
  assert.isFalse(causeChainHasSqliteBusy(null));

  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.isFalse(causeChainHasSqliteBusy(cyclic));
});

const issuedSession = {
  sessionId: AuthSessionId.make("session-cli-retry-test"),
  token: "token-cli-retry-test",
} as EnvironmentAuth.IssuedBearerSession;

class TestSessionError extends Schema.TaggedErrorClass<TestSessionError>()("TestSessionError", {
  code: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

it.effect("retries busy session issue and revoke operations within the configured bound", () =>
  Effect.gen(function* () {
    let issueAttempts = 0;
    let revokeAttempts = 0;
    const busy = new TestSessionError({
      code: "SQLITE_BUSY",
      detail: "database is locked",
    });
    const environmentAuth = {
      issueSession: () =>
        Effect.suspend(() => {
          issueAttempts += 1;
          return issueAttempts < 4 ? Effect.fail(busy) : Effect.succeed(issuedSession);
        }),
      revokeSession: () =>
        Effect.suspend(() => {
          revokeAttempts += 1;
          return revokeAttempts < 4 ? Effect.fail(busy) : Effect.succeed(true);
        }),
    } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

    const result = yield* withCliOrchestrationSession(environmentAuth, "retry test", (token) =>
      Effect.succeed(token),
    );

    assert.strictEqual(result, issuedSession.token);
    assert.strictEqual(issueAttempts, 4);
    assert.strictEqual(revokeAttempts, 4);
  }).pipe(TestClock.withLive),
);

it.effect("does not retry non-busy session issue failures", () =>
  Effect.gen(function* () {
    let issueAttempts = 0;
    const failure = new TestSessionError({
      code: "INVALID_SESSION",
      detail: "invalid session input",
    });
    const environmentAuth = {
      issueSession: () =>
        Effect.suspend(() => {
          issueAttempts += 1;
          return Effect.fail(failure);
        }),
    } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

    const error = yield* withCliOrchestrationSession(
      environmentAuth,
      "non-busy test",
      () => Effect.void,
    ).pipe(Effect.flip);

    assert.strictEqual(error.message, failure.message);
    assert.strictEqual(issueAttempts, 1);
  }),
);

it.effect("releases the issued session after the command body fails", () =>
  Effect.gen(function* () {
    let revokeAttempts = 0;
    const bodyFailure = new TestSessionError({
      code: "COMMAND_FAILED",
      detail: "command failed",
    });
    const environmentAuth = {
      issueSession: () => Effect.succeed(issuedSession),
      revokeSession: () =>
        Effect.sync(() => {
          revokeAttempts += 1;
          return true;
        }),
    } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

    const error = yield* withCliOrchestrationSession(environmentAuth, "release test", () =>
      Effect.fail(bodyFailure),
    ).pipe(Effect.flip);

    assert.strictEqual(error.message, bodyFailure.message);
    assert.strictEqual(revokeAttempts, 1);
  }),
);
