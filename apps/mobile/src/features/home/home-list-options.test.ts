import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasActiveHomeListFilters, type HomeListOptions } from "./home-list-options";

const defaults: HomeListOptions = {
  selectedEnvironmentId: null,
  selectedModel: null,
};

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
});
