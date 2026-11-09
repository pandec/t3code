import type { ProviderUsageWindow } from "@t3tools/client-runtime/state/provider-usage";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";

export function threadShellHasStarted(
  shell:
    | Pick<EnvironmentThreadShell, "latestRun" | "latestUserMessageAt" | "runtime">
    | null
    | undefined,
): boolean {
  return Boolean(
    shell &&
    (shell.latestRun !== null || shell.latestUserMessageAt !== null || shell.runtime !== null),
  );
}

export function resolveContextWindowModelDisplayName(
  selection: ModelSelection | null | undefined,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): string | null {
  if (!selection) {
    return null;
  }

  const selectedModel = modelOptionsByInstance
    .get(selection.instanceId)
    ?.find((model) => model.slug === selection.model);

  return selectedModel ? getDisplayModelName(selectedModel) : selection.model;
}

export function formatMeterCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactThreshold?: number | null,
): string {
  if (modelDisplayName && !(typeof autoCompactThreshold === "number" && autoCompactThreshold > 0)) {
    return `Context for ${modelDisplayName} compacts automatically when needed.`;
  }
  return formatContextWindowCompactionMessage(autoCompactThreshold);
}

/**
 * The OpenRouter balance as a quota window: OpenRouter only reports what is left,
 * so the budget setting says what "full" is. Spending past the budget pins the
 * bar at 100%, and a topped-up balance above the budget reads as 0%.
 */
export function openRouterCreditsBudgetWindow(
  balanceUsd: number | null,
  budgetUsd: number | null,
): ProviderUsageWindow | null {
  if (balanceUsd === null || budgetUsd === null) return null;
  if (!Number.isFinite(balanceUsd) || !Number.isFinite(budgetUsd) || budgetUsd <= 0) return null;
  const usedPercent = Math.max(0, Math.min(100, ((budgetUsd - balanceUsd) / budgetUsd) * 100));
  return {
    id: "openrouter_budget",
    group: "other",
    label: `Budget ${formatUsd(budgetUsd)}`,
    shortLabel: "OR",
    usedPercent,
    resetsAt: null,
    status: "ok",
  };
}

export function shouldReserveContextWindowMeter(input: {
  readonly meterEnabled: boolean;
  readonly detailLoading: boolean;
  readonly threadStarted: boolean;
  readonly providerReportsContextWindow: boolean | null;
}): boolean {
  return (
    input.meterEnabled &&
    input.detailLoading &&
    input.threadStarted &&
    input.providerReportsContextWindow !== false
  );
}

export function formatContextWindowCost(cost: {
  readonly amount: number;
  readonly currency: string;
}): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}
