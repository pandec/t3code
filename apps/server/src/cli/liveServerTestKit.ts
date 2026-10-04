// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the Node runtime.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAdministrativeScopes,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as NetService from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";

// Shared harness for CLI tests that run commands against an in-process server.

export const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
export const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(CliRuntimeLayer));

/** Runs a CLI invocation and returns its last stdout line. */
export const captureStdout = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* Command.runWith(cli, { version: "0.0.0" })(args);
    return (
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      ""
    );
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer)));

export const parseJson = <A>(output: string): A => JSON.parse(output) as A;

export const makeConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otelEnvironment: OtelEnvironment.none,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfig.ServerConfig["Service"];
  });

export const makeTestAuthLayer = (subject: string) =>
  Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
    Effect.provideService(httpEffect, EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make(subject),
      subject,
      method: "bearer-access-token",
      scopes: new Set(AuthAdministrativeScopes),
    }),
  );

export const testShellTime = DateTime.makeUnsafe("2026-10-04T10:00:00.000Z");

/** A complete, idle v2 thread shell; tests override what they exercise. */
export const makeTestThreadShell = (
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  createdBy: "user",
  creationSource: "web",
  id,
  projectId: ProjectId.make("project-thread-cli"),
  title: `Thread ${id}`,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: testShellTime,
  updatedAt: testShellTime,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  ...overrides,
});
