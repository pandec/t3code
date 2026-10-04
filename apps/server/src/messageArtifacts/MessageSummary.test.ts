import { type ModelSelection, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withLowSummaryEffort } from "./MessageSummary.ts";

describe("message summary model selection", () => {
  it("uses the same Codex instance and model with low reasoning effort", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex-work"),
      model: "gpt-5.6-sol",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ],
    };

    expect(withLowSummaryEffort(selection, ProviderDriverKind.make("codex"))).toEqual({
      instanceId: ProviderInstanceId.make("codex-work"),
      model: "gpt-5.6-sol",
      options: [
        { id: "serviceTier", value: "priority" },
        { id: "reasoningEffort", value: "low" },
      ],
    });
  });

  it("uses low effort for Claude without changing its instance or model", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-opus-4-8",
      options: [{ id: "effort", value: "max" }],
    };

    expect(withLowSummaryEffort(selection, ProviderDriverKind.make("claudeAgent"))).toEqual({
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-opus-4-8",
      options: [{ id: "effort", value: "low" }],
    });
  });

  it("leaves providers without a low-effort option unchanged", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("grok-work"),
      model: "auto",
      options: [{ id: "custom", value: true }],
    };

    expect(withLowSummaryEffort(selection, ProviderDriverKind.make("grok"))).toBe(selection);
  });

  it("uses the low OpenCode model variant", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("opencode-work"),
      model: "openai/gpt-5.6-sol",
      options: [{ id: "variant", value: "high" }],
    };

    expect(withLowSummaryEffort(selection, ProviderDriverKind.make("opencode"))).toEqual({
      instanceId: ProviderInstanceId.make("opencode-work"),
      model: "openai/gpt-5.6-sol",
      options: [{ id: "variant", value: "low" }],
    });
  });

  it("uses low reasoning for Cursor", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("cursor-work"),
      model: "auto",
      options: [{ id: "reasoning", value: "xhigh" }],
    };

    expect(withLowSummaryEffort(selection, ProviderDriverKind.make("cursor"))).toEqual({
      instanceId: ProviderInstanceId.make("cursor-work"),
      model: "auto",
      options: [{ id: "reasoning", value: "low" }],
    });
  });
});
