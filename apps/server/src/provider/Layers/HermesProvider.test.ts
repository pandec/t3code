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

  it("requires a successful, parseable running gateway status", () => {
    expect(hermesGatewayStatusIsRunning({ code: 0, stdout: "Gateway running", stderr: "" })).toBe(
      true,
    );
    expect(hermesGatewayStatusIsRunning({ code: 0, stdout: "Gateway stopped", stderr: "" })).toBe(
      false,
    );
    expect(
      hermesGatewayStatusIsRunning({ code: 0, stdout: "Gateway is not running", stderr: "" }),
    ).toBe(false);
    expect(hermesGatewayStatusIsRunning({ code: 0, stdout: "Gateway inactive", stderr: "" })).toBe(
      false,
    );
    expect(hermesGatewayStatusIsRunning({ code: 1, stdout: "Gateway running", stderr: "" })).toBe(
      false,
    );
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
});

it.layer(NodeServices.layer)("checkHermesProviderStatus", (it) => {
  it.effect("discovers composite models and slash commands through one ACP session", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeHermesProbeWrapper());
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
    }),
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
    }),
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
});
