import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentUsageStatus } from "../../state/usage";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  metric: "cost" as "cost" | "tokens" | "limits",
  breakdown: "time" as "model" | "time",
  attribution: "pool" as "pool" | "source",
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: vi.fn((initial: unknown) => [
      initial === readUsagePagePreferences
        ? { metric: testState.metric, windowDays: 30 }
        : typeof initial === "function"
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
          : initial === "cost"
            ? testState.metric
            : initial === "model"
              ? testState.breakdown
              : initial,
      vi.fn(),
    ]),
  };
});

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../hooks/useLocalStorage", () => ({
  useLocalStorage: () => [testState.attribution, vi.fn()],
}));
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
vi.mock("./UsagePriceOverrides", () => ({ UsagePriceOverrides: () => null }));
vi.mock("./usageProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usageProviders")>();
  return {
    ...actual,
    PROVIDER_PRESENTATION: {
      codex: { color: "white", label: "Codex", mark: "span" },
      claude: { color: "orange", label: "Claude Code", mark: "span" },
    },
  };
});

import { UsageCoverageNotice, UsagePage } from "./UsagePage";
import { readUsagePagePreferences } from "./usagePagePreferences";

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
  state: NonNullable<EnvironmentUsageStatus["state"]>,
): EnvironmentUsageStatus {
  return {
    environmentId: environmentId as EnvironmentId,
    label,
    isPending: state.kind === "reporting",
    error: state.kind === "failed" ? "Failed" : null,
    summary: state.kind === "reported" ? state.summary : null,
    state,
  };
}

const providerTotals = (codex: number, claude: number) =>
  new Map([
    ["codex", { costUsd: codex, totalTokens: codex * 1_000 }],
    ["claude", { costUsd: claude, totalTokens: claude * 1_000 }],
  ] as const);

const modelTotals = Object.freeze([
  {
    model: "expensive-model",
    provider: "claude" as const,
    costUsd: 10,
    totalTokens: 100,
    records: 1,
    costShare: 10 / 16,
  },
  {
    model: "token-heavy-model",
    provider: "codex" as const,
    costUsd: 5,
    totalTokens: 1_000,
    records: 1,
    costShare: 5 / 16,
  },
  {
    model: "token-heavy-cheaper-model",
    provider: "codex" as const,
    costUsd: 1,
    totalTokens: 1_000,
    records: 1,
    costShare: 1 / 16,
  },
]);

const environments = [
  {
    environmentId: EnvironmentId.make("test-environment"),
    label: "Test environment",
    isPending: false,
    error: null,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-08-11T12:37:00.000Z",
      sinceDay: UsageDay.make("2026-08-10"),
      untilDay: UsageDay.make("2026-08-11"),
      timeZone: "UTC",
      buckets: [],
      sources: [],
      pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    },
  },
];

beforeEach(() => {
  testState.metric = "cost";
  testState.breakdown = "time";
  testState.attribution = "pool";
  testState.useUsage.mockReturnValue({
    merged: {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      models: modelTotals,
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
    environments,
    selectedEnvironments: environments,
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

describe("UsagePage attribution", () => {
  it("passes the selected attribution through to usage merging", () => {
    testState.attribution = "source";

    renderToStaticMarkup(<UsagePage />);

    expect(testState.useUsage).toHaveBeenLastCalledWith(expect.anything(), null, "source");
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

  it("keeps chronological ordering when the token metric is selected", () => {
    testState.metric = "tokens";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/\$11\.00.*\$13\.00/);
  });
});

describe("UsagePage model breakdown", () => {
  it("sorts models by cost when the cost metric is selected", () => {
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/expensive-model.*token-heavy-model.*token-heavy-cheaper-model/);
  });

  it("sorts models by token usage when the token metric is selected", () => {
    testState.metric = "tokens";
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/token-heavy-model.*token-heavy-cheaper-model.*expensive-model/);
    expect(modelTotals.map((model) => model.model)).toEqual([
      "expensive-model",
      "token-heavy-model",
      "token-heavy-cheaper-model",
    ]);
  });
});
