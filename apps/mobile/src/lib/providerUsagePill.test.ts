import { describe, expect, it } from "vite-plus/test";

import {
  canStartProviderUsageRefresh,
  PROVIDER_USAGE_REFRESH_DEBOUNCE_MS,
  providerUsageTriggerLabel,
} from "./providerUsagePill";

const NOW_MS = Date.parse("2026-07-25T00:00:00.000Z");

describe("providerUsageTriggerLabel", () => {
  it("stays quiet while usage is unremarkable", () => {
    expect(providerUsageTriggerLabel(null)).toBe("Usage");
  });

  it("surfaces the primary window with its percentage", () => {
    expect(
      providerUsageTriggerLabel({
        id: "five_hour",
        group: "session",
        label: "Session (5h)",
        shortLabel: "5h",
        usedPercent: 88,
        resetsAt: null,
        status: "warning",
      }),
    ).toBe("5h 88%");
  });

  it("omits the percentage for a numberless primary window", () => {
    expect(
      providerUsageTriggerLabel({
        id: "five_hour",
        group: "session",
        label: "Session (5h)",
        shortLabel: "5h",
        usedPercent: null,
        resetsAt: null,
        status: "warning",
      }),
    ).toBe("5h");
  });
});

describe("canStartProviderUsageRefresh", () => {
  it("allows the first refresh and blocks a rapid second one", () => {
    // A refresh can spawn one CLI probe per account, so a double-tap must not
    // double-spawn.
    expect(canStartProviderUsageRefresh(0, NOW_MS)).toBe(true);
    expect(canStartProviderUsageRefresh(NOW_MS, NOW_MS + 1_000)).toBe(false);
    expect(canStartProviderUsageRefresh(NOW_MS, NOW_MS + PROVIDER_USAGE_REFRESH_DEBOUNCE_MS)).toBe(
      true,
    );
  });

  it("treats a reset window as never-refreshed", () => {
    // Switching environments resets the marker; the new environment must not
    // inherit the previous one's cooldown.
    expect(canStartProviderUsageRefresh(0, 0)).toBe(true);
  });
});
