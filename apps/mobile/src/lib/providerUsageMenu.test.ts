import type { ProviderUsageSnapshot } from "@t3tools/client-runtime/state/provider-usage";
import { describe, expect, it } from "vite-plus/test";

import { providerUsageAccountMenuActions, providerUsageTriggerLabel } from "./providerUsageMenu";

const NOW_MS = Date.parse("2026-07-25T00:00:00.000Z");

function makeSnapshot(overrides: Partial<ProviderUsageSnapshot>): ProviderUsageSnapshot {
  return {
    providerLabel: "Claude",
    providerInstanceId: null,
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
          group: "session",
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
          group: "session",
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

describe("providerUsageAccountMenuActions", () => {
  it("builds one row per account with email, windows, and freshness", () => {
    const resetsAt = Math.floor(Date.parse("2026-07-25T09:00:00.000Z") / 1_000);
    const actions = providerUsageAccountMenuActions(
      [
        {
          instanceId: "claude-work",
          displayName: "Claude Work",
          email: "work@example.com",
          isCurrent: true,
          snapshot: makeSnapshot({
            windows: [
              {
                id: "five_hour",
                group: "session",
                label: "Session (5h)",
                shortLabel: "5h",
                usedPercent: 42,
                resetsAt,
                status: "ok",
              },
              {
                id: "seven_day",
                group: "weekly",
                label: "Weekly (all models)",
                shortLabel: "Wk",
                usedPercent: null,
                resetsAt: null,
                status: "warning",
              },
            ],
          }),
          observedAt: NOW_MS - 4 * 60_000,
        },
        {
          instanceId: "claude-personal",
          displayName: "Claude Personal",
          email: "personal@example.com",
          isCurrent: false,
          snapshot: null,
          observedAt: null,
        },
      ],
      NOW_MS,
    );

    expect(actions).toHaveLength(2);
    // The session's live account is marked when a sibling exists to tell apart.
    expect(actions[0]).toMatchObject({
      title: "Claude Work (current)",
      subtitle: expect.stringContaining("work@example.com"),
    });
    expect(actions[1]?.title).toBe("Claude Personal");
    expect(actions[0]?.subtitle).toContain("Session (5h):");
    expect(actions[0]?.subtitle).toContain("Weekly (all models):");
    expect(actions[0]?.subtitle).toMatch(/42% used · resets /);
    expect(actions[0]?.subtitle).toContain("Limit warning");
    expect(actions[0]?.subtitle).toContain("updated 4m ago");
    expect(actions[1]?.subtitle).toContain("No usage data");
  });

  it("describes exhausted numberless windows as limit reached", () => {
    const actions = providerUsageAccountMenuActions(
      [
        {
          instanceId: "claude-work",
          displayName: "Claude Work",
          email: undefined,
          isCurrent: true,
          snapshot: makeSnapshot({
            windows: [
              {
                id: "five_hour",
                group: "session",
                label: "Session (5h)",
                shortLabel: "5h",
                usedPercent: null,
                resetsAt: Math.floor(NOW_MS / 1_000) - 60,
                status: "critical",
              },
            ],
          }),
          observedAt: NOW_MS,
        },
      ],
      NOW_MS,
    );

    // A reset time in the past is stale information; only the state remains.
    expect(actions[0]?.subtitle).toContain("Limit reached");
    expect(actions[0]?.subtitle).not.toContain("resets");
    // A lone account needs no "current" marker — there is nothing to tell apart.
    expect(actions[0]?.title).toBe("Claude Work");
  });
});
