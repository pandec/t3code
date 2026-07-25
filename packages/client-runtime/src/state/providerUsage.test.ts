import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectProviderUsageAlerts,
  deriveLatestProviderUsageSnapshot,
  providerUsageAlertKey,
} from "./providerUsage.ts";

function makeActivity(
  id: string,
  payload: unknown,
  createdAt = "2026-07-25T00:00:00.000Z",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "account.rate-limits.updated",
    summary: "Account rate limits updated",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt,
  };
}

function claudeActivity(
  id: string,
  info: Record<string, unknown>,
  createdAt?: string,
): OrchestrationThreadActivity {
  return makeActivity(
    id,
    { rateLimits: { type: "rate_limit_event", rate_limit_info: info } },
    createdAt,
  );
}

describe("deriveLatestProviderUsageSnapshot", () => {
  it("derives a Claude window from a live-captured event shape", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
        utilization: 0.42,
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
        isUsingOverage: false,
      }),
    ]);

    expect(snapshot?.providerLabel).toBe("Claude");
    expect(snapshot?.status).toBe("ok");
    expect(snapshot?.constrainedWindow).toBeNull();
    expect(snapshot?.windows).toEqual([
      {
        id: "five_hour",
        label: "Session (5h)",
        shortLabel: "5h",
        usedPercent: 42,
        resetsAt: 1784970000,
        status: "ok",
      },
    ]);
  });

  it("ignores allowed Claude events that carry no usage number", () => {
    // The current CLI emits exactly this at low usage (verified live, 2.1.220).
    const snapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
      }),
    ]);

    expect(snapshot).toBeNull();
  });

  it("renders a numberless row for a non-allowed Claude event", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed_warning",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
      }),
    ]);

    expect(snapshot?.status).toBe("warning");
    expect(snapshot?.windows[0]?.usedPercent).toBeNull();
  });

  it("renders a rejected Claude window without fabricating a percentage", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "rejected",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
      }),
    ]);

    expect(snapshot?.status).toBe("critical");
    expect(snapshot?.windows[0]?.usedPercent).toBeNull();
  });

  it("does not treat a crossed threshold as current utilization", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
        surpassedThreshold: 0.8,
      }),
    ]);

    expect(snapshot).toBeNull();
  });

  it("labels unknown weekly window taxonomies instead of dropping them", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed",
        resetsAt: 1785400000,
        rateLimitType: "seven_day_fable",
        utilization: 0.5,
      }),
    ]);

    expect(snapshot?.windows[0]?.label).toBe("Weekly (Fable)");
    expect(snapshot?.windows[0]?.shortLabel).toBe("Fable");
  });

  it("falls back to a humanized label for entirely unknown window types", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed",
        rateLimitType: "lunar_cycle",
        utilization: 0.5,
      }),
    ]);

    expect(snapshot?.windows[0]?.label).toBe("Lunar Cycle");
  });

  it("accepts snake_case Claude fields from older SDK releases", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed",
        resets_at: 1784970000,
        rate_limit_type: "seven_day",
        utilization: 0.9,
      }),
    ]);

    expect(snapshot?.windows).toEqual([
      {
        id: "seven_day",
        label: "Weekly (all models)",
        shortLabel: "Wk",
        usedPercent: 90,
        resetsAt: 1784970000,
        status: "warning",
      },
    ]);
  });

  it("merges per-window Claude events, newest winning per window", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity(
        "a1",
        { status: "allowed", resetsAt: 100, rateLimitType: "five_hour", utilization: 0.9 },
        "2026-07-25T00:00:00.000Z",
      ),
      claudeActivity(
        "a2",
        { status: "allowed", resetsAt: 200, rateLimitType: "seven_day", utilization: 0.3 },
        "2026-07-25T00:01:00.000Z",
      ),
      claudeActivity(
        "a3",
        { status: "allowed", resetsAt: 300, rateLimitType: "five_hour", utilization: 0.1 },
        "2026-07-25T00:02:00.000Z",
      ),
    ]);

    expect(snapshot?.updatedAt).toBe("2026-07-25T00:02:00.000Z");
    expect(snapshot?.windows).toHaveLength(2);
    expect(snapshot?.windows.find((w) => w.id === "five_hour")?.usedPercent).toBe(10);
    expect(snapshot?.windows.find((w) => w.id === "seven_day")?.usedPercent).toBe(30);
  });

  it("derives Codex windows from the double-nested adapter payload", () => {
    // Mirrors the real activity shape: the adapter wraps the app-server
    // notification (`{ rateLimits: <snapshot> }`) under `rateLimits` again.
    const snapshot = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            limitName: null,
            planType: "pro",
            rateLimitReachedType: null,
            primary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: 1785475320 },
            secondary: null,
          },
        },
      }),
    ]);

    expect(snapshot?.providerLabel).toBe("Codex");
    expect(snapshot?.windows).toEqual([
      {
        id: "codex-10080m",
        label: "Weekly",
        shortLabel: "Wk",
        usedPercent: 28,
        resetsAt: 1785475320,
        status: "ok",
      },
    ]);
  });

  it("derives both Codex windows when the session window is present", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1785475320 },
            secondary: { usedPercent: 96, windowDurationMins: 10080, resetsAt: 1785575320 },
          },
        },
      }),
    ]);

    expect(snapshot?.windows.map((w) => w.label)).toEqual(["Session (5h)", "Weekly"]);
    expect(snapshot?.status).toBe("critical");
    expect(snapshot?.constrainedWindow?.label).toBe("Weekly");
  });

  it("keeps one weekly Codex window when it moves from primary to secondary", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: 1785575320 },
          },
        },
      }),
      makeActivity(
        "a2",
        {
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1785475320 },
              secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1785575320 },
            },
          },
        },
        "2026-07-25T00:01:00.000Z",
      ),
    ]);

    expect(snapshot?.windows.map((window) => window.id)).toEqual(["codex-300m", "codex-10080m"]);
    expect(snapshot?.windows.find((window) => window.id === "codex-10080m")?.usedPercent).toBe(31);
  });

  it("suppresses Spark-tier Codex limits", () => {
    const spark = {
      limitId: "codex-spark",
      limitName: "GPT-5.3-Codex-Spark Weekly limit",
      primary: { usedPercent: 55, windowDurationMins: 10080, resetsAt: 1785475320 },
    };
    expect(
      deriveLatestProviderUsageSnapshot([
        makeActivity("a1", { rateLimits: { rateLimits: spark } }),
      ]),
    ).toBeNull();

    // A Spark snapshot must not shadow the real limit that arrived earlier.
    const snapshot = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: 1785475320 },
          },
        },
      }),
      makeActivity("a2", { rateLimits: { rateLimits: spark } }, "2026-07-25T00:01:00.000Z"),
    ]);
    expect(snapshot?.windows[0]?.usedPercent).toBe(28);
  });

  it("carries Codex limit identity across anonymous sparse updates", () => {
    const sparseWeekly = {
      primary: { usedPercent: 67, windowDurationMins: 10080, resetsAt: 1785475320 },
    };
    const afterSpark = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: {
          rateLimits: {
            limitId: "codex-spark",
            limitName: "Codex Spark weekly",
            primary: { usedPercent: 55, windowDurationMins: 10080, resetsAt: 1785475320 },
          },
        },
      }),
      makeActivity("a2", { rateLimits: { rateLimits: sparseWeekly } }, "2026-07-25T00:01:00.000Z"),
    ]);
    expect(afterSpark).toBeNull();

    const afterDefault = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: 1785475320 },
          },
        },
      }),
      makeActivity("a2", { rateLimits: { rateLimits: sparseWeekly } }, "2026-07-25T00:01:00.000Z"),
    ]);
    expect(afterDefault?.windows[0]?.usedPercent).toBe(67);

    const withoutNamedPredecessor = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", { rateLimits: { rateLimits: sparseWeekly } }),
    ]);
    expect(withoutNamedPredecessor?.windows[0]?.usedPercent).toBe(67);
  });

  it("escalates Codex windows when the provider reports the limit reached", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            rateLimitReachedType: "rate_limit_reached",
            primary: { usedPercent: 91, windowDurationMins: 10080, resetsAt: 1785475320 },
          },
        },
      }),
    ]);

    expect(snapshot?.status).toBe("critical");
  });

  it("applies a sparse Codex limit-reached update to retained windows", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 91, windowDurationMins: 10080, resetsAt: 1785475320 },
          },
        },
      }),
      makeActivity(
        "a2",
        { rateLimits: { rateLimits: { rateLimitReachedType: "rate_limit_reached" } } },
        "2026-07-25T00:01:00.000Z",
      ),
    ]);

    expect(snapshot?.status).toBe("critical");
    expect(snapshot?.windows[0]?.usedPercent).toBe(91);
    expect(snapshot?.updatedAt).toBe("2026-07-25T00:01:00.000Z");
  });

  it("filters events by the requested provider", () => {
    const activities = [
      claudeActivity("a1", {
        status: "allowed",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
        utilization: 0.8,
      }),
      makeActivity(
        "a2",
        {
          rateLimits: {
            rateLimits: {
              limitId: "codex",
              primary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: 1785475320 },
            },
          },
        },
        "2026-07-25T00:01:00.000Z",
      ),
    ];

    expect(
      deriveLatestProviderUsageSnapshot(activities, { provider: "claudeAgent" })?.providerLabel,
    ).toBe("Claude");
    expect(
      deriveLatestProviderUsageSnapshot(activities, { provider: "codex" })?.providerLabel,
    ).toBe("Codex");
    expect(deriveLatestProviderUsageSnapshot(activities, { provider: "cursor" })).toBeNull();
    expect(deriveLatestProviderUsageSnapshot(activities, { provider: "opencode" })).toBeNull();
  });

  it("filters and scopes snapshots by provider instance", () => {
    const activities = [
      makeActivity("a1", {
        providerInstanceId: "claude-personal",
        rateLimits: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.85,
          },
        },
      }),
      makeActivity(
        "a2",
        {
          providerInstanceId: "claude-work",
          rateLimits: {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed",
              rateLimitType: "five_hour",
              utilization: 0.25,
            },
          },
        },
        "2026-07-25T00:01:00.000Z",
      ),
    ];

    const snapshot = deriveLatestProviderUsageSnapshot(activities, {
      provider: "claudeAgent",
      providerInstanceId: "claude-personal",
    });
    expect(snapshot?.providerInstanceId).toBe("claude-personal");
    expect(snapshot?.windows[0]?.usedPercent).toBe(85);
  });

  it("does not carry Codex suppression identity across provider instances", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        providerInstanceId: "codex-personal",
        rateLimits: {
          rateLimits: {
            limitId: "codex-spark",
            primary: { usedPercent: 50, windowDurationMins: 10080 },
          },
        },
      }),
      makeActivity(
        "a2",
        {
          providerInstanceId: "codex-work",
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 22, windowDurationMins: 10080 },
            },
          },
        },
        "2026-07-25T00:01:00.000Z",
      ),
    ]);

    expect(snapshot?.providerInstanceId).toBe("codex-work");
    expect(snapshot?.windows[0]?.usedPercent).toBe(22);
  });

  it("returns null once the snapshot is a day old", () => {
    const activities = [
      claudeActivity(
        "a1",
        { status: "allowed", resetsAt: 1784970000, rateLimitType: "five_hour", utilization: 0.8 },
        "2026-07-24T00:00:00.000Z",
      ),
    ];

    expect(
      deriveLatestProviderUsageSnapshot(activities, {
        now: Date.parse("2026-07-25T00:00:00.000Z"),
      }),
    ).toBeNull();
    expect(
      deriveLatestProviderUsageSnapshot(activities, {
        now: Date.parse("2026-07-24T23:59:59.000Z"),
      }),
    ).not.toBeNull();
  });

  it("expires each merged window by its own source activity", () => {
    const snapshot = deriveLatestProviderUsageSnapshot(
      [
        claudeActivity(
          "a1",
          { status: "allowed", rateLimitType: "five_hour", utilization: 0.9 },
          "2026-07-23T23:59:59.000Z",
        ),
        claudeActivity(
          "a2",
          { status: "allowed", rateLimitType: "seven_day", utilization: 0.4 },
          "2026-07-25T00:01:00.000Z",
        ),
      ],
      { now: Date.parse("2026-07-25T00:00:00.000Z") },
    );

    expect(snapshot?.windows.map((window) => window.id)).toEqual(["seven_day"]);
    expect(snapshot?.updatedAt).toBe("2026-07-25T00:01:00.000Z");
  });

  it("selects the highest-status constrained window before comparing percentages", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed",
        rateLimitType: "seven_day",
        utilization: 0.7,
      }),
      claudeActivity(
        "a2",
        {
          status: "allowed_warning",
          rateLimitType: "five_hour",
        },
        "2026-07-25T00:01:00.000Z",
      ),
    ]);

    expect(snapshot?.status).toBe("warning");
    expect(snapshot?.constrainedWindow?.id).toBe("five_hour");
    expect(snapshot?.constrainedWindow?.usedPercent).toBeNull();
  });

  it("drops windows whose reset time has already passed", () => {
    const resetsAt = Math.floor(Date.parse("2026-07-25T01:00:00.000Z") / 1_000);
    const activities = [
      claudeActivity("a1", {
        status: "allowed",
        resetsAt,
        rateLimitType: "five_hour",
        utilization: 0.9,
      }),
    ];

    expect(
      deriveLatestProviderUsageSnapshot(activities, {
        now: Date.parse("2026-07-25T02:00:00.000Z"),
      }),
    ).toBeNull();
    expect(
      deriveLatestProviderUsageSnapshot(activities, {
        now: Date.parse("2026-07-25T00:30:00.000Z"),
      })?.windows,
    ).toHaveLength(1);
  });

  it("ignores activities of other kinds and malformed payloads", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      { ...makeActivity("a1", { usedTokens: 1 }), kind: "context-window.updated" },
      makeActivity("a2", "not-an-object"),
      makeActivity("a3", { rateLimits: {} }),
    ]);

    expect(snapshot).toBeNull();
  });
});

describe("collectProviderUsageAlerts", () => {
  const warningSnapshot = deriveLatestProviderUsageSnapshot([
    claudeActivity("a1", {
      status: "allowed",
      resetsAt: 1784970000,
      rateLimitType: "five_hour",
      utilization: 0.85,
    }),
  ]);

  it("fires a warning alert once per window per reset period", () => {
    const first = collectProviderUsageAlerts(warningSnapshot, new Set());
    expect(first).toHaveLength(1);
    expect(first[0]?.threshold).toBe("warning");

    const fired = new Set(first.flatMap((alert) => alert.keys));
    expect(collectProviderUsageAlerts(warningSnapshot, fired)).toHaveLength(0);
  });

  it("fires again after the window resets to a new period", () => {
    const fired = new Set(
      collectProviderUsageAlerts(warningSnapshot, new Set()).flatMap((alert) => alert.keys),
    );
    const nextPeriod = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed",
        resetsAt: 1784988000,
        rateLimitType: "five_hour",
        utilization: 0.85,
      }),
    ]);

    expect(collectProviderUsageAlerts(nextPeriod, fired)).toHaveLength(1);
  });

  it("collapses a jump past both thresholds into one critical alert", () => {
    const criticalSnapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
        utilization: 0.97,
      }),
    ]);

    const alerts = collectProviderUsageAlerts(criticalSnapshot, new Set());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.threshold).toBe("critical");
    // The skipped warning key is marked too, so no late warning ever fires.
    expect(alerts[0]?.keys).toHaveLength(2);

    const fired = new Set(alerts.flatMap((alert) => alert.keys));
    expect(collectProviderUsageAlerts(criticalSnapshot, fired)).toHaveLength(0);
    expect(collectProviderUsageAlerts(warningSnapshot, fired)).toHaveLength(0);
  });

  it("escalates from warning to critical as usage grows", () => {
    const fired = new Set(
      collectProviderUsageAlerts(warningSnapshot, new Set()).flatMap((alert) => alert.keys),
    );
    const criticalSnapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
        utilization: 0.96,
      }),
    ]);

    const alerts = collectProviderUsageAlerts(criticalSnapshot, fired);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.threshold).toBe("critical");
  });

  it("builds stable keys", () => {
    const window = warningSnapshot?.windows[0];
    expect(window).toBeDefined();
    if (!window) return;
    expect(providerUsageAlertKey("Claude", window, "warning")).toBe(
      "Claude:five_hour:warning:1784970000",
    );
    expect(providerUsageAlertKey("Claude", window, "warning", "claude-work")).toBe(
      "Claude@claude-work:five_hour:warning:1784970000",
    );
  });
});
