import { USAGE_CONTRACT_VERSION, type UsageDay, type UsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyEnvironmentUsage,
  usageProgress,
  type EnvironmentUsageState,
} from "./usageCoverage";

const SUMMARY: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-07T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: "2026-08-01" as UsageDay,
  untilDay: "2026-08-31" as UsageDay,
  buckets: [],
  sources: [],
  pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
  scanDurationMs: 1,
};

describe("classifyEnvironmentUsage", () => {
  it("treats unanswered disconnected environments as terminally unreachable", () => {
    for (const phase of ["available", "offline", "reconnecting", "error"] as const) {
      expect(classifyEnvironmentUsage({ phase, failed: false, summary: null })).toEqual({
        kind: "unreachable",
      });
    }
  });

  it("keeps waiting only while an environment can answer", () => {
    for (const phase of ["connected", "connecting"] as const) {
      expect(classifyEnvironmentUsage({ phase, failed: false, summary: null })).toEqual({
        kind: "reporting",
      });
    }
  });

  it("preserves failures and cached summaries as terminal results", () => {
    expect(classifyEnvironmentUsage({ phase: "connected", failed: true, summary: null })).toEqual({
      kind: "failed",
    });
    expect(classifyEnvironmentUsage({ phase: "offline", failed: false, summary: SUMMARY })).toEqual(
      { kind: "reported", summary: SUMMARY },
    );
  });
});

describe("usageProgress", () => {
  const reported: EnvironmentUsageState = { kind: "reported", summary: SUMMARY };
  const reporting: EnvironmentUsageState = { kind: "reporting" };
  const unreachable: EnvironmentUsageState = { kind: "unreachable" };
  const failed: EnvironmentUsageState = { kind: "failed" };

  it("does not wait for unreachable or failed environments", () => {
    expect(usageProgress([reported, unreachable, failed])).toEqual({
      isPending: false,
      isPartial: false,
    });
    expect(usageProgress([unreachable, failed])).toEqual({
      isPending: false,
      isPartial: false,
    });
  });

  it("is pending until the first answer and partial until the last", () => {
    expect(usageProgress([reporting, unreachable])).toEqual({
      isPending: true,
      isPartial: false,
    });
    expect(usageProgress([reported, reporting])).toEqual({
      isPending: false,
      isPartial: true,
    });
  });
});
