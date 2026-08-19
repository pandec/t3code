import { describe, expect, it } from "@effect/vitest";

import { resolveThreadShelfExpanded, threadShelfExpandedPatch } from "./thread-shelf-expansion";

const resolve = (
  shelf: Parameters<typeof resolveThreadShelfExpanded>[0]["shelf"],
  preferences: Parameters<typeof resolveThreadShelfExpanded>[0]["preferences"] = {},
  olderCollapsedByDefault = true,
) => resolveThreadShelfExpanded({ shelf, preferences, olderCollapsedByDefault });

describe("resolveThreadShelfExpanded", () => {
  it("folds snoozed and archived away and opens settled by default", () => {
    expect(resolve("snoozed")).toBe(false);
    expect(resolve("archived")).toBe(false);
    expect(resolve("settled")).toBe(true);
  });

  it("seeds the Older shelf from its setting", () => {
    expect(resolve("older", {}, true)).toBe(false);
    expect(resolve("older", {}, false)).toBe(true);
  });

  it("prefers a stored choice over every default", () => {
    expect(resolve("archived", { sidebarArchivedShelfExpanded: true })).toBe(true);
    expect(resolve("settled", { sidebarSettledShelfExpanded: false })).toBe(false);
    expect(resolve("snoozed", { sidebarSnoozedShelfExpanded: true })).toBe(true);
    // The setting only seeds the shelf; a tap outranks it from then on.
    expect(resolve("older", { sidebarOlderShelfExpanded: true }, true)).toBe(true);
  });
});

describe("threadShelfExpandedPatch", () => {
  it("writes one key per shelf so a toggle cannot clobber a sibling", () => {
    expect(threadShelfExpandedPatch("older", true)).toEqual({ sidebarOlderShelfExpanded: true });
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
});
