// @effect-diagnostics globalDate:off -- Fixed wall-clock instants keep calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import {
  enumerateDays,
  enumerateHourStarts,
  formatDateTimeShort,
  formatHourShort,
  formatRelativeHourShort,
  makeWindow,
  refreshWindow,
} from "./usageFormat.ts";

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

  it("treats time zone as query identity while preserving hourly resolution", () => {
    const now = new Date("2026-08-11T12:37:42.123Z");
    const current = { ...makeWindow(1, now, "hour"), timeZone: "Mars/Olympus" };
    const next = refreshWindow(current, 1, now);

    expect(next).not.toBe(current);
    expect(next.timeZone).not.toBe(current.timeZone);
    expect(next.resolution).toBe("hour");
    expect(next.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(next.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });
});

describe("hourly usage formatting", () => {
  it("enumerates 24 fixed buckets across a rolling window", () => {
    const hours = enumerateHourStarts("2026-08-10T12:37:00.000Z", "2026-08-11T12:37:00.000Z");

    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe("2026-08-10T12:37:00.000Z");
    expect(hours[23]).toBe("2026-08-11T11:37:00.000Z");
  });

  it("formats rolling instants in the requested time zone", () => {
    expect(formatHourShort("2026-08-11T00:37:00.000Z", "UTC")).toBe("12 AM");
    expect(formatHourShort("2026-08-11T12:37:00.000Z", "UTC")).toBe("12 PM");
    expect(formatDateTimeShort("2026-08-11T17:37:00.000Z", "UTC")).toBe("Aug 11, 5 PM");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
  });

  it("makes hourly tooltip dates relative to the window in its requested time zone", () => {
    const windowEnd = "2026-08-11T14:37:00.000Z";

    expect(formatRelativeHourShort("2026-08-10T17:37:00.000Z", windowEnd, "UTC")).toBe(
      "5 PM yesterday",
    );
    expect(formatRelativeHourShort("2026-08-11T14:37:00.000Z", windowEnd, "UTC")).toBe(
      "2 PM today",
    );
    expect(
      formatRelativeHourShort(
        "2026-08-11T01:37:00.000Z",
        "2026-08-11T10:37:00.000Z",
        "America/Los_Angeles",
      ),
    ).toBe("6 PM yesterday");
  });

  it("builds an exact minute-aligned 24-hour request", () => {
    const window = makeWindow(1, new Date("2026-08-11T12:37:42.123Z"), "hour");

    expect(window.resolution).toBe("hour");
    expect(window.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });

  it("degrades an unknown resolved zone to UTC instead of crashing", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow(1, now, "hour").timeZone).toBe("UTC");
      expect(makeWindow(30, now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});
