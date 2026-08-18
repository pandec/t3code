import { describe, expect, it } from "@effect/vitest";

import { attributeGatewayUsage } from "./usageGatewayAttribution.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: Date.parse("2026-08-07T04:05:13.944Z"),
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    dedupeKey: null,
    ...overrides,
  };
}

describe("attributeGatewayUsage", () => {
  it("charges a gateway-routed OpenAI model to Codex", () => {
    const attributed = attributeGatewayUsage(record({ model: "gpt-5.6-sol" }));
    expect(attributed.provider).toBe("codex");
    // Nothing but the provider may change: the tokens and their dedupe
    // identity still belong to the record the transcript produced.
    expect(attributed.model).toBe("gpt-5.6-sol");
    expect(attributed.totals).toEqual(record().totals);
  });

  it("tolerates a vendor-prefixed model name", () => {
    expect(attributeGatewayUsage(record({ model: "openai/GPT-5.6-terra" })).provider).toBe("codex");
  });

  it("leaves Claude models on Claude Code", () => {
    const claude = record({ model: "claude-opus-5" });
    expect(attributeGatewayUsage(claude)).toBe(claude);
  });

  it("leaves native Codex records untouched", () => {
    const codex = record({ provider: "codex", model: "gpt-5.5" });
    expect(attributeGatewayUsage(codex)).toBe(codex);
  });
});
