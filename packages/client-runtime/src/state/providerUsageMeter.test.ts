import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceUsageSnapshot,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderUsageSnapshotFromUsageLimits,
  primaryProviderUsageWindow,
  providerUsageRingStatus,
} from "./providerUsage.ts";
import { resolveProviderUsageMeter } from "./providerUsageMeter.ts";

const NOW = Date.parse("2026-07-25T00:00:00.000Z");
const CHECKED_AT = "2026-07-24T23:58:00.000Z";
const RESETS_AT = "2026-07-25T04:00:00.000Z";

function limits(windows: ServerProviderUsageLimits["windows"]): ServerProviderUsageLimits {
  return { checkedAt: CHECKED_AT, windows };
}

const claudeLimits = limits([
  { id: "five_hour", kind: "session", label: "Session", usedPercent: 42, resetsAt: RESETS_AT },
  { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 85, resetsAt: RESETS_AT },
  {
    id: "seven_day_fable",
    kind: "weekly",
    label: "Weekly · Fable",
    usedPercent: 97,
    resetsAt: RESETS_AT,
  },
]);

function provider(
  instanceId: string,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: CHECKED_AT,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("deriveProviderUsageSnapshotFromUsageLimits", () => {
  it("labels typed Claude windows with the meter taxonomy and threshold statuses", () => {
    const snapshot = deriveProviderUsageSnapshotFromUsageLimits(claudeLimits, {
      provider: "claudeAgent",
      providerInstanceId: "claudeAgent",
      now: NOW,
    });
    expect(snapshot?.providerLabel).toBe("Claude");
    expect(
      snapshot?.windows.map(({ id, group, label, shortLabel, status }) => ({
        id,
        group,
        label,
        shortLabel,
        status,
      })),
    ).toEqual([
      { id: "five_hour", group: "session", label: "Session (5h)", shortLabel: "5h", status: "ok" },
      {
        id: "seven_day",
        group: "weekly",
        label: "Weekly (all models)",
        shortLabel: "Wk",
        status: "warning",
      },
      {
        id: "seven_day_fable",
        group: "weekly",
        label: "Weekly (Fable)",
        shortLabel: "Fable",
        status: "critical",
      },
    ]);
    expect(snapshot?.status).toBe("critical");
    expect(snapshot?.windows[0]?.resetsAt).toBe(Date.parse(RESETS_AT) / 1_000);
  });

  it("labels Codex windows by duration", () => {
    const snapshot = deriveProviderUsageSnapshotFromUsageLimits(
      limits([
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 33,
          windowDurationMins: 10_080,
        },
      ]),
      { provider: "codex", now: NOW },
    );
    expect(snapshot?.windows[0]).toMatchObject({
      group: "weekly",
      label: "Weekly",
      shortLabel: "Wk",
    });
  });

  it("drops windows whose reset passed, stale reports, and drivers without a meter", () => {
    const passed = limits([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 99,
        resetsAt: "2026-07-24T23:00:00.000Z",
      },
    ]);
    expect(
      deriveProviderUsageSnapshotFromUsageLimits(passed, { provider: "claudeAgent", now: NOW }),
    ).toBeNull();
    expect(
      deriveProviderUsageSnapshotFromUsageLimits(
        { ...claudeLimits, checkedAt: "2026-07-23T00:00:00.000Z" },
        { provider: "claudeAgent", now: NOW },
      ),
    ).toBeNull();
    expect(
      deriveProviderUsageSnapshotFromUsageLimits(claudeLimits, { provider: "cursor", now: NOW }),
    ).toBeNull();
  });

  it("feeds the compact ring: session value, colour from every other window", () => {
    const snapshot = deriveProviderUsageSnapshotFromUsageLimits(claudeLimits, {
      provider: "claudeAgent",
      now: NOW,
    });
    expect(snapshot && primaryProviderUsageWindow(snapshot)?.id).toBe("five_hour");
    expect(providerUsageRingStatus(snapshot, "seven_day_fable")).toBe("warning");
    expect(providerUsageRingStatus(snapshot)).toBe("critical");
  });

  it("honours custom thresholds", () => {
    const snapshot = deriveProviderUsageSnapshotFromUsageLimits(claudeLimits, {
      provider: "claudeAgent",
      now: NOW,
      thresholds: { warningPercent: 40, criticalPercent: 99 },
    });
    expect(snapshot?.windows.map((window) => window.status)).toEqual([
      "warning",
      "warning",
      "warning",
    ]);
  });
});

describe("resolveProviderUsageMeter", () => {
  const gatewayInstanceId = ProviderInstanceId.make("claudeAgent_proxy");
  const gatewaySnapshot: ProviderInstanceUsageSnapshot = {
    instanceId: gatewayInstanceId,
    payload: {
      source: "cliproxyapi.management",
      accounts: [
        {
          id: "tier2.json",
          authIndex: "idx-2",
          label: "second@example.com",
          provider: "claude",
          priority: 75,
          state: "available",
          usage: {
            source: "claude.usage-api",
            rateLimits: { limits: [{ kind: "session", percent: 12, resets_at: RESETS_AT }] },
          },
        },
        {
          id: "tier1.json",
          authIndex: "idx-1",
          label: "first@example.com",
          provider: "claude",
          priority: 100,
          state: "available",
          usage: {
            source: "claude.usage-api",
            rateLimits: { limits: [{ kind: "session", percent: 50, resets_at: RESETS_AT }] },
          },
        },
        {
          id: "off.json",
          label: "off@example.com",
          provider: "claude",
          priority: 10,
          state: "disabled",
          usage: null,
        },
      ],
    },
    observedAt: NOW - 30_000,
  };
  const providers = [
    provider("claudeAgent", "claudeAgent", {
      displayName: "Personal",
      auth: { status: "authenticated", email: "me@example.com" },
      usageLimits: claudeLimits,
    }),
    provider("claudeAgent_work", "claudeAgent", {
      usageLimits: { ...claudeLimits, windows: [], unavailable: { reason: "probeFailed" } },
    }),
    provider("claudeAgent_off", "claudeAgent", { enabled: false, usageLimits: claudeLimits }),
    provider("codex", "codex", { usageLimits: claudeLimits }),
    provider("claudeAgent_proxy", "claudeAgent", {
      displayName: "Proxy",
      // The proxy login's own limits never stand in for the pool.
      usageLimits: claudeLimits,
    }),
  ];

  it("meters a direct thread's account and its enabled same-driver siblings from typed limits", () => {
    const meter = resolveProviderUsageMeter({
      providers,
      snapshots: [gatewaySnapshot],
      activeInstanceId: ProviderInstanceId.make("claudeAgent_work"),
      activeModel: "claude-opus-4-8",
      threadId: "thread-1",
      threadAccount: null,
      now: NOW,
    });
    expect(meter.gateway).toBe(false);
    expect(meter.label).toBe("Claude");
    expect(meter.accounts.map((account) => [account.instanceId, account.isCurrent])).toEqual([
      ["claudeAgent_work", true],
      ["claudeAgent", false],
    ]);
    expect(meter.accounts[0]?.usage).toBeNull();
    expect(meter.accounts[0]?.error).toBe("Couldn't read usage");
    expect(meter.accounts[1]).toMatchObject({
      displayName: "Personal",
      email: "me@example.com",
      observedAt: Date.parse(CHECKED_AT),
    });
    expect(meter.activeUsage).toBeNull();
    expect(meter.directInstanceIds).toEqual(["claudeAgent_work", "claudeAgent"]);
  });

  it("puts the active direct account's Fable window on the Fable ring", () => {
    const meter = resolveProviderUsageMeter({
      providers,
      snapshots: [],
      activeInstanceId: ProviderInstanceId.make("claudeAgent"),
      activeModel: "claude-opus-4-8",
      threadId: "thread-1",
      threadAccount: null,
      now: NOW,
    });
    expect(meter.activeUsage?.windows).toHaveLength(3);
    expect(meter.fable).toMatchObject({ accountName: "Claude", window: { id: "seven_day_fable" } });
  });

  it("meters a gateway thread from its pool, featuring the next account until a binding is known", () => {
    const meter = resolveProviderUsageMeter({
      providers,
      snapshots: [gatewaySnapshot],
      activeInstanceId: gatewayInstanceId,
      activeModel: "claude-opus-4-8",
      threadId: "thread-1",
      threadAccount: null,
      now: NOW,
    });
    expect(meter.gateway).toBe(true);
    expect(meter.label).toBe("Proxy");
    expect(meter.directInstanceIds).toEqual([]);
    expect(
      meter.accounts.map((account) => [account.email, account.isCurrent, account.isNext]),
    ).toEqual([
      ["first@example.com", false, true],
      ["second@example.com", false, false],
    ]);
    expect(meter.activeUsage?.windows[0]?.usedPercent).toBe(50);
    // No pooled Fable window means full headroom on the next Claude account.
    expect(meter.fable).toMatchObject({
      accountName: "first@example.com",
      window: { usedPercent: 0 },
    });
  });

  it("marks the bound pooled account current once the thread's binding is known", () => {
    const meter = resolveProviderUsageMeter({
      providers,
      snapshots: [gatewaySnapshot],
      activeInstanceId: gatewayInstanceId,
      activeModel: "claude-opus-4-8",
      threadId: "thread-1",
      threadAccount: { threadId: "thread-1", model: "claude-opus-4-8", authIndex: "idx-2" },
      now: NOW,
    });
    expect(
      meter.accounts.map((account) => [account.email, account.isCurrent, account.isNext]),
    ).toEqual([
      ["first@example.com", false, true],
      ["second@example.com", true, false],
    ]);
  });

  it("shows a placeholder row for a gateway instance whose pool was not read yet", () => {
    const meter = resolveProviderUsageMeter({
      providers,
      snapshots: [],
      activeInstanceId: gatewayInstanceId,
      activeModel: "claude-opus-4-8",
      isGatewayInstance: (instanceId) => instanceId === gatewayInstanceId,
      threadId: "thread-1",
      threadAccount: null,
      now: NOW,
    });
    expect(meter.gateway).toBe(true);
    expect(meter.activeUsage).toBeNull();
    expect(meter.accounts).toEqual([
      expect.objectContaining({ instanceId: gatewayInstanceId, usage: null, isCurrent: true }),
    ]);
  });

  it("renders nothing for providers without machine-readable quota", () => {
    const meter = resolveProviderUsageMeter({
      providers: [provider("cursor", "cursor", { usageLimits: claudeLimits })],
      snapshots: [],
      activeInstanceId: ProviderInstanceId.make("cursor"),
      activeModel: "auto",
      threadId: undefined,
      threadAccount: null,
      now: NOW,
    });
    expect(meter.accounts).toEqual([]);
    expect(meter.activeUsage).toBeNull();
  });
});
