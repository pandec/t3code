import type { ProviderUsageWindow } from "@t3tools/client-runtime/state/provider-usage";
import type { ModelSelection, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";

export function providerSupportsManualCompaction(
  provider: ProviderInstanceEntry | null | undefined,
): boolean {
  return provider?.snapshot.slashCommands.some((command) => command.name === "compact") ?? false;
}

export function hasAvailableCompactionProvider(input: {
  readonly providers: ReadonlyArray<ProviderInstanceEntry>;
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly lockedInstanceId: ProviderInstanceId | null;
}): boolean {
  const driverProviders = input.providers.filter(
    (provider) => provider.driverKind === input.driverKind,
  );
  const lockedContinuationGroupKey = input.lockedInstanceId
    ? driverProviders.find((provider) => provider.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey
    : undefined;
  const compatibleProviders = lockedContinuationGroupKey
    ? driverProviders.filter(
        (provider) => provider.continuationGroupKey === lockedContinuationGroupKey,
      )
    : driverProviders;

  return providerSupportsManualCompaction(
    resolveSelectableProviderInstanceEntry(compatibleProviders, input.instanceId ?? undefined),
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

export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactThreshold?: number | null,
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at about ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  return modelDisplayName
    ? `Context for ${modelDisplayName} compacts automatically when needed.`
    : "Context compacts automatically when needed.";
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
