import { describe, expect, it } from "vite-plus/test";

import type { ProviderUsageWindow } from "./providerUsage.js";
import {
  describeProviderUsageWindowValue,
  formatProviderUsageAge,
  formatProviderUsagePercent,
  formatProviderUsageResetTime,
  isProviderUsageSnapshotStale,
  providerUsageBarPercent,
} from "./providerUsagePresentation.js";

const NOW_MS = Date.parse("2026-07-25T00:00:00.000Z");

function makeWindow(overrides: Partial<ProviderUsageWindow>): ProviderUsageWindow {
  return {
    id: "five_hour",
    group: "session",
    label: "Session (5h)",
    shortLabel: "5h",
    usedPercent: 42,
    resetsAt: null,
    status: "ok",
    ...overrides,
  };
}

describe("formatProviderUsagePercent", () => {
  it("keeps one decimal near zero so barely-used never reads as untouched", () => {
    expect(formatProviderUsagePercent(0)).toBe("0%");
    expect(formatProviderUsagePercent(3.4)).toBe("3.4%");
    expect(formatProviderUsagePercent(9.04)).toBe("9%");
  });

  it("rounds to whole numbers above ten", () => {
    expect(formatProviderUsagePercent(67.6)).toBe("68%");
  });

  it("has nothing to say about a missing or non-finite value", () => {
    expect(formatProviderUsagePercent(null)).toBeNull();
    expect(formatProviderUsagePercent(Number.NaN)).toBeNull();
  });
});

describe("formatProviderUsageResetTime", () => {
  it("drops a reset that has already passed", () => {
    expect(formatProviderUsageResetTime(Math.floor(NOW_MS / 1_000) - 60, NOW_MS)).toBeNull();
    expect(formatProviderUsageResetTime(null, NOW_MS)).toBeNull();
  });

  it("names the weekday once the reset is more than a day out", () => {
    const withinDay = formatProviderUsageResetTime(
      Math.floor((NOW_MS + 2 * 60 * 60 * 1_000) / 1_000),
      NOW_MS,
    );
    const nextWeek = formatProviderUsageResetTime(
      Math.floor((NOW_MS + 3 * 24 * 60 * 60 * 1_000) / 1_000),
      NOW_MS,
    );
    // Only the far reset leads with a weekday; a same-day reset is clock-only.
    expect(nextWeek).toMatch(/^[A-Za-z]{3}/);
    expect(withinDay).not.toMatch(/^[A-Za-z]{3}/);
  });
});

describe("describeProviderUsageWindowValue", () => {
  it("prefers the reported percentage", () => {
    expect(describeProviderUsageWindowValue(makeWindow({ usedPercent: 68 }))).toBe("68%");
  });

  it("falls back to the threshold state when the provider reports no number", () => {
    expect(
      describeProviderUsageWindowValue(makeWindow({ usedPercent: null, status: "critical" })),
    ).toBe("limit reached");
    expect(
      describeProviderUsageWindowValue(makeWindow({ usedPercent: null, status: "warning" })),
    ).toBe("limit warning");
  });
});

describe("providerUsageBarPercent", () => {
  it("clamps to the bar's range", () => {
    expect(providerUsageBarPercent(makeWindow({ usedPercent: 140 }))).toBe(100);
    expect(providerUsageBarPercent(makeWindow({ usedPercent: -5 }))).toBe(0);
    expect(providerUsageBarPercent(null)).toBe(0);
  });

  it("fills a numberless window that is already in trouble", () => {
    // Without a number the only honest bar for a warned window is a full one.
    expect(providerUsageBarPercent(makeWindow({ usedPercent: null, status: "warning" }))).toBe(100);
    expect(providerUsageBarPercent(makeWindow({ usedPercent: null, status: "ok" }))).toBe(0);
  });
});

describe("snapshot freshness", () => {
  it("describes the age of a read", () => {
    expect(formatProviderUsageAge(null, NOW_MS)).toBe("not updated yet");
    expect(formatProviderUsageAge(NOW_MS - 30_000, NOW_MS)).toBe("updated just now");
    expect(formatProviderUsageAge(NOW_MS - 4 * 60_000, NOW_MS)).toBe("updated 4m ago");
    expect(formatProviderUsageAge(NOW_MS - 3 * 60 * 60_000, NOW_MS)).toBe("updated 3h ago");
  });

  it("treats a never-read or long-untouched account as stale", () => {
    expect(isProviderUsageSnapshotStale(null, NOW_MS)).toBe(true);
    expect(isProviderUsageSnapshotStale(NOW_MS - 60_000, NOW_MS)).toBe(false);
    expect(isProviderUsageSnapshotStale(NOW_MS - 6 * 60_000, NOW_MS)).toBe(true);
  });
});
