import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { formatCompactRelativeTimeLabel } from "./timestampFormat";

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
