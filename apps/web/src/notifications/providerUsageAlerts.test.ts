import type { ProviderUsageAlert } from "@t3tools/client-runtime/state/provider-usage";
import { describe, expect, it } from "vite-plus/test";

import { buildProviderUsageAlertCopy } from "./providerUsageAlerts";

const NOW_MS = Date.parse("2026-07-25T00:00:00.000Z");

function makeNumberlessAlert(threshold: ProviderUsageAlert["threshold"]): ProviderUsageAlert {
  return {
    keys: [`Claude:five_hour:${threshold}:unknown`],
    providerLabel: "Claude",
    threshold,
    window: {
      id: "five_hour",
      label: "Session (5h)",
      shortLabel: "5h",
      usedPercent: null,
      resetsAt: null,
      status: threshold === "critical" ? "critical" : "warning",
    },
  };
}

describe("buildProviderUsageAlertCopy", () => {
  it("describes a numberless warning without claiming the limit was reached", () => {
    expect(buildProviderUsageAlertCopy(makeNumberlessAlert("warning"), NOW_MS)).toEqual({
      title: "Claude rate limit warning",
      body: "Session (5h) is nearing its limit.",
    });
  });

  it("describes a numberless critical state as reached", () => {
    expect(buildProviderUsageAlertCopy(makeNumberlessAlert("critical"), NOW_MS)).toEqual({
      title: "Claude rate limit reached",
      body: "Session (5h) has reached its limit.",
    });
  });
});
