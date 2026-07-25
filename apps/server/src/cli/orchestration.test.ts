import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  causeChainHasSqliteBusy,
  cliLiveServerReadTimeoutsFromMillis,
  CliOrchestrationReadTimeoutError,
  defaultCliLiveServerReadTimeouts,
  resolveCliLiveServerReadTimeouts,
} from "./orchestration.ts";

const runResolveTimeouts = (flagTimeoutMillis: Option.Option<number>) =>
  Effect.runPromise(resolveCliLiveServerReadTimeouts(flagTimeoutMillis));

it("uses phase-specific defaults when no override is given", async () => {
  const timeouts = await runResolveTimeouts(Option.none());

  assert.deepStrictEqual(timeouts, defaultCliLiveServerReadTimeouts);
  assert.strictEqual(Duration.toMillis(timeouts.discovery), 3_000);
  assert.strictEqual(Duration.toMillis(timeouts.read), 10_000);
});

it("applies the flag override to reads and keeps discovery short", async () => {
  const timeouts = await runResolveTimeouts(Option.some(15_000));

  assert.strictEqual(Duration.toMillis(timeouts.read), 15_000);
  assert.strictEqual(Duration.toMillis(timeouts.discovery), 3_000);
});

it("shrinks the discovery timeout when the override is below the discovery default", async () => {
  const timeouts = cliLiveServerReadTimeoutsFromMillis(500);

  assert.strictEqual(Duration.toMillis(timeouts.read), 500);
  assert.strictEqual(Duration.toMillis(timeouts.discovery), 500);
});

it("ignores non-positive overrides", async () => {
  const timeouts = await runResolveTimeouts(Option.some(0));

  assert.deepStrictEqual(timeouts, defaultCliLiveServerReadTimeouts);
});

const withEnv = (env: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));

it("reads the environment override when no flag is given", async () => {
  const timeouts = await Effect.runPromise(
    resolveCliLiveServerReadTimeouts(Option.none()).pipe(
      withEnv({ T3CODE_CLI_TIMEOUT_MS: "12000" }),
    ),
  );

  assert.strictEqual(Duration.toMillis(timeouts.read), 12_000);
  assert.strictEqual(Duration.toMillis(timeouts.discovery), 3_000);
});

it("prefers the flag override over the environment override", async () => {
  const timeouts = await Effect.runPromise(
    resolveCliLiveServerReadTimeouts(Option.some(4_000)).pipe(
      withEnv({ T3CODE_CLI_TIMEOUT_MS: "12000" }),
    ),
  );

  assert.strictEqual(Duration.toMillis(timeouts.read), 4_000);
});

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
