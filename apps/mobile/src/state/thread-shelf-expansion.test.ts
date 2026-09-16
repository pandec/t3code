import { describe, expect, it } from "@effect/vitest";

import { resolveThreadShelfExpanded, threadShelfExpandedPatch } from "./thread-shelf-expansion";

const resolve = (
  shelf: Parameters<typeof resolveThreadShelfExpanded>[0]["shelf"],
  preferences: Parameters<typeof resolveThreadShelfExpanded>[0]["preferences"] = {},
) => resolveThreadShelfExpanded({ shelf, preferences });

describe("resolveThreadShelfExpanded", () => {
  it("folds snoozed and archived away and opens settled by default", () => {
    expect(resolve("snoozed")).toBe(false);
    expect(resolve("archived")).toBe(false);
    expect(resolve("settled")).toBe(true);
  });

  it("prefers a stored choice over every default", () => {
    expect(resolve("archived", { sidebarArchivedShelfExpanded: true })).toBe(true);
    expect(resolve("settled", { sidebarSettledShelfExpanded: false })).toBe(false);
    expect(resolve("snoozed", { sidebarSnoozedShelfExpanded: true })).toBe(true);
  });
});

describe("threadShelfExpandedPatch", () => {
  it("writes exactly the toggled shelf's key", () => {
    expect(threadShelfExpandedPatch("snoozed", true)).toEqual({
      sidebarSnoozedShelfExpanded: true,
    });
    expect(threadShelfExpandedPatch("settled", false)).toEqual({
      sidebarSettledShelfExpanded: false,
    });
    expect(threadShelfExpandedPatch("archived", true)).toEqual({
      sidebarArchivedShelfExpanded: true,
    });
  });

  it("round-trips through resolveThreadShelfExpanded for every shelf", () => {
    for (const shelf of ["pinned", "snoozed", "settled", "archived"] as const) {
      for (const expanded of [true, false]) {
        expect(resolve(shelf, threadShelfExpandedPatch(shelf, expanded))).toBe(expanded);
      }
    }
  });
});
