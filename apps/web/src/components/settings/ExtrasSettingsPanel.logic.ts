import {
  clampProviderUsageAlertPercent,
  DEFAULT_PROVIDER_USAGE_CRITICAL_PERCENT,
  DEFAULT_PROVIDER_USAGE_WARNING_PERCENT,
  MAX_OPENROUTER_CREDITS_BUDGET_USD,
  MIN_OPENROUTER_CREDITS_BUDGET_USD,
  type OpenRouterCreditsBudgetUsd,
  type ProviderUsageAlertPercent,
} from "@t3tools/contracts/settings";

export interface ProviderUsageThresholdSettings {
  readonly providerUsageWarningPercent: ProviderUsageAlertPercent;
  readonly providerUsageCriticalPercent: ProviderUsageAlertPercent;
}

/**
 * Keeps `warning <= critical` in what is persisted: the usage ring coerces an inverted
 * pair, so a stored inverted pair would render differently from the settings page.
 * `null` (an emptied field) means "no change", matching the other numeric rows.
 */
export function resolveProviderUsageThresholdCommit(input: {
  readonly field: "warning" | "critical";
  readonly value: number | null;
  readonly current: ProviderUsageThresholdSettings;
}): ProviderUsageThresholdSettings {
  const current = {
    providerUsageWarningPercent: clampProviderUsageAlertPercent(
      input.current.providerUsageWarningPercent,
      DEFAULT_PROVIDER_USAGE_WARNING_PERCENT,
    ),
    providerUsageCriticalPercent: clampProviderUsageAlertPercent(
      input.current.providerUsageCriticalPercent,
      DEFAULT_PROVIDER_USAGE_CRITICAL_PERCENT,
    ),
  };
  if (input.value === null) {
    return current;
  }

  if (input.field === "warning") {
    const warning = clampProviderUsageAlertPercent(
      input.value,
      current.providerUsageWarningPercent,
    );
    return {
      providerUsageWarningPercent: Math.min(
        warning,
        current.providerUsageCriticalPercent,
      ) as ProviderUsageAlertPercent,
      providerUsageCriticalPercent: current.providerUsageCriticalPercent,
    };
  }

  const critical = clampProviderUsageAlertPercent(
    input.value,
    current.providerUsageCriticalPercent,
  );
  return {
    providerUsageWarningPercent: Math.min(
      current.providerUsageWarningPercent,
      critical,
    ) as ProviderUsageAlertPercent,
    providerUsageCriticalPercent: critical,
  };
}

/**
 * An emptied field means "no budget", so `null` persists rather than snapping back.
 * Zero and negatives also mean no budget (a tiny one renders an instantly-red bar).
 * Values above the schema maximum clamp to it, or decode would reject the patch silently.
 */
export function resolveOpenRouterCreditsBudgetCommit(
  value: number | null,
): OpenRouterCreditsBudgetUsd | null {
  if (value === null || !Number.isFinite(value) || value < MIN_OPENROUTER_CREDITS_BUDGET_USD) {
    return null;
  }
  return Math.min(MAX_OPENROUTER_CREDITS_BUDGET_USD, value) as OpenRouterCreditsBudgetUsd;
}
