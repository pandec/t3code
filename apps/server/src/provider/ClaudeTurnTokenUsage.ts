import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeTurnStatus, TurnTokenUsage } from "@t3tools/contracts";

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export function normalizeClaudeTurnTokenUsage(
  result: { readonly subtype: SDKResultMessage["subtype"]; readonly usage?: unknown } | undefined,
  hasSubagents: boolean,
  terminalStatus: ProviderRuntimeTurnStatus,
): TurnTokenUsage {
  const usage = result?.usage as Record<string, unknown> | undefined;
  if (!usage) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
    };
  }

  const uncachedInputTokens = finiteNonNegativeInteger(usage.input_tokens);
  const cachedInputTokens = finiteNonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreationTokens = finiteNonNegativeInteger(usage.cache_creation_input_tokens);
  const rawOutputTokens = finiteNonNegativeInteger(usage.output_tokens);
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  const thinkingTokens = finiteNonNegativeInteger(outputDetails?.thinking_tokens);
  const cachedInputContribution = usage.cache_read_input_tokens == null ? 0 : cachedInputTokens;
  const cacheCreationContribution =
    usage.cache_creation_input_tokens == null ? 0 : cacheCreationTokens;
  const inputTokens =
    uncachedInputTokens !== undefined &&
    cachedInputContribution !== undefined &&
    cacheCreationContribution !== undefined
      ? uncachedInputTokens + cachedInputContribution + cacheCreationContribution
      : undefined;
  const hasKnownUsage =
    uncachedInputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    cacheCreationTokens !== undefined ||
    rawOutputTokens !== undefined;
  const hasPositiveUsage =
    (uncachedInputTokens ?? 0) +
      (cachedInputTokens ?? 0) +
      (cacheCreationTokens ?? 0) +
      (rawOutputTokens ?? 0) >
    0;

  if (!hasKnownUsage || (result?.subtype !== "success" && !hasPositiveUsage)) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
    };
  }

  const commonUsage = {
    usageScope: "main_agent",
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(thinkingTokens !== undefined && rawOutputTokens !== undefined
      ? { reasoningTokens: Math.min(rawOutputTokens, thinkingTokens) }
      : {}),
    hasSubagents,
  } as const;
  if (
    terminalStatus === "completed" &&
    result?.subtype === "success" &&
    inputTokens !== undefined &&
    rawOutputTokens !== undefined
  ) {
    return {
      ...commonUsage,
      usageStatus: "complete",
      inputTokens,
      outputTokens: rawOutputTokens,
    };
  }
  return {
    ...commonUsage,
    usageStatus: "partial",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(rawOutputTokens !== undefined ? { outputTokens: rawOutputTokens } : {}),
  };
}

const SUMMED_CLAUDE_USAGE_KEYS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
] as const;

// Fork: Claude reports `usage` per native turn. When one app turn spans
// several native turns (a steer Claude ran after the turn's result), add them
// up so the turn's totals cover all of them. The last usage supplies any
// fields that are not summed.
export function sumClaudeResultUsage(
  usages: readonly [...ReadonlyArray<SDKResultMessage["usage"]>, SDKResultMessage["usage"]],
): SDKResultMessage["usage"] {
  const last = usages[usages.length - 1]!;
  const records: ReadonlyArray<Record<string, unknown>> = usages;
  const summed: Record<string, unknown> = { ...last };
  for (const key of SUMMED_CLAUDE_USAGE_KEYS) {
    const values = records.map((usage) => finiteNonNegativeInteger(usage[key]));
    if (values.some((value) => value !== undefined)) {
      summed[key] = values.reduce<number>((total, value) => total + (value ?? 0), 0);
    }
  }
  const thinking = records.map((usage) =>
    finiteNonNegativeInteger(
      (usage.output_tokens_details as Record<string, unknown> | undefined)?.thinking_tokens,
    ),
  );
  if (thinking.some((value) => value !== undefined)) {
    summed.output_tokens_details = {
      ...(records.at(-1)?.output_tokens_details as Record<string, unknown> | undefined),
      thinking_tokens: thinking.reduce<number>((total, value) => total + (value ?? 0), 0),
    };
  }
  return { ...last, ...summed };
}
