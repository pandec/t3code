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
 * Commit one edited threshold while keeping `warning <= critical`.
 *
 * The runtime already coerces an inverted pair when it colours the usage ring,
 * so an inverted *stored* pair would silently render as something the settings
 * page does not show. Clamping here keeps what is persisted equal to what is
 * displayed: raising the warning past the critical mark pushes it back down to
 * the critical mark, and lowering the critical mark drags the warning with it.
 *
 * `null` (an emptied number field) is treated as "no change", matching how the
 * other numeric settings rows snap back to the persisted value.
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
 * Commit the OpenRouter budget field. Unlike the threshold rows, an emptied
 * field is a real choice here — "no budget" — so `null` persists as null
 * rather than snapping back. Out-of-range or non-finite input clamps into the
 * schema's bounds, since the patch would otherwise be rejected on decode and
 * the field would silently keep the old value.
 */
export function resolveOpenRouterCreditsBudgetCommit(
  value: number | null,
): OpenRouterCreditsBudgetUsd | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(
    MAX_OPENROUTER_CREDITS_BUDGET_USD,
    Math.max(MIN_OPENROUTER_CREDITS_BUDGET_USD, value),
  ) as OpenRouterCreditsBudgetUsd;
}
