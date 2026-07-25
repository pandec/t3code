import type { ProviderUsageSnapshot } from "@t3tools/client-runtime/state/provider-usage";
import { describe, expect, it } from "vite-plus/test";

import { providerUsageMenuActions, providerUsageTriggerLabel } from "./providerUsageMenu";

const NOW_MS = Date.parse("2026-07-25T00:00:00.000Z");

function makeSnapshot(overrides: Partial<ProviderUsageSnapshot>): ProviderUsageSnapshot {
  return {
    providerLabel: "Claude",
    windows: [],
    status: "ok",
    constrainedWindow: null,
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("providerUsageTriggerLabel", () => {
  it("stays quiet while usage is unremarkable", () => {
    expect(providerUsageTriggerLabel(makeSnapshot({}))).toBe("Usage");
  });

  it("surfaces the constrained window with its percentage", () => {
    const label = providerUsageTriggerLabel(
      makeSnapshot({
        status: "warning",
        constrainedWindow: {
          id: "five_hour",
          label: "Session (5h)",
          shortLabel: "5h",
          usedPercent: 88,
          resetsAt: null,
          status: "warning",
        },
      }),
    );
    expect(label).toBe("5h 88%");
  });

  it("omits the percentage for numberless constrained windows", () => {
    const label = providerUsageTriggerLabel(
      makeSnapshot({
        status: "warning",
        constrainedWindow: {
          id: "five_hour",
          label: "Session (5h)",
          shortLabel: "5h",
          usedPercent: null,
          resetsAt: null,
          status: "warning",
        },
      }),
    );
    expect(label).toBe("5h");
  });
});

describe("providerUsageMenuActions", () => {
  it("builds one row per window with usage and reset in the subtitle", () => {
    const resetsAt = Math.floor(Date.parse("2026-07-25T09:00:00.000Z") / 1_000);
    const actions = providerUsageMenuActions(
      makeSnapshot({
        windows: [
          {
            id: "five_hour",
            label: "Session (5h)",
            shortLabel: "5h",
            usedPercent: 42,
            resetsAt,
            status: "ok",
          },
          {
            id: "seven_day",
            label: "Weekly (all models)",
            shortLabel: "Wk",
            usedPercent: null,
            resetsAt: null,
            status: "warning",
          },
        ],
      }),
      NOW_MS,
    );

    expect(actions).toHaveLength(2);
    expect(actions[0]?.title).toBe("Session (5h)");
    expect(actions[0]?.subtitle).toMatch(/^42% used · resets /);
    expect(actions[1]?.subtitle).toBe("Limit warning");
  });

  it("describes exhausted numberless windows as limit reached", () => {
    const actions = providerUsageMenuActions(
      makeSnapshot({
        windows: [
          {
            id: "five_hour",
            label: "Session (5h)",
            shortLabel: "5h",
            usedPercent: null,
            resetsAt: Math.floor(NOW_MS / 1_000) - 60,
            status: "critical",
          },
        ],
      }),
      NOW_MS,
    );

    // A reset time in the past is stale information; only the state remains.
    expect(actions[0]?.subtitle).toBe("Limit reached");
  });
});
