import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderUsageAccountsFromServerSnapshot,
  deriveProviderUsageSnapshotFromServerSnapshot,
  featuredProviderUsageAccount,
  normalizeProviderUsageThresholds,
  presentProviderUsageAccount,
  resolveProviderUsageFableRing,
  resolveProviderUsageModel,
  resolveProviderUsageUpstreamProvider,
  resolveProviderUsageInstanceId,
  selectProviderUsageFableAccount,
} from "./providerUsage.ts";

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
  it("prefers the live session instance over the picked model instance", () => {
    expect(
      resolveProviderUsageInstanceId({
        liveSessionInstanceId: "claude-switched",
        modelSelectionInstanceId: "claude-primary",
      }),
    ).toBe("claude-switched");
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

describe("provider usage thresholds", () => {
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
