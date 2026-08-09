import { describe, expect, it } from "vite-plus/test";

import { enumerateDays, makeWindow, refreshWindow } from "./usageFormat";

// Local-time constructors well inside a day, so the resolved calendar day is
// the same in any zone the test machine runs in.
const noonOn = (year: number, monthIndex: number, day: number) =>
  new Date(year, monthIndex, day, 12, 0, 0);

describe("makeWindow", () => {
  it("spans exactly the requested number of days, ending today", () => {
    const window = makeWindow(7, noonOn(2026, 7, 7));
    expect(window.untilDay).toBe("2026-08-07");
    expect(enumerateDays(window.sinceDay, window.untilDay)).toHaveLength(7);
  });
});

describe("refreshWindow", () => {
  it("returns the current window by identity while the day is unchanged", () => {
    const current = makeWindow(7, noonOn(2026, 7, 7));
    expect(refreshWindow(current, 7, noonOn(2026, 7, 7))).toBe(current);
  });

  it("recomputes the window once the clock crosses midnight", () => {
    const current = makeWindow(7, noonOn(2026, 7, 7));
    const next = refreshWindow(current, 7, noonOn(2026, 7, 8));
    expect(next).not.toBe(current);
    expect(next.untilDay).toBe("2026-08-08");
    expect(next.sinceDay).toBe("2026-08-02");
  });
});
