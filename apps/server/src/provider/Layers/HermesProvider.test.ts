// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HermesSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  buildInitialHermesProviderSnapshot,
  checkHermesProviderStatus,
  hermesGatewayStatusIsRunning,
  parseHermesVersionOutput,
} from "./HermesProvider.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeHermesProbeWrapper(input?: {
  readonly gatewayExitCode?: number;
  readonly gatewayOutput?: string;
  readonly failAcp?: boolean;
  readonly emitForeignCommands?: boolean;
  readonly terminalOnlyAuth?: boolean;
}) {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3code-hermes-provider-"),
  );
  const wrapperPath = NodePath.join(directory, "hermes");
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'Hermes Agent v0.19.0 (2026.7.20) · mock'
  exit 0
fi
if [ "$1" = "gateway" ] && [ "$2" = "status" ]; then
  printf '%s\\n' ${JSON.stringify(input?.gatewayOutput ?? "Gateway running")}
  exit ${input?.gatewayExitCode ?? 0}
fi
if [ "$1" = "acp" ]; then
	  ${input?.failAcp ? "exit 9" : ""}
	  export T3_ACP_USE_HERMES_MODES=1
	  export T3_ACP_EMIT_HERMES_AVAILABLE_COMMANDS=1
	  ${input?.emitForeignCommands ? "export T3_ACP_EMIT_HERMES_FOREIGN_AVAILABLE_COMMANDS=1" : ""}
	  ${input?.terminalOnlyAuth ? "export T3_ACP_ADVERTISED_AUTH_METHOD_ID=hermes-setup\n\t  export T3_ACP_ADVERTISED_AUTH_METHOD_TYPE=terminal" : ""}
	  exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}
fi
exit 2
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

describe("Hermes provider probe helpers", () => {
  it("parses only the first Hermes version line", () => {
    expect(parseHermesVersionOutput("Hermes Agent v0.19.0 (date)\nnoise 9.9.9")).toBe("0.19.0");
    expect(parseHermesVersionOutput("Hermes Agent unknown\nv9.9.9")).toBeNull();
  });

  it.each([
    [
      "launchd supervision",
      `Launchd plist: /Users/example/Library/LaunchAgents/ai.hermes.gateway.plist
✓ Service definition matches the current Hermes install
✓ Gateway is supervised by launchd (PID 91722)
  Auto-start at login and auto-restart on crash are available.`,
    ],
    ["detached launchd fallback", "✓ Detached fallback process is running (PID 91722)"],
    ["systemd service", "✓ User gateway service is running"],
    [
      "unsupported-launchd fallback warning",
      `⚠ Gateway is running as a detached fallback process — launchd cannot supervise it
  PID(s): 91722`,
    ],
    [
      "manual process warning",
      `⚠ Gateway process is running for this profile, but the service is not active
  PID(s): 91722`,
    ],
    [
      "registered launchd service with detached process",
      `✓ Gateway service is registered with launchd
{
  "PID" = 0;
}
  Detached gateway process is running (PID 91722)`,
    ],
    [
      "no-service-installed manual run",
      `✓ Gateway is running (PID: 91722, 91723)
  (Running manually, not as a system service)`,
    ],
    [
      "Windows scheduled task",
      `✓ Scheduled Task registered: HermesGateway
✓ Gateway process running (PID: 91722)`,
    ],
  ])("recognizes the %s running marker", (_branch, stdout) => {
    expect(hermesGatewayStatusIsRunning({ code: 0, stdout, stderr: "" })).toBe(true);
  });

  it.each([
    [
      "missing fallback",
      `⚠ Gateway service is registered but launchd is not supervising it
✗ No fallback process is running`,
    ],
    [
      "unloaded launchd service",
      `✗ Gateway service is not loaded
  Note: a detached gateway process is running (PID 91722)`,
    ],
    [
      "unsupervised launchd service without a process",
      "⚠ Gateway service is registered but launchd is not supervising it",
    ],
    [
      "no-service-installed with no process",
      `✗ Gateway is not running

To start:
  hermes gateway run      # Run in foreground`,
    ],
    [
      "Windows task without a process",
      `✓ Scheduled Task registered: HermesGateway
✗ No gateway process detected`,
    ],
  ])("rejects the %s not-running marker", (_branch, stdout) => {
    expect(hermesGatewayStatusIsRunning({ code: 0, stdout, stderr: "" })).toBe(false);
  });

  it("requires exit code zero even with an affirmative marker", () => {
    expect(
      hermesGatewayStatusIsRunning({
        code: 1,
        stdout: "✓ Gateway is supervised by launchd (PID 91722)",
        stderr: "",
      }),
    ).toBe(false);
  });
});

describe("buildInitialHermesProviderSnapshot", () => {
  it.effect("is disabled by default with only the default sentinel model", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(decodeHermesSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    }),
  );

  // Hermes applies `session/set_model` to a live ACP session, so the model
  // picker must stay usable mid-thread.
  it.effect("allows mid-thread model changes", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(decodeHermesSettings({}));
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
    }),
  );
});

it.layer(NodeServices.layer)("checkHermesProviderStatus", (it) => {
  it.effect("discovers composite models and slash commands through one ACP session", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeHermesProbeWrapper({ emitForeignCommands: true }),
      );
      const snapshot = yield* checkHermesProviderStatus(
        decodeHermesSettings({ enabled: true, binaryPath, requireGateway: false }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "default",
        "openai-codex:gpt-5.6-sol",
        "anthropic:claude-sonnet-5",
      ]);
      expect(snapshot.slashCommands).toEqual([
        {
          name: "version",
          description: "Show Hermes version",
          input: { hint: "[--verbose]" },
        },
      ]);
    }).pipe(TestClock.withLive),
  );

  it.effect("returns a warning when the required gateway is not running", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeHermesProbeWrapper({ gatewayExitCode: 1, gatewayOutput: "Gateway stopped" }),
      );
      const snapshot = yield* checkHermesProviderStatus(
        decodeHermesSettings({ enabled: true, binaryPath, requireGateway: true }),
      );
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("gateway is not running");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "default",
        "openai-codex:gpt-5.6-sol",
        "anthropic:claude-sonnet-5",
      ]);
      expect(snapshot.slashCommands).toEqual([
        {
          name: "version",
          description: "Show Hermes version",
          input: { hint: "[--verbose]" },
        },
      ]);
      expect(snapshot.auth.status).toBe("authenticated");
    }).pipe(TestClock.withLive),
  );

  it.effect("keeps fallback models when ACP discovery fails", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeHermesProbeWrapper({ failAcp: true }));
      const snapshot = yield* checkHermesProviderStatus(
        decodeHermesSettings({
          enabled: true,
          binaryPath,
          requireGateway: false,
          customModels: ["custom:hermes-model"],
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "default",
        "custom:hermes-model",
      ]);
    }),
  );

  it.effect("reports terminal-only Hermes authentication as setup-required", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeHermesProbeWrapper({ terminalOnlyAuth: true }),
      );
      const snapshot = yield* checkHermesProviderStatus(
        decodeHermesSettings({ enabled: true, binaryPath, requireGateway: false }),
      );
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("hermes --setup");
    }).pipe(TestClock.withLive),
  );
});
