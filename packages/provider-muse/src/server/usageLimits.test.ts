import { describe, expect, it } from "@effect/vitest";

import type { MuseSubscriptionUsage } from "./protocol.ts";
import {
  isMuseUsageLimitFailure,
  museUsageLimitResetAt,
  museUsageOutputToLimits,
} from "./usageLimits.ts";

const usage = {
  observedAtMs: 1791447762610,
  tier: "tier-1",
  window: { usedPercent: 0, windowDurationMins: 300, resetsAtMs: 1791465557000 },
  weekly: { usedPercent: 5, resetsAtMs: 1791763200000 },
} satisfies MuseSubscriptionUsage;
const nowMs = usage.observedAtMs;
const realRefusal =
  "API error 429: All credentials for model muse-wonder-1.0-contributor are cooling down (last error: rate_limit_exceeded: Subscription quota exhausted. Your usage window resets at 2026-10-13T10:45:52Z.) (after 10 provider attempts)";

describe("Muse usage limit failures", () => {
  it("recognizes Meta's quota refusal and no other failure", () => {
    expect(
      isMuseUsageLimitFailure(
        "API error 429: Subscription quota exhausted. Your usage window resets soon. (rate_limit_error)",
      ),
    ).toBe(true);
    expect(isMuseUsageLimitFailure(realRefusal)).toBe(true);
    expect(isMuseUsageLimitFailure("API error 429: Rate limit exceeded. (rate_limit_error)")).toBe(
      false,
    );
    expect(isMuseUsageLimitFailure("Subscription quota exhausted.")).toBe(false);
    expect(isMuseUsageLimitFailure(undefined)).toBe(false);
  });

  it("resumes once every exhausted window has reset", () => {
    const sessionOut = { ...usage, window: { ...usage.window, usedPercent: 103 } };
    expect(museUsageLimitResetAt(sessionOut, nowMs)).toBe("2026-10-08T13:19:17.000Z");
    const bothOut = { ...sessionOut, weekly: { ...usage.weekly, usedPercent: 100 } };
    expect(museUsageLimitResetAt(bothOut, nowMs)).toBe("2026-10-12T00:00:00.000Z");
  });

  it("takes the reset a refusal names or types when no report has one", () => {
    expect(museUsageLimitResetAt(undefined, nowMs, { message: realRefusal })).toBe(
      "2026-10-13T10:45:52.000Z",
    );
    const quota = { resetsAtMs: usage.window.resetsAtMs };
    expect(museUsageLimitResetAt(usage, nowMs, { quota })).toBe("2026-10-08T13:19:17.000Z");
    const weeklyOut = { ...usage, weekly: { ...usage.weekly, usedPercent: 100 } };
    expect(museUsageLimitResetAt(weeklyOut, nowMs, { quota })).toBe("2026-10-12T00:00:00.000Z");
  });

  it("has no reset time unless a report shows a used-up window that resets later", () => {
    expect(museUsageLimitResetAt(undefined, nowMs)).toBeNull();
    expect(museUsageLimitResetAt(usage, nowMs)).toBeNull();
    const sessionOut = { ...usage, window: { ...usage.window, usedPercent: 100 } };
    expect(museUsageLimitResetAt(sessionOut, usage.window.resetsAtMs)).toBeNull();
    const afterNamedReset = Date.parse("2026-10-14T00:00:00Z");
    expect(museUsageLimitResetAt(undefined, afterNamedReset, { message: realRefusal })).toBeNull();
  });
});

describe("museUsageOutputToLimits", () => {
  const checkedAt = "2026-10-31T04:45:00.000Z";

  it("reads `muse usage --json` windows, clamping Meta's over-quota percentages", () => {
    const output = JSON.stringify({
      schemaVersion: 1,
      allowance: {
        tier: "Muse Code Power Usage",
        window: { usedPercent: 112, resetsAtMs: 1793439239000 },
        weekly: { usedPercent: 4, resetsAtMs: 1793577600000 },
        asOfMs: 1793421633517,
        source: "mint",
      },
      reason: null,
      hint: null,
    });
    expect(museUsageOutputToLimits(output, checkedAt)).toEqual({
      checkedAt: "2026-10-31T04:40:33.517Z",
      windows: [
        {
          id: "muse-window",
          kind: "session",
          label: "Session",
          usedPercent: 100,
          resetsAt: "2026-10-31T09:33:59.000Z",
        },
        {
          id: "muse-weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 4,
          resetsAt: "2026-11-02T00:00:00.000Z",
        },
      ],
    });
  });

  it("separates accounts without an allowance from failed reads", () => {
    const noAllowance = (reason: string) =>
      museUsageOutputToLimits(JSON.stringify({ allowance: null, reason }), checkedAt).unavailable
        ?.reason;
    expect(noAllowance("api_key")).toBe("unsupported");
    expect(noAllowance("no_allowance")).toBe("unsupported");
    expect(noAllowance("server_sent_no_usage")).toBe("probeFailed");
    expect(noAllowance("constructor")).toBe("probeFailed");
    expect(
      museUsageOutputToLimits("muse: usage refresh rate-limited", checkedAt).unavailable?.reason,
    ).toBe("probeFailed");
  });
});
