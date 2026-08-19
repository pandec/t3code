import { describe, expect, it } from "vite-plus/test";

import type { ProviderUsageWindow } from "./providerUsage.js";
import {
  describeProviderUsageWindowValue,
  formatProviderUsageAge,
  formatProviderUsagePercent,
  formatProviderUsageResetTime,
  isProviderUsageSnapshotStale,
  oldestProviderUsageObservedAt,
  providerUsageBarPercent,
  resolveProviderUsageBoundAuthIndex,
  shouldProbeProviderUsageThreadAccount,
  shouldRefreshProviderUsageOnOpen,
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
    const farResetMs = NOW_MS + 3 * 24 * 60 * 60 * 1_000;
    const withinDay = formatProviderUsageResetTime(
      Math.floor((NOW_MS + 2 * 60 * 60 * 1_000) / 1_000),
      NOW_MS,
    );
    const nextWeek = formatProviderUsageResetTime(Math.floor(farResetMs / 1_000), NOW_MS);
    // Derived, not hard-coded: the formatter follows the host locale, so an
    // English weekday assertion would fail everywhere else.
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(farResetMs);
    // Only the far reset carries a weekday; a same-day reset is clock-only.
    expect(nextWeek).toContain(weekday);
    expect(withinDay).not.toContain(weekday);
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

  it("does not cry wolf over a numberless window that is doing fine", () => {
    // Neither a number nor a raised status: the row must not read as a warning
    // just because the provider withheld a percentage.
    expect(describeProviderUsageWindowValue(makeWindow({ usedPercent: null, status: "ok" }))).toBe(
      "usage",
    );
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

  it("ages the panel by its oldest account, not its newest", () => {
    // One freshness line covers every row, so a just-read sibling must not
    // vouch for an account that hasn't been read in minutes.
    const accounts = [{ observedAt: NOW_MS - 10_000 }, { observedAt: NOW_MS - 4 * 60_000 }];
    expect(oldestProviderUsageObservedAt(accounts)).toBe(NOW_MS - 4 * 60_000);
    expect(formatProviderUsageAge(oldestProviderUsageObservedAt(accounts), NOW_MS)).toBe(
      "updated 4m ago",
    );
    // A never-read account is older than any timestamp.
    expect(
      oldestProviderUsageObservedAt([{ observedAt: NOW_MS }, { observedAt: null }]),
    ).toBeNull();
    expect(oldestProviderUsageObservedAt([])).toBeNull();
  });
});

describe("shouldRefreshProviderUsageOnOpen", () => {
  it("re-reads when any listed account has gone a minute without one", () => {
    // Keyed on the oldest account: opening the panel must refresh the lagging
    // account even while a sibling was read seconds ago.
    expect(
      shouldRefreshProviderUsageOnOpen(
        [{ observedAt: NOW_MS - 10_000 }, { observedAt: NOW_MS - 4 * 60_000 }],
        NOW_MS,
      ),
    ).toBe(true);
    expect(shouldRefreshProviderUsageOnOpen([{ observedAt: null }], NOW_MS)).toBe(true);
  });

  it("leaves a wholly fresh panel alone", () => {
    expect(
      shouldRefreshProviderUsageOnOpen(
        [{ observedAt: NOW_MS - 10_000 }, { observedAt: NOW_MS - 20_000 }],
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("reads when there is nothing listed to compare against", () => {
    expect(shouldRefreshProviderUsageOnOpen([], NOW_MS)).toBe(true);
  });

  it("caps the cadence for an account that never reports at all", () => {
    // Expired auth or a probe that always fails leaves observedAt null forever.
    // Without the last-attempt cap, every open would probe the whole pool again.
    const never = [{ observedAt: null }];
    expect(shouldRefreshProviderUsageOnOpen(never, NOW_MS, NOW_MS - 10_000)).toBe(false);
    expect(shouldRefreshProviderUsageOnOpen(never, NOW_MS, NOW_MS - 90_000)).toBe(true);
    // 0 means this surface has never asked, so the first open always reads.
    expect(shouldRefreshProviderUsageOnOpen(never, NOW_MS, 0)).toBe(true);
  });
});

describe("shouldProbeProviderUsageThreadAccount", () => {
  const last = { key: "thread-1:claude-opus-5", askedAtMs: NOW_MS - 10_000 };

  it("waits out the cadence cap for the same thread and model", () => {
    expect(shouldProbeProviderUsageThreadAccount(last, last.key, NOW_MS)).toBe(false);
    expect(shouldProbeProviderUsageThreadAccount(last, last.key, last.askedAtMs + 60_000)).toBe(
      true,
    );
  });

  it("re-asks immediately for another thread or model", () => {
    expect(shouldProbeProviderUsageThreadAccount(last, "thread-2:claude-opus-5", NOW_MS)).toBe(
      true,
    );
    expect(shouldProbeProviderUsageThreadAccount(last, "thread-1:claude-fable-5", NOW_MS)).toBe(
      true,
    );
  });

  it("always allows an explicit force", () => {
    expect(shouldProbeProviderUsageThreadAccount(last, last.key, NOW_MS, true)).toBe(true);
  });
});

describe("resolveProviderUsageBoundAuthIndex", () => {
  const state = { threadId: "thread-1", model: "claude-opus-5", authIndex: "af6a" };

  it("answers only for the exact thread and model the probe was asked about", () => {
    expect(resolveProviderUsageBoundAuthIndex(state, "thread-1", "claude-opus-5")).toBe("af6a");
    expect(resolveProviderUsageBoundAuthIndex(state, "thread-2", "claude-opus-5")).toBeNull();
    expect(resolveProviderUsageBoundAuthIndex(state, "thread-1", "claude-fable-5")).toBeNull();
    expect(resolveProviderUsageBoundAuthIndex(state, undefined, "claude-opus-5")).toBeNull();
    expect(resolveProviderUsageBoundAuthIndex(null, "thread-1", "claude-opus-5")).toBeNull();
  });
});
