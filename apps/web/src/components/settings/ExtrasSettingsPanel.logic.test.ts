import { describe, expect, it } from "vite-plus/test";

import {
  resolveOpenRouterCreditsBudgetCommit,
  resolveProviderUsageThresholdCommit,
} from "./ExtrasSettingsPanel.logic";

const current = {
  providerUsageWarningPercent: 80,
  providerUsageCriticalPercent: 95,
} as const;

describe("resolveProviderUsageThresholdCommit", () => {
  it("commits an in-range edit without touching the other threshold", () => {
    expect(resolveProviderUsageThresholdCommit({ field: "warning", value: 70, current })).toEqual({
      providerUsageWarningPercent: 70,
      providerUsageCriticalPercent: 95,
    });
    expect(resolveProviderUsageThresholdCommit({ field: "critical", value: 99, current })).toEqual({
      providerUsageWarningPercent: 80,
      providerUsageCriticalPercent: 99,
    });
  });

  it("keeps the warning at or below the critical threshold", () => {
    expect(resolveProviderUsageThresholdCommit({ field: "warning", value: 99, current })).toEqual({
      providerUsageWarningPercent: 95,
      providerUsageCriticalPercent: 95,
    });
    expect(resolveProviderUsageThresholdCommit({ field: "critical", value: 50, current })).toEqual({
      providerUsageWarningPercent: 50,
      providerUsageCriticalPercent: 50,
    });
  });

  it("clamps out-of-range and fractional input into 1-100 integers", () => {
    expect(resolveProviderUsageThresholdCommit({ field: "warning", value: 0, current })).toEqual({
      providerUsageWarningPercent: 1,
      providerUsageCriticalPercent: 95,
    });
    expect(
      resolveProviderUsageThresholdCommit({ field: "critical", value: 1_000, current }),
    ).toEqual({ providerUsageWarningPercent: 80, providerUsageCriticalPercent: 100 });
    expect(resolveProviderUsageThresholdCommit({ field: "warning", value: 70.6, current })).toEqual(
      { providerUsageWarningPercent: 71, providerUsageCriticalPercent: 95 },
    );
  });

  it("treats an emptied field as no change and repairs an inverted stored pair", () => {
    expect(resolveProviderUsageThresholdCommit({ field: "warning", value: null, current })).toEqual(
      current,
    );
    expect(
      resolveProviderUsageThresholdCommit({
        field: "critical",
        value: null,
        current: { providerUsageWarningPercent: 90, providerUsageCriticalPercent: 40 },
      }),
    ).toEqual({ providerUsageWarningPercent: 90, providerUsageCriticalPercent: 40 });
    expect(
      resolveProviderUsageThresholdCommit({
        field: "critical",
        value: 40,
        current: { providerUsageWarningPercent: 90, providerUsageCriticalPercent: 40 },
      }),
    ).toEqual({ providerUsageWarningPercent: 40, providerUsageCriticalPercent: 40 });
  });
});

describe("resolveOpenRouterCreditsBudgetCommit", () => {
  it("keeps an in-range budget, decimals included", () => {
    expect(resolveOpenRouterCreditsBudgetCommit(50)).toBe(50);
    expect(resolveOpenRouterCreditsBudgetCommit(12.5)).toBe(12.5);
  });

  it("persists an emptied field as no budget", () => {
    expect(resolveOpenRouterCreditsBudgetCommit(null)).toBeNull();
    expect(resolveOpenRouterCreditsBudgetCommit(Number.NaN)).toBeNull();
  });

  it("treats zero and negatives as no budget", () => {
    expect(resolveOpenRouterCreditsBudgetCommit(0)).toBeNull();
    expect(resolveOpenRouterCreditsBudgetCommit(-20)).toBeNull();
    expect(resolveOpenRouterCreditsBudgetCommit(0.5)).toBeNull();
  });

  it("clamps an oversized budget down to the schema maximum", () => {
    expect(resolveOpenRouterCreditsBudgetCommit(5_000_000)).toBe(1_000_000);
  });
});
