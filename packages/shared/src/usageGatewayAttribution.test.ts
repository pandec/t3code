import type { UsageBucket, UsageDay } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { attributeGatewayBucket } from "./usageGatewayAttribution.ts";

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 2,
    costSource: "modelPriced",
    records: 5,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

describe("attributeGatewayBucket", () => {
  it("credits an OpenAI model scanned as Claude to Codex", () => {
    const attributed = attributeGatewayBucket(bucket({ model: "gpt-5.6-sol" }));
    expect(attributed.provider).toBe("codex");
    // Only the provider may change; the tokens and cost are the scan's.
    expect(attributed.model).toBe("gpt-5.6-sol");
    expect(attributed.costUsd).toBe(10);
    expect(attributed.totals).toEqual(bucket().totals);
  });

  it("credits an Anthropic model scanned as Codex to Claude Code", () => {
    const attributed = attributeGatewayBucket(
      bucket({ provider: "codex", model: "claude-opus-5" }),
    );
    expect(attributed.provider).toBe("claude");
  });

  it("tolerates a vendor-prefixed model name", () => {
    expect(attributeGatewayBucket(bucket({ model: "openai/GPT-5.6-terra" })).provider).toBe(
      "codex",
    );
  });

  it("leaves a model already on its own provider untouched", () => {
    const claude = bucket({ model: "claude-opus-5" });
    expect(attributeGatewayBucket(claude)).toBe(claude);
    const codex = bucket({ provider: "codex", model: "gpt-5.5" });
    expect(attributeGatewayBucket(codex)).toBe(codex);
  });

  it("leaves a model of neither family where it was scanned", () => {
    const unknown = bucket({ model: "some-local-model" });
    expect(attributeGatewayBucket(unknown)).toBe(unknown);
  });
});
