import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyHermesAcpModeSelection,
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  resolveHermesAcpModelId,
} from "./HermesAcpSupport.ts";

describe("HermesAcpSupport", () => {
  it("builds the Hermes ACP command and preserves the instance environment", () => {
    expect(
      buildHermesAcpSpawnInput(
        { binaryPath: "/opt/hermes", authMethodId: "openai-codex" },
        "/tmp/project",
        { TEST_VALUE: "yes" },
      ),
    ).toEqual({
      command: "/opt/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { TEST_VALUE: "yes" },
    });
  });

  it("uses default as a no-set_model sentinel and preserves composite ids", () => {
    expect(resolveHermesAcpModelId("default")).toBeUndefined();
    expect(resolveHermesAcpModelId("  ")).toBeUndefined();
    expect(resolveHermesAcpModelId(" openai-codex:gpt-5.6-sol ")).toBe("openai-codex:gpt-5.6-sol");
  });

  it.effect("applies real model ids only when needed", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const runtime = {
        setSessionModel: (modelId: string) =>
          Effect.sync(() => {
            calls.push(modelId);
            return {};
          }),
      };
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "anthropic:claude-sonnet-5",
          requestedModelId: "default",
          mapError: (cause) => cause,
        }),
      ).toBe("anthropic:claude-sonnet-5");
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "anthropic:claude-sonnet-5",
          requestedModelId: "openai-codex:gpt-5.6-sol",
          mapError: (cause) => cause,
        }),
      ).toBe("openai-codex:gpt-5.6-sol");
      expect(calls).toEqual(["openai-codex:gpt-5.6-sol"]);
    }),
  );

  it.effect("authoritatively resets a resumed non-full-access session to default", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const runtime = {
        request: (method: string, payload: unknown) =>
          Effect.sync(() => {
            calls.push({ method, payload });
            return {};
          }),
      };
      const mode = yield* applyHermesAcpModeSelection({
        runtime,
        sessionId: "resumed-session",
        currentModeId: "dont_ask",
        runtimeMode: "approval-required",
        mapError: (cause) => cause,
      });
      expect(mode).toBe("default");
      expect(calls).toEqual([
        {
          method: "session/set_mode",
          payload: { sessionId: "resumed-session", modeId: "default" },
        },
      ]);
    }),
  );
});
