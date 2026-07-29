import {
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
  EnvironmentId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasActiveHomeListFilters,
  hasCustomHomeListOptions,
  type HomeListOptions,
} from "./home-list-options";

const defaults: HomeListOptions = {
  selectedEnvironmentId: null,
  selectedModel: null,
  projectSortOrder:
    DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
      ? "updated_at"
      : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  threadSortOrder: DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
};

describe("home list options", () => {
  it("recognizes default options", () => {
    expect(hasCustomHomeListOptions(defaults)).toBe(false);
  });

  it("marks environment filters as customized", () => {
    expect(
      hasCustomHomeListOptions({
        ...defaults,
        selectedEnvironmentId: EnvironmentId.make("environment-1"),
      }),
    ).toBe(true);
    expect(
      hasCustomHomeListOptions({ ...defaults, selectedProjectKey: "environment-1:project-1" }),
    ).toBe(true);
  });

  it("marks model filters as customized", () => {
    expect(hasCustomHomeListOptions({ ...defaults, selectedModel: "claude-opus-4-5" })).toBe(true);
  });
});

describe("hasActiveHomeListFilters", () => {
  it("reports no active filters for defaults", () => {
    expect(hasActiveHomeListFilters(defaults)).toBe(false);
    expect(hasActiveHomeListFilters({ ...defaults, selectedProjectKey: null })).toBe(false);
  });

  it("reports each scope filter", () => {
    expect(
      hasActiveHomeListFilters({
        ...defaults,
        selectedEnvironmentId: EnvironmentId.make("environment-1"),
      }),
    ).toBe(true);
    expect(
      hasActiveHomeListFilters({ ...defaults, selectedProjectKey: "environment-1:project-1" }),
    ).toBe(true);
    expect(hasActiveHomeListFilters({ ...defaults, selectedModel: "claude-opus-4-5" })).toBe(true);
  });

  // "Clear filters" is gated on this helper but never resets sort order, so a
  // non-default sort must not light it up — the action would do nothing.
  it("ignores sort order", () => {
    const sorted: HomeListOptions = {
      ...defaults,
      projectSortOrder: "created_at",
      threadSortOrder: "created_at",
    };

    expect(hasActiveHomeListFilters(sorted)).toBe(false);
    expect(hasCustomHomeListOptions(sorted)).toBe(true);
  });
});
