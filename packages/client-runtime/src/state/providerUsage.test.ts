import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProviderUsageThresholds,
  collectProviderUsageAlerts,
  deriveLatestProviderUsageSnapshot,
  deriveProviderUsageAccountsFromServerSnapshot,
  deriveProviderUsageSnapshotFromServerSnapshot,
  featuredProviderUsageAccount,
  normalizeProviderUsageThresholds,
  presentProviderUsageAccount,
  primaryProviderUsageWindow,
  providerUsageAlertKey,
  providerUsageFableWindow,
  providerUsageRingStatus,
  resolveProviderUsageFableRing,
  resolveProviderUsageModel,
  resolveProviderUsageUpstreamProvider,
  resolveProviderUsageInstanceId,
  selectProviderUsageFableAccount,
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
    expect(snapshot?.windows).toEqual([
      {
        id: "five_hour",
        group: "session",
        label: "Session (5h)",
        shortLabel: "5h",
        usedPercent: 42,
        resetsAt: 1784970000,
        status: "ok",
        reportedStatus: "ok",
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

  it("lets a newer numberless allowed Claude event clear an older window", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity(
        "a1",
        {
          status: "allowed_warning",
          resetsAt: 1784970000,
          rateLimitType: "five_hour",
          utilization: 0.85,
        },
        "2026-07-25T00:00:00.000Z",
      ),
      claudeActivity(
        "a2",
        {
          status: "allowed",
          resetsAt: 1784970000,
          rateLimitType: "five_hour",
        },
        "2026-07-25T00:01:00.000Z",
      ),
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
        group: "weekly",
        label: "Weekly (all models)",
        shortLabel: "Wk",
        usedPercent: 90,
        resetsAt: 1784970000,
        status: "warning",
        reportedStatus: "ok",
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
        group: "weekly",
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

  it("recognizes every non-null Codex exhaustion type", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            rateLimitReachedType: "workspace_member_usage_limit_reached",
            primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1785475320 },
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

  it("preserves Codex exhaustion across sparse updates in the same reset period", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            rateLimitReachedType: "workspace_owner_credits_depleted",
            primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1785475320 },
          },
        },
      }),
      makeActivity(
        "a2",
        {
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: 1785475320 },
            },
          },
        },
        "2026-07-25T00:01:00.000Z",
      ),
    ]);

    expect(snapshot?.windows[0]?.usedPercent).toBe(41);
    expect(snapshot?.status).toBe("critical");
  });

  it("clears inherited Codex exhaustion when a known reset period changes", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            rateLimitReachedType: "workspace_owner_credits_depleted",
            primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1785475320 },
          },
        },
      }),
      makeActivity(
        "a2",
        {
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1786080120 },
            },
          },
        },
        "2026-07-25T00:01:00.000Z",
      ),
    ]);

    expect(snapshot?.status).toBe("ok");
  });

  it("expires inherited Codex exhaustion independently of a fresh sparse window", () => {
    const snapshot = deriveLatestProviderUsageSnapshot(
      [
        makeActivity(
          "a1",
          {
            rateLimits: {
              rateLimits: {
                limitId: "codex",
                rateLimitReachedType: "workspace_owner_credits_depleted",
                primary: { usedPercent: 40, windowDurationMins: 10080 },
              },
            },
          },
          "2026-07-23T00:00:00.000Z",
        ),
        makeActivity(
          "a2",
          {
            rateLimits: {
              rateLimits: {
                primary: { usedPercent: 41, windowDurationMins: 10080 },
              },
            },
          },
          "2026-07-25T00:00:00.000Z",
        ),
      ],
      { now: Date.parse("2026-07-25T00:01:00.000Z") },
    );

    expect(snapshot?.status).toBe("ok");
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

  describe("Claude structured /usage payloads", () => {
    // Captured live from the SDK usage API (subscription_type "max").
    function usageActivity(
      id: string,
      rateLimits: Record<string, unknown>,
      createdAt?: string,
    ): OrchestrationThreadActivity {
      return makeActivity(
        id,
        { rateLimits: { source: "claude.usage-api", subscriptionType: "max", rateLimits } },
        createdAt,
      );
    }

    const LIVE_LIMITS = {
      limits: [
        {
          kind: "session",
          group: "session",
          percent: 3,
          severity: "normal",
          resets_at: "2026-07-26T07:00:00.990433+00:00",
          scope: null,
          is_active: false,
        },
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 24,
          severity: "normal",
          resets_at: "2026-07-31T02:59:59.990456+00:00",
          scope: null,
          is_active: false,
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 44,
          severity: "normal",
          resets_at: "2026-07-31T02:59:59.990712+00:00",
          scope: { model: { id: null, display_name: "Fable" }, surface: null },
          is_active: true,
        },
      ],
    };

    it("derives all three windows, labelling the model-scoped weekly one", () => {
      const snapshot = deriveLatestProviderUsageSnapshot([usageActivity("a1", LIVE_LIMITS)]);

      expect(snapshot?.providerLabel).toBe("Claude");
      expect(snapshot?.windows).toEqual([
        {
          id: "five_hour",
          group: "session",
          label: "Session (5h)",
          shortLabel: "5h",
          usedPercent: 3,
          resetsAt: Math.round(Date.parse("2026-07-26T07:00:00.990433+00:00") / 1_000),
          status: "ok",
          reportedStatus: "ok",
        },
        {
          id: "seven_day",
          group: "weekly",
          label: "Weekly (all models)",
          shortLabel: "Wk",
          usedPercent: 24,
          resetsAt: Math.round(Date.parse("2026-07-31T02:59:59.990456+00:00") / 1_000),
          status: "ok",
          reportedStatus: "ok",
        },
        {
          id: "seven_day_fable",
          group: "weekly",
          label: "Weekly (Fable)",
          shortLabel: "Fable",
          usedPercent: 44,
          resetsAt: Math.round(Date.parse("2026-07-31T02:59:59.990712+00:00") / 1_000),
          status: "ok",
          reportedStatus: "ok",
        },
      ]);
    });

    it("uses the highest window severity for the snapshot", () => {
      const limits = {
        limits: [
          { kind: "session", percent: 97, severity: "normal", resets_at: null, is_active: false },
          {
            kind: "weekly_scoped",
            percent: 85,
            severity: "normal",
            resets_at: null,
            scope: { model: { display_name: "Fable" } },
            is_active: true,
          },
        ],
      };
      const snapshot = deriveLatestProviderUsageSnapshot([usageActivity("a1", limits)]);

      expect(snapshot?.status).toBe("critical");
    });

    it("keeps the flat map usable when an empty limits array is also present", () => {
      const snapshot = deriveLatestProviderUsageSnapshot([
        usageActivity("a1", {
          limits: [],
          five_hour: { utilization: 42, resets_at: "2026-07-26T07:00:00Z" },
        }),
      ]);

      expect(snapshot?.windows.map((w) => w.id)).toEqual(["five_hour"]);
      expect(snapshot?.windows[0]?.usedPercent).toBe(42);
    });

    it("replaces windows from earlier events — the usage API is authoritative", () => {
      const snapshot = deriveLatestProviderUsageSnapshot([
        claudeActivity(
          "a1",
          {
            status: "allowed_warning",
            resetsAt: 1784970000,
            rateLimitType: "five_hour",
            utilization: 0.85,
          },
          "2026-07-25T00:00:00.000Z",
        ),
        usageActivity("a2", LIVE_LIMITS, "2026-07-25T00:01:00.000Z"),
      ]);

      expect(snapshot?.windows.map((w) => w.id)).toEqual([
        "five_hour",
        "seven_day",
        "seven_day_fable",
      ]);
      expect(snapshot?.status).toBe("ok");
    });

    it("merges a passive update into the matching authoritative window", () => {
      const snapshot = deriveLatestProviderUsageSnapshot([
        usageActivity(
          "a1",
          { limits: [{ kind: "session", percent: 3, resets_at: null }] },
          "2026-07-25T00:00:00.000Z",
        ),
        claudeActivity(
          "a2",
          {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.85,
          },
          "2026-07-25T00:01:00.000Z",
        ),
      ]);

      expect(snapshot?.windows).toHaveLength(1);
      expect(snapshot?.windows[0]?.id).toBe("five_hour");
      expect(snapshot?.windows[0]?.usedPercent).toBe(85);
    });

    it("lets an empty authoritative report clear older windows", () => {
      const snapshot = deriveLatestProviderUsageSnapshot([
        claudeActivity(
          "a1",
          {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.85,
          },
          "2026-07-25T00:00:00.000Z",
        ),
        usageActivity("a2", { limits: [] }, "2026-07-25T00:01:00.000Z"),
      ]);

      expect(snapshot).toBeNull();
    });

    it("recognizes versioned Fable display names", () => {
      const snapshot = deriveLatestProviderUsageSnapshot([
        usageActivity("a1", {
          limits: [
            {
              kind: "weekly_scoped",
              percent: 20,
              scope: { model: { display_name: "Fable 5" } },
            },
          ],
        }),
      ]);

      expect(providerUsageFableWindow(snapshot)?.shortLabel).toBe("Fable 5");
      expect(
        resolveProviderUsageFableRing({
          upstreamProvider: "claude",
          accounts: null,
          snapshot,
        }),
      ).toMatchObject({ accountName: "Claude", window: { shortLabel: "Fable 5" } });
      expect(
        resolveProviderUsageFableRing({ upstreamProvider: "codex", accounts: null, snapshot }),
      ).toBeNull();
    });

    it("keeps repeated scoped windows distinct using stable scope metadata", () => {
      const snapshot = deriveLatestProviderUsageSnapshot([
        usageActivity("a1", {
          limits: [
            {
              kind: "weekly_scoped",
              percent: 20,
              scope: { model: { id: "model-a", display_name: "Fable" } },
            },
            {
              kind: "weekly_scoped",
              percent: 40,
              scope: { model: { id: "model-b", display_name: "Fable" } },
            },
          ],
        }),
      ]);

      expect(snapshot?.windows.map((window) => window.id)).toEqual([
        "seven_day_fable:model-a",
        "seven_day_fable:model-b",
      ]);
    });

    it("reads the flat window map when no limits array is present", () => {
      const snapshot = deriveLatestProviderUsageSnapshot([
        usageActivity("a1", {
          five_hour: { utilization: 3, resets_at: "2026-07-26T07:00:00Z" },
          seven_day: { utilization: 88, resets_at: "2026-07-31T02:59:59Z" },
          // The always-null codenamed placeholders must not become rows.
          seven_day_opus: null,
          tangelo: null,
          nimbus_quill: null,
          extra_usage: { is_enabled: false, utilization: null },
        }),
      ]);

      expect(snapshot?.windows.map((w) => w.id)).toEqual(["five_hour", "seven_day"]);
      expect(snapshot?.status).toBe("warning");
    });

    it("escalates a window the provider marks critical", () => {
      const snapshot = deriveLatestProviderUsageSnapshot([
        usageActivity("a1", {
          limits: [{ kind: "session", percent: 20, severity: "critical", resets_at: null }],
        }),
      ]);

      expect(snapshot?.status).toBe("critical");
    });

    it("ignores usage payloads that carry no usable window", () => {
      expect(deriveLatestProviderUsageSnapshot([usageActivity("a1", { limits: [] })])).toBeNull();
      expect(
        deriveLatestProviderUsageSnapshot([
          usageActivity("a2", { limits: [{ kind: "session", percent: null }] }),
        ]),
      ).toBeNull();
    });

    it("is not mistaken for a Codex snapshot despite the nested rateLimits key", () => {
      const snapshot = deriveLatestProviderUsageSnapshot([usageActivity("a1", LIVE_LIMITS)], {
        provider: "claudeAgent",
      });

      expect(snapshot?.providerLabel).toBe("Claude");
    });
  });
});

describe("server-owned provider usage snapshots", () => {
  it("reuses the activity normalizer for opaque server payloads", () => {
    const payload = {
      source: "claude.usage-api",
      rateLimits: {
        limits: [
          {
            kind: "session",
            percent: 42,
            severity: "normal",
            resets_at: "2026-07-25T09:00:00.000Z",
            is_active: true,
          },
        ],
      },
    };
    const fromServer = deriveProviderUsageSnapshotFromServerSnapshot(
      {
        instanceId: ProviderInstanceId.make("claude-work"),
        payload,
        observedAt: Date.parse("2026-07-25T00:00:00.000Z"),
      },
      { provider: ProviderDriverKind.make("claudeAgent") },
    );
    const fromActivity = deriveLatestProviderUsageSnapshot(
      [makeActivity("server-parity", payload)],
      {
        provider: "claudeAgent",
        providerInstanceId: "claude-work",
      },
    );
    expect(fromServer?.windows[0]?.usedPercent).toBe(42);
    expect(fromServer).toEqual(fromActivity);
  });
});

describe("resolveProviderUsageUpstreamProvider", () => {
  it("resolves built-in and mapped custom models", () => {
    expect(
      resolveProviderUsageUpstreamProvider({
        payload: null,
        model: "claude-opus-5",
        isCustom: false,
        driver: ProviderDriverKind.make("claudeAgent"),
      }),
    ).toBe("claude");
    expect(
      resolveProviderUsageUpstreamProvider({
        payload: { modelProviders: { "gpt-5.6-sol": "codex" } },
        model: "gpt-5.6-sol",
        isCustom: true,
        driver: ProviderDriverKind.make("claudeAgent"),
      }),
    ).toBe("codex");
    expect(
      resolveProviderUsageUpstreamProvider({
        payload: { modelProviders: { "gpt-5.6-sol": "codex" } },
        model: "gpt-5.6-sol",
        isCustom: false,
        driver: ProviderDriverKind.make("claudeAgent"),
      }),
    ).toBe("codex");
    expect(
      resolveProviderUsageUpstreamProvider({
        payload: null,
        model: "gpt-5.6-sol",
        isCustom: false,
        driver: ProviderDriverKind.make("codex"),
      }),
    ).toBe("codex");
  });

  it("returns null for drivers without provider usage support", () => {
    for (const driver of [ProviderDriverKind.make("opencode"), null]) {
      expect(
        resolveProviderUsageUpstreamProvider({
          payload: null,
          model: "some-model",
          isCustom: false,
          driver,
        }),
      ).toBeNull();
    }
  });

  it("returns null for an unknown custom model or malformed mapping", () => {
    const resolve = (payload: unknown) =>
      resolveProviderUsageUpstreamProvider({
        payload,
        model: "gpt-5.6-sol",
        isCustom: true,
        driver: ProviderDriverKind.make("claudeAgent"),
      });
    expect(resolve({})).toBeNull();
    expect(resolve({ modelProviders: [] })).toBeNull();
    expect(resolve({ modelProviders: { "gpt-5.6-sol": 42 } })).toBeNull();
    expect(resolve({ modelProviders: { other: "codex" } })).toBeNull();
    expect(resolve(null)).toBeNull();
  });
});

describe("CLIProxyAPI gateway pool snapshots", () => {
  const gatewaySnapshot = {
    instanceId: ProviderInstanceId.make("claudeAgent_proxy"),
    payload: {
      source: "cliproxyapi.management",
      accounts: [
        {
          id: "claude-tier2.json",
          authIndex: "af6a89f7d2dec068",
          label: "second@example.com",
          provider: "claude",
          priority: 75,
          state: "available",
          usage: {
            source: "claude.usage-api",
            rateLimits: {
              limits: [{ kind: "session", percent: 12, resets_at: "2026-07-25T09:00:00.000Z" }],
            },
          },
        },
        {
          id: "claude-tier1.json",
          label: "first@example.com",
          provider: "claude",
          priority: 100,
          state: "cooldown",
          usage: {
            source: "claude.usage-api",
            rateLimits: {
              limits: [{ kind: "session", percent: 97, resets_at: "2026-07-25T09:00:00.000Z" }],
            },
          },
        },
        {
          id: "codex.json",
          label: "codex@example.com",
          provider: "codex",
          priority: 50,
          state: "available",
          planType: "pro",
          usage: {
            primary: { usedPercent: 33, windowDurationMins: 10_080, resetsAt: 1_784_970_000 },
          },
        },
        {
          id: "broken.json",
          label: "broken@example.com",
          provider: "claude",
          priority: 25,
          state: "available",
          usage: null,
          error: "auth token refresh failed",
        },
      ],
    },
    observedAt: Date.parse("2026-07-25T00:00:00.000Z"),
  };

  it("derives per-account usage across mixed upstream providers", () => {
    const pool = deriveProviderUsageAccountsFromServerSnapshot(gatewaySnapshot);
    expect(pool?.providerInstanceId).toBe("claudeAgent_proxy");
    expect(pool?.accounts).toHaveLength(4);
    const byId = new Map(pool?.accounts.map((account) => [account.id, account]));
    expect(byId.get("claude-tier2.json")?.usage?.windows[0]?.usedPercent).toBe(12);
    // The auth index joins a thread-account probe's answer; absence is null.
    expect(byId.get("claude-tier2.json")?.authIndex).toBe("af6a89f7d2dec068");
    expect(byId.get("claude-tier1.json")?.authIndex).toBeNull();
    expect(byId.get("claude-tier1.json")?.state).toBe("cooldown");
    expect(byId.get("codex.json")?.usage?.providerLabel).toBe("Codex");
    expect(byId.get("codex.json")?.planType).toBe("pro");
    expect(byId.get("broken.json")?.usage).toBeNull();
    expect(byId.get("broken.json")?.error).toBe("auth token refresh failed");
  });

  it("features the highest-priority available Claude account, skipping cooldowns", () => {
    const pool = deriveProviderUsageAccountsFromServerSnapshot(gatewaySnapshot);
    expect(featuredProviderUsageAccount(pool?.accounts ?? [])?.id).toBe("claude-tier2.json");
  });

  it("features the preferred upstream's account, and none when the upstream is unknown", () => {
    const pool = deriveProviderUsageAccountsFromServerSnapshot(gatewaySnapshot);
    expect(featuredProviderUsageAccount(pool?.accounts ?? [], "codex")?.id).toBe("codex.json");
    // A custom model on a mixed pool: nothing maps it to an account, so no
    // quota may be featured for it.
    expect(featuredProviderUsageAccount(pool?.accounts ?? [], null)).toBeNull();
  });

  it("never features disabled accounts", () => {
    const pool = deriveProviderUsageAccountsFromServerSnapshot(gatewaySnapshot);
    const base = pool?.accounts[0];
    expect(base).toBeDefined();
    expect(
      featuredProviderUsageAccount([
        ...(pool?.accounts ?? []),
        { ...base!, id: "disabled.json", priority: 1_000, state: "disabled" },
      ])?.id,
    ).toBe("claude-tier2.json");
  });

  it("selects the highest-priority available Fable account with headroom", () => {
    const pool = deriveProviderUsageAccountsFromServerSnapshot({
      ...gatewaySnapshot,
      payload: {
        source: "cliproxyapi.management",
        accounts: [
          {
            id: "exhausted.json",
            label: "exhausted@example.com",
            provider: "claude",
            priority: 100,
            state: "available",
            usage: {
              source: "claude.usage-api",
              rateLimits: {
                limits: [
                  {
                    kind: "weekly_scoped",
                    percent: 100,
                    scope: { model: { display_name: "Fable" } },
                  },
                ],
              },
            },
          },
          {
            id: "full-headroom.json",
            label: "full-headroom@example.com",
            provider: "claude",
            priority: 90,
            state: "available",
            usage: {
              source: "claude.usage-api",
              rateLimits: {
                limits: [{ kind: "session", percent: 10 }],
              },
            },
          },
          {
            id: "headroom.json",
            label: "headroom@example.com",
            provider: "claude",
            priority: 75,
            state: "available",
            usage: {
              source: "claude.usage-api",
              rateLimits: {
                limits: [
                  {
                    kind: "weekly_scoped",
                    percent: 42,
                    scope: { model: { display_name: "Fable" } },
                  },
                ],
              },
            },
          },
          {
            id: "lower-headroom.json",
            label: "lower-headroom@example.com",
            provider: "claude",
            priority: 50,
            state: "available",
            usage: {
              source: "claude.usage-api",
              rateLimits: {
                limits: [
                  {
                    kind: "weekly_scoped",
                    percent: 1,
                    scope: { model: { display_name: "Fable" } },
                  },
                ],
              },
            },
          },
          {
            id: "disabled.json",
            label: "disabled@example.com",
            provider: "claude",
            priority: 1_000,
            state: "disabled",
            usage: {
              source: "claude.usage-api",
              rateLimits: {
                limits: [
                  {
                    kind: "weekly_scoped",
                    percent: 1,
                    scope: { model: { display_name: "Fable" } },
                  },
                ],
              },
            },
          },
        ],
      },
    });

    expect(selectProviderUsageFableAccount(pool?.accounts ?? [])).toMatchObject({
      account: { id: "full-headroom.json" },
      window: { usedPercent: 0 },
    });
    expect(
      resolveProviderUsageFableRing({
        upstreamProvider: "claude",
        accounts: pool?.accounts ?? [],
        snapshot: null,
      }),
    ).toMatchObject({ accountName: "full-headroom@example.com", window: { usedPercent: 0 } });
  });

  it("falls back to the featured account's exhausted Fable window", () => {
    const pool = deriveProviderUsageAccountsFromServerSnapshot({
      ...gatewaySnapshot,
      payload: {
        source: "cliproxyapi.management",
        accounts: [
          {
            id: "featured.json",
            label: "featured@example.com",
            provider: "claude",
            priority: 100,
            state: "available",
            usage: {
              source: "claude.usage-api",
              rateLimits: {
                limits: [
                  {
                    kind: "weekly_scoped",
                    percent: 100,
                    scope: { model: { display_name: "Fable" } },
                  },
                ],
              },
            },
          },
        ],
      },
    });

    expect(selectProviderUsageFableAccount(pool?.accounts ?? [])).toMatchObject({
      account: { id: "featured.json" },
      window: { usedPercent: 100 },
    });
  });

  it("falls back to the highest-priority cooled-down account when the pool is exhausted", () => {
    const pool = deriveProviderUsageAccountsFromServerSnapshot({
      ...gatewaySnapshot,
      payload: {
        source: "cliproxyapi.management",
        accounts: (gatewaySnapshot.payload.accounts as ReadonlyArray<Record<string, unknown>>).map(
          (account) =>
            account.provider === "claude" ? { ...account, state: "cooldown" } : account,
        ),
      },
    });
    // The meter must render the exhausted pool as red, not vanish: the
    // highest-priority cooled-down account carries the closest reset time.
    expect(featuredProviderUsageAccount(pool?.accounts ?? [])?.id).toBe("claude-tier1.json");
  });

  it("keeps the highest-priority available Claude account featured when its usage read failed", () => {
    const pool = deriveProviderUsageAccountsFromServerSnapshot(gatewaySnapshot);
    const base = pool?.accounts[0];
    expect(base).toBeDefined();
    expect(
      featuredProviderUsageAccount([
        ...(pool?.accounts ?? []),
        { ...base!, id: "claude-featured-error.json", priority: 200, usage: null },
      ])?.id,
    ).toBe("claude-featured-error.json");
  });

  it("collapses to the featured account for single-account surfaces", () => {
    const snapshot = deriveProviderUsageSnapshotFromServerSnapshot(gatewaySnapshot, {
      provider: ProviderDriverKind.make("claudeAgent"),
    });
    expect(snapshot?.providerLabel).toBe("Claude");
    expect(snapshot?.windows[0]?.usedPercent).toBe(12);
  });

  it("returns null for non-gateway payloads", () => {
    expect(
      deriveProviderUsageAccountsFromServerSnapshot({
        instanceId: ProviderInstanceId.make("claude-work"),
        payload: { source: "claude.usage-api", rateLimits: { limits: [] } },
        observedAt: Date.parse("2026-07-25T00:00:00.000Z"),
      }),
    ).toBeNull();
  });
});

describe("resolveProviderUsageInstanceId", () => {
  it("prefers the live session instance after failover", () => {
    expect(
      resolveProviderUsageInstanceId({
        liveSessionInstanceId: "claude-failover",
        modelSelectionInstanceId: "claude-primary",
      }),
    ).toBe("claude-failover");
  });

  it("falls back to the picked model instance when no session is live", () => {
    expect(
      resolveProviderUsageInstanceId({
        liveSessionInstanceId: null,
        modelSelectionInstanceId: "codex-work",
      }),
    ).toBe("codex-work");
  });
});

describe("resolveProviderUsageModel", () => {
  it("keeps the persisted model while a live session owns usage", () => {
    expect(
      resolveProviderUsageModel({
        liveSessionInstanceId: "claude-proxy",
        persistedModel: "claude-opus-5",
        selectedModel: "gpt-5.6-sol",
      }),
    ).toBe("claude-opus-5");
  });

  it("uses the selected model before a live session exists", () => {
    expect(
      resolveProviderUsageModel({
        liveSessionInstanceId: null,
        persistedModel: "claude-opus-5",
        selectedModel: "gpt-5.6-sol",
      }),
    ).toBe("gpt-5.6-sol");
  });
});

describe("providerUsageRingStatus", () => {
  function claudeSnapshot(limits: ReadonlyArray<Record<string, unknown>>) {
    return deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: { source: "claude.usage-api", subscriptionType: "max", rateLimits: { limits } },
      }),
    ]);
  }

  it("stays calm for a spent window that is rendered separately", () => {
    const snapshot = claudeSnapshot([
      { kind: "session", percent: 3, resets_at: null },
      {
        kind: "weekly",
        percent: 100,
        resets_at: null,
        scope: { model: { display_name: "Fable" } },
      },
    ]);
    const fable = snapshot && providerUsageFableWindow(snapshot);

    expect(providerUsageRingStatus(snapshot, fable?.id ?? null)).toBe("ok");
  });

  it("reports a spent window that nothing else renders", () => {
    const snapshot = claudeSnapshot([
      { kind: "session", percent: 3, resets_at: null },
      { kind: "weekly_all", percent: 100, resets_at: null },
    ]);

    expect(providerUsageRingStatus(snapshot, null)).toBe("critical");
  });
});

describe("primaryProviderUsageWindow", () => {
  function usageApiSnapshot(limits: ReadonlyArray<Record<string, unknown>>) {
    return deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: { source: "claude.usage-api", subscriptionType: "max", rateLimits: { limits } },
      }),
    ]);
  }

  it("prefers the session window when one is reported", () => {
    const snapshot = usageApiSnapshot([
      { kind: "weekly_all", percent: 24, resets_at: null },
      { kind: "session", percent: 3, resets_at: null },
    ]);

    expect(snapshot && primaryProviderUsageWindow(snapshot)?.label).toBe("Session (5h)");
  });

  it("falls back to the weekly window when no session window exists", () => {
    // Codex reports weekly-only today; the ring must still show something.
    const snapshot = deriveLatestProviderUsageSnapshot([
      makeActivity("a1", {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: 1785475320 },
          },
        },
      }),
    ]);

    expect(snapshot && primaryProviderUsageWindow(snapshot)?.label).toBe("Weekly");
  });

  it("keeps the session window when a Fable window is constrained", () => {
    const snapshot = usageApiSnapshot([
      { kind: "session", percent: 3, resets_at: null },
      {
        kind: "weekly_scoped",
        percent: 96,
        resets_at: null,
        scope: { model: { display_name: "Fable" } },
      },
    ]);

    expect(snapshot && primaryProviderUsageWindow(snapshot)?.label).toBe("Session (5h)");
  });

  it("returns null for a snapshot with no windows", () => {
    expect(
      primaryProviderUsageWindow({
        providerLabel: "Claude",
        providerInstanceId: null,
        windows: [],
        status: "ok",
        updatedAt: "2026-07-25T00:00:00.000Z",
      }),
    ).toBeNull();
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

  it("fires a numberless provider warning", () => {
    const snapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed_warning",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
      }),
    ]);

    expect(collectProviderUsageAlerts(snapshot, new Set())).toHaveLength(1);
  });

  it("fires a warning alert once per window per reset period", () => {
    const first = collectProviderUsageAlerts(warningSnapshot, new Set());
    expect(first).toHaveLength(1);

    const fired = new Set(first.map((alert) => alert.key));
    expect(collectProviderUsageAlerts(warningSnapshot, fired)).toHaveLength(0);
  });

  it("fires again after the window resets to a new period", () => {
    const fired = new Set(
      collectProviderUsageAlerts(warningSnapshot, new Set()).map((alert) => alert.key),
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

  it("de-duplicates within an environment without suppressing another environment", () => {
    const environmentA = collectProviderUsageAlerts(warningSnapshot, new Set(), "environment-a");
    const fired = new Set(environmentA.map((alert) => alert.key));

    expect(collectProviderUsageAlerts(warningSnapshot, fired, "environment-a")).toHaveLength(0);
    expect(collectProviderUsageAlerts(warningSnapshot, fired, "environment-b")).toHaveLength(1);
  });

  it("keeps the warning alert when usage jumps past the configured critical threshold", () => {
    const criticalSnapshot = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
        utilization: 0.97,
      }),
    ]);

    expect(collectProviderUsageAlerts(criticalSnapshot, new Set())).toHaveLength(1);
  });

  it("does not alert after the limit is reached or the provider rejects usage", () => {
    const reached = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
        utilization: 1,
      }),
    ]);
    const rejected = deriveLatestProviderUsageSnapshot([
      claudeActivity("a2", {
        status: "rejected",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
      }),
    ]);

    expect(collectProviderUsageAlerts(reached, new Set())).toHaveLength(0);
    expect(collectProviderUsageAlerts(rejected, new Set())).toHaveLength(0);
  });

  it("builds stable keys", () => {
    const window = warningSnapshot?.windows[0];
    expect(window).toBeDefined();
    if (!window) return;
    expect(providerUsageAlertKey("Claude", window)).toBe("Claude:five_hour:warning:1784970000");
    expect(providerUsageAlertKey("Claude", window, "claude-work")).toBe(
      "Claude@claude-work:five_hour:warning:1784970000",
    );
    expect(providerUsageAlertKey("Claude", window, "claude-work", "environment-a")).toBe(
      "environment-a:Claude@claude-work:five_hour:warning:1784970000",
    );
    expect(providerUsageAlertKey("Claude", window, "claude-work", "environment-b")).not.toBe(
      providerUsageAlertKey("Claude", window, "claude-work", "environment-a"),
    );
  });
});

describe("provider usage thresholds", () => {
  const snapshotAt = (utilization: number) =>
    deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "allowed",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
        utilization,
      }),
    ]);

  it("normalizes out-of-range and inverted thresholds", () => {
    expect(normalizeProviderUsageThresholds(undefined)).toEqual({
      warningPercent: 80,
      criticalPercent: 95,
    });
    expect(normalizeProviderUsageThresholds({ warningPercent: 0, criticalPercent: 400 })).toEqual({
      warningPercent: 1,
      criticalPercent: 100,
    });
    // A warning above critical would mask the critical state entirely.
    expect(normalizeProviderUsageThresholds({ warningPercent: 90, criticalPercent: 60 })).toEqual({
      warningPercent: 60,
      criticalPercent: 60,
    });
    expect(
      normalizeProviderUsageThresholds({ warningPercent: Number.NaN, criticalPercent: 70 }),
    ).toEqual({ warningPercent: 70, criticalPercent: 70 });
  });

  it("derives severities against caller thresholds", () => {
    const snapshot = deriveLatestProviderUsageSnapshot(
      [
        claudeActivity("a1", {
          status: "allowed",
          resetsAt: 1784970000,
          rateLimitType: "five_hour",
          utilization: 0.55,
        }),
      ],
      { thresholds: { warningPercent: 50, criticalPercent: 90 } },
    );
    expect(snapshot?.status).toBe("warning");
  });

  it("re-evaluates an existing snapshot without re-deriving it", () => {
    const snapshot = snapshotAt(0.5);
    expect(snapshot?.status).toBe("ok");
    expect(applyProviderUsageThresholds(snapshot, { warningPercent: 40 })?.status).toBe("warning");
    expect(
      applyProviderUsageThresholds(snapshot, { warningPercent: 20, criticalPercent: 40 })?.status,
    ).toBe("critical");
    // Relaxing the thresholds calms the same snapshot back down.
    expect(applyProviderUsageThresholds(snapshotAt(0.85), { warningPercent: 90 })?.status).toBe(
      "ok",
    );
    expect(applyProviderUsageThresholds(null, undefined)).toBeNull();
  });

  it("never softens a severity the provider itself reported", () => {
    const rejected = deriveLatestProviderUsageSnapshot([
      claudeActivity("a1", {
        status: "rejected",
        resetsAt: 1784970000,
        rateLimitType: "five_hour",
        utilization: 0.2,
      }),
    ]);
    expect(
      applyProviderUsageThresholds(rejected, { warningPercent: 99, criticalPercent: 100 })?.status,
    ).toBe("critical");
  });
});

describe("presentProviderUsageAccount", () => {
  const account = {
    id: "codex-6c16ddf1-bbdecyk@gmail.com-pro.json",
    authIndex: null,
    label: "bbdecyk@gmail.com",
    provider: "codex",
    priority: 50,
    state: "available",
    planType: "pro",
    error: null,
    usage: null,
  } as const;

  it("names the account by its upstream provider, not its auth file", () => {
    expect(presentProviderUsageAccount(account)).toMatchObject({
      displayName: "Codex",
      email: "bbdecyk@gmail.com",
      detail: "tier 50 · pro",
      provider: "codex",
    });
  });

  it("keeps a non-email label, which is the only thing identifying the account", () => {
    expect(presentProviderUsageAccount({ ...account, label: "work pool" })).toMatchObject({
      displayName: "Codex",
      email: undefined,
      detail: "work pool · tier 50 · pro",
    });
  });

  it("reports a failed read separately from the metadata line", () => {
    expect(
      presentProviderUsageAccount({ ...account, state: "cooldown", error: "quota exceeded" }),
    ).toMatchObject({ detail: "tier 50 · cooldown · pro", error: "quota exceeded" });
  });

  it("drops a stale error once the account reports usage again", () => {
    expect(
      presentProviderUsageAccount({
        ...account,
        error: "quota exceeded",
        usage: {
          providerLabel: "Codex",
          providerInstanceId: null,
          windows: [],
          status: "ok",
          updatedAt: "2026-08-14T00:00:00.000Z",
        },
      }).error,
    ).toBeNull();
  });
});
