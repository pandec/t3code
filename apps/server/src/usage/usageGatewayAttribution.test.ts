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
  it("charges an OpenAI model in a Claude transcript to Codex", () => {
    const attributed = attributeGatewayUsage(record({ model: "gpt-5.6-sol" }));
    expect(attributed.provider).toBe("codex");
    // Nothing but the provider may change: the tokens and their dedupe
    // identity still belong to the record the transcript produced.
    expect(attributed.model).toBe("gpt-5.6-sol");
    expect(attributed.totals).toEqual(record().totals);
    expect(attributed.dedupeKey).toBe(record().dedupeKey);
  });

  it("charges an Anthropic model in a Codex rollout to Claude Code", () => {
    const attributed = attributeGatewayUsage(record({ provider: "codex", model: "claude-opus-5" }));
    expect(attributed.provider).toBe("claude");
  });

  it("tolerates a vendor-prefixed model name", () => {
    expect(attributeGatewayUsage(record({ model: "openai/GPT-5.6-terra" })).provider).toBe("codex");
  });

  it("leaves a model already on its own provider untouched", () => {
    const claude = record({ model: "claude-opus-5" });
    expect(attributeGatewayUsage(claude)).toBe(claude);
    const codex = record({ provider: "codex", model: "gpt-5.5" });
    expect(attributeGatewayUsage(codex)).toBe(codex);
  });

  it("leaves a model of neither family where it was found", () => {
    const unknown = record({ model: "some-local-model" });
    expect(attributeGatewayUsage(unknown)).toBe(unknown);
  });
});
