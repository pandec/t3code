import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentUsageStatus } from "../../state/usage";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: vi.fn((initial: unknown) => [
      typeof initial === "function"
        ? {
            days: 1,
            window: {
              sinceDay: "2026-08-10",
              untilDay: "2026-08-11",
              timeZone: "UTC",
              resolution: "hour",
              sinceTime: "2026-08-10T12:37:00.000Z",
              untilTime: "2026-08-11T12:37:00.000Z",
            },
          }
        : initial === "model"
          ? "time"
          : initial,
      vi.fn(),
    ]),
  };
});

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/usage", () => ({ useUsage: testState.useUsage }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: "div" }));
vi.mock("./usageProviders", () => ({
  PROVIDER_ORDER: ["codex", "claude"],
  PROVIDER_PRESENTATION: {
    codex: { color: "white", label: "Codex", mark: "span" },
    claude: { color: "orange", label: "Claude Code", mark: "span" },
  },
}));

import { UsageCoverageNotice, UsagePage } from "./UsagePage";

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

const providerTotals = (codex: number, claude: number) =>
  new Map([
    ["codex", { costUsd: codex, totalTokens: codex * 1_000 }],
    ["claude", { costUsd: claude, totalTokens: claude * 1_000 }],
  ] as const);

beforeEach(() => {
  testState.useUsage.mockReturnValue({
    merged: {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      hourly: [
        {
          day: "2026-08-10",
          hourStart: "2026-08-10T13:37:00.000Z",
          costUsd: 13,
          totalTokens: 13_000,
          byProvider: providerTotals(7, 6),
        },
        {
          day: "2026-08-11",
          hourStart: "2026-08-11T11:37:00.000Z",
          costUsd: 11,
          totalTokens: 11_000,
          byProvider: providerTotals(6, 5),
        },
      ],
    },
    environments: [],
    isPending: false,
    isPartial: false,
    refresh: vi.fn(),
  });
});

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

describe("UsagePage hourly breakdown", () => {
  it("keeps recent activity visible first without empty hourly rows", () => {
    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body.match(/<tr/g)).toHaveLength(2);
    expect(body).toContain("$11.00");
    expect(body).toContain("$13.00");
    expect(body.indexOf("$11.00")).toBeLessThan(body.indexOf("$13.00"));
  });
});
