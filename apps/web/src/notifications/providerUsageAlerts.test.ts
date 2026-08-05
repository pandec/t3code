import type { ProviderUsageAlert } from "@t3tools/client-runtime/state/provider-usage";
import { describe, expect, it } from "vite-plus/test";

import { buildProviderUsageAlertCopy } from "./providerUsageAlerts";

const NOW_MS = Date.parse("2026-07-25T00:00:00.000Z");

const numberlessAlert: ProviderUsageAlert = {
  key: "Claude:five_hour:warning:unknown",
  providerLabel: "Claude",
  window: {
    id: "five_hour",
    group: "session",
    label: "Session (5h)",
    shortLabel: "5h",
    usedPercent: null,
    resetsAt: null,
    status: "warning",
  },
};

describe("buildProviderUsageAlertCopy", () => {
  it("describes a numberless warning without claiming the limit was reached", () => {
    expect(buildProviderUsageAlertCopy(numberlessAlert, NOW_MS)).toEqual({
      title: "Claude rate limit warning",
      body: "Session (5h) is nearing its limit.",
    });
  });
});
