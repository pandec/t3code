import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarEmptyStateCause } from "./sidebarEmptyState";

function cause(
  overrides: Partial<Parameters<typeof resolveSidebarEmptyStateCause>[0]>,
): ReturnType<typeof resolveSidebarEmptyStateCause> {
  return resolveSidebarEmptyStateCause({
    environmentScopeActive: false,
    projectFiltersActive: false,
    attentionFilterActive: false,
    admittedWithoutEnvironment: 0,
    admittedWithoutProjects: 0,
    admittedWithoutAttention: 0,
    ...overrides,
  });
}

describe("resolveSidebarEmptyStateCause", () => {
  it("blames nothing when no filter is active", () => {
    expect(cause({})).toBe("none");
  });

  // The defect this function exists to prevent: a filter that is switched on
  // but hid nothing is not why the list is empty, and offering its clear
  // action leaves the user exactly where they were.
  it("does not blame an active filter that hid nothing", () => {
    expect(cause({ environmentScopeActive: true })).toBe("none");
    expect(cause({ projectFiltersActive: true })).toBe("none");
    expect(cause({ attentionFilterActive: true })).toBe("none");
  });

  it("blames the one filter whose removal would admit rows", () => {
    expect(cause({ environmentScopeActive: true, admittedWithoutEnvironment: 1 })).toBe(
      "environment",
    );
    expect(cause({ projectFiltersActive: true, admittedWithoutProjects: 4 })).toBe("projects");
    expect(cause({ attentionFilterActive: true, admittedWithoutAttention: 2 })).toBe("attention");
  });

  it("ignores admitted counts belonging to filters that are not active", () => {
    expect(
      cause({
        admittedWithoutEnvironment: 9,
        admittedWithoutProjects: 9,
        admittedWithoutAttention: 9,
      }),
    ).toBe("none");
  });

  it("reports multiple when two filters each hide rows, since no single button helps", () => {
    expect(
      cause({
        environmentScopeActive: true,
        attentionFilterActive: true,
        admittedWithoutEnvironment: 1,
        admittedWithoutAttention: 3,
      }),
    ).toBe("multiple");
  });

  it("reports multiple when all three hide rows", () => {
    expect(
      cause({
        environmentScopeActive: true,
        projectFiltersActive: true,
        attentionFilterActive: true,
        admittedWithoutEnvironment: 1,
        admittedWithoutProjects: 1,
        admittedWithoutAttention: 1,
      }),
    ).toBe("multiple");
  });

  // Regression: a scope on a connected environment with no threads, plus the
  // attention filter on. Attention hid nothing there, so the environment is the
  // only honest culprit — an earlier version showed "No threads need attention"
  // beside a button that refilled nothing.
  it("blames the environment when attention is enabled but hid nothing", () => {
    expect(
      cause({
        environmentScopeActive: true,
        attentionFilterActive: true,
        admittedWithoutEnvironment: 5,
      }),
    ).toBe("environment");
  });

  // Regression, the mirror case: a removed environment scope plus attention,
  // where clearing either alone still leaves the list empty. An earlier version
  // offered "Show all environments", which did nothing.
  it("blames nothing when neither active filter alone would admit a row", () => {
    expect(cause({ environmentScopeActive: true, attentionFilterActive: true })).toBe("none");
  });
});
