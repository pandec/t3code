import { describe, expect, it } from "vite-plus/test";
import {
  openRouterCreditsBudgetWindow,
  shouldReserveContextWindowMeter,
} from "./ContextWindowMeter.logic";

describe("openRouterCreditsBudgetWindow", () => {
  it("measures the burn against the budget", () => {
    const window = openRouterCreditsBudgetWindow(47.23, 50);
    expect(window?.usedPercent).toBeCloseTo(5.54, 2);
    expect(window?.label).toBe("Budget $50.00");
    expect(window?.status).toBe("ok");
  });

  it("pins overspend at 100% and a topped-up balance at 0%", () => {
    expect(openRouterCreditsBudgetWindow(-3, 50)?.usedPercent).toBe(100);
    expect(openRouterCreditsBudgetWindow(80, 50)?.usedPercent).toBe(0);
  });

  it("has no window without both a balance and a positive budget", () => {
    expect(openRouterCreditsBudgetWindow(null, 50)).toBeNull();
    expect(openRouterCreditsBudgetWindow(47.23, null)).toBeNull();
    expect(openRouterCreditsBudgetWindow(47.23, 0)).toBeNull();
    expect(openRouterCreditsBudgetWindow(Number.NaN, 50)).toBeNull();
  });
});

describe("shouldReserveContextWindowMeter", () => {
  const loadingStartedThread = {
    meterEnabled: true,
    detailLoading: true,
    threadStarted: true,
    providerReportsContextWindow: true,
  };

  it("holds the meter's slot while a started thread's detail loads", () => {
    expect(shouldReserveContextWindowMeter(loadingStartedThread)).toBe(true);
  });

  it("reserves while the thread's provider is not in the catalog yet", () => {
    expect(
      shouldReserveContextWindowMeter({
        ...loadingStartedThread,
        providerReportsContextWindow: null,
      }),
    ).toBe(true);
  });
});
