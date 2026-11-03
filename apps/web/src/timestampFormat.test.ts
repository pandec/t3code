import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatDayAwareTimestamp,
  formatUpcomingTimestamp,
  formatCompactRelativeTimeLabel,
} from "./timestampFormat";

describe("formatCompactRelativeTimeLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses the sub-minute label to now", () => {
    expect(formatCompactRelativeTimeLabel("2026-04-07T11:59:30.000Z")).toBe("now");
    expect(formatCompactRelativeTimeLabel("2026-04-07T12:00:30.000Z")).toBe("now");
  });

  it("drops the ago suffix from elapsed labels", () => {
    expect(formatCompactRelativeTimeLabel("2026-04-07T11:56:00.000Z")).toBe("4m");
    expect(formatCompactRelativeTimeLabel("2026-04-07T09:00:00.000Z")).toBe("3h");
    expect(formatCompactRelativeTimeLabel("2026-04-05T12:00:00.000Z")).toBe("2d");
  });

  it("returns an empty label for an unparseable timestamp", () => {
    expect(formatCompactRelativeTimeLabel("not-a-date")).toBe("");
  });
});

describe("timestamps in an explicit time zone", () => {
  // 23:00 UTC on July 1 is 7 PM on July 1 in New York, whatever the host zone.
  const now = Date.parse("2026-07-01T23:00:00.000Z");
  const zone = "America/New_York";

  it("picks relative days from the calendar in that zone", () => {
    expect(formatUpcomingTimestamp("2026-07-02T00:30:00.000Z", "12-hour", now, zone)).not.toMatch(
      /tomorrow/,
    );
    expect(formatUpcomingTimestamp("2026-07-02T05:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^tomorrow at /,
    );
    expect(formatDayAwareTimestamp("2026-07-01T03:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^yesterday at /,
    );
  });
});
