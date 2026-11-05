import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import {
  getModelSelectionOptionDescriptors,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";

function parseContextWindowOption(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)(k|m)$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount * (match[2].toLowerCase() === "m" ? 1_000_000 : 1_000);
}

export function resolveKnownContextWindowMaxTokens(
  model: ServerProviderModel | null | undefined,
  modelSelection: ModelSelection | null | undefined,
): number | null {
  if (!model || model.isCustom) return null;
  // Pre-report fallback only. Keep in sync with claudeContextWindow in
  // apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts until fixed
  // capacity moves into shared model capability metadata; once a turn reports,
  // the server's reading (measured against the serving model) wins.
  if (model.slug === "claude-opus-4-8" || model.slug === "claude-opus-4-7") {
    return 1_000_000;
  }
  const descriptor = getModelSelectionOptionDescriptors(modelSelection, model.capabilities).find(
    (candidate) => candidate.id === "contextWindow",
  );
  return parseContextWindowOption(getProviderOptionCurrentValue(descriptor));
}

export function emptyContextWindowSnapshot(input: {
  readonly maxTokens: number;
  readonly compactsAutomatically: boolean;
}): ContextWindowSnapshot {
  return {
    usedTokens: 0,
    totalProcessedTokens: null,
    maxTokens: input.maxTokens,
    remainingTokens: input.maxTokens,
    usedPercentage: 0,
    remainingPercentage: 100,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: input.compactsAutomatically,
    autoCompactThreshold: null,
    cost: null,
    updatedAt: new Date().toISOString(),
  };
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 999_500) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
