import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentUsageStatus } from "../../state/usage";
import { UsageCoverageNotice } from "./UsagePage";

const SUMMARY: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-09T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: "2026-08-01" as UsageDay,
  untilDay: "2026-08-09" as UsageDay,
  buckets: [],
  sources: [],
  pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
  scanDurationMs: 1,
};

function environment(
  environmentId: string,
  label: string,
  state: EnvironmentUsageStatus["state"],
): EnvironmentUsageStatus {
  return { environmentId: environmentId as EnvironmentId, label, state };
}

describe("UsageCoverageNotice", () => {
  it("shows partial source messages alongside failed, offline, stale and duplicate coverage", () => {
    const markup = renderToStaticMarkup(
      <UsageCoverageNotice
        environments={[
          environment("failed", "Studio", { kind: "failed" }),
          environment("offline", "Laptop", { kind: "unreachable" }),
          environment("stale", "Server", { kind: "reported", summary: SUMMARY }),
        ]}
        partialSources={[
          {
            environmentId: "partial" as EnvironmentId,
            label: "MacBook",
            provider: "claude",
            resolvedHomePath: "/Users/theo/.claude",
            message: "1 transcript file could not be read; usage from it is missing.",
          },
        ]}
        staleEnvironments={["stale" as EnvironmentId]}
        duplicateSources={["Worktree: /Users/theo/.claude"]}
      />,
    );

    expect(markup).toContain("MacBook · Claude Code: 1 transcript file could not be read");
    expect(markup).toContain("Studio could not report usage.");
    expect(markup).toContain("Laptop is not connected, so its usage is not included.");
    expect(markup).toContain("Server runs an older server version and is excluded from totals.");
    expect(markup).toContain(
      "Counted once across environments sharing a transcript directory: Worktree: /Users/theo/.claude",
    );
  });
});
