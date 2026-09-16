import { describe, expect, it, vi } from "vite-plus/test";
import { parseSnoozeQuery } from "./CommandPalette.snooze";

// Wednesday 2026-09-16 10:30 local time.
const now = new Date(2026, 8, 16, 10, 30, 45);

function wake(query: string): Date {
  const parsed = parseSnoozeQuery(query, now);
  expect(parsed, query).not.toBeNull();
  return new Date(parsed!.snoozedUntil);
}

describe("parseSnoozeQuery", () => {
  it("parses durations in several spellings and drops seconds", () => {
    expect(wake("45m").getTime()).toBe(new Date(2026, 8, 16, 11, 15).getTime());
    expect(wake("in 2 hours").getTime()).toBe(new Date(2026, 8, 16, 12, 30).getTime());
    expect(wake("1h30m").getTime()).toBe(new Date(2026, 8, 16, 12, 0).getTime());
    expect(wake("1.5h").getTime()).toBe(new Date(2026, 8, 16, 12, 0).getTime());
    expect(wake("3d").getTime()).toBe(new Date(2026, 8, 19, 10, 30).getTime());
    expect(parseSnoozeQuery("2 hours", now)?.durationLabel).toBe("2 hours");
    expect(parseSnoozeQuery("1h 1m", now)?.durationLabel).toBe("1 hour 1 minute");
  });

  it("rolls clock times to tomorrow once they have passed", () => {
    expect(wake("14:00").getTime()).toBe(new Date(2026, 8, 16, 14, 0).getTime());
    expect(wake("2pm").getTime()).toBe(new Date(2026, 8, 16, 14, 0).getTime());
    expect(wake("9:15 am").getTime()).toBe(new Date(2026, 8, 17, 9, 15).getTime());
    expect(wake("12am").getTime()).toBe(new Date(2026, 8, 17, 0, 0).getTime());
    expect(wake("at 11").getTime()).toBe(new Date(2026, 8, 16, 11, 0).getTime());
    expect(parseSnoozeQuery("11", now)).toBeNull();
    expect(parseSnoozeQuery("25:00", now)).toBeNull();
    expect(parseSnoozeQuery("13pm", now)).toBeNull();
  });

  it("parses day names with a default 9:00 wake and optional time", () => {
    expect(wake("tomorrow").getTime()).toBe(new Date(2026, 8, 17, 9, 0).getTime());
    expect(wake("tomorrow 8").getTime()).toBe(new Date(2026, 8, 17, 8, 0).getTime());
    expect(wake("tmr at 6pm").getTime()).toBe(new Date(2026, 8, 17, 18, 0).getTime());
    expect(wake("fri 9am").getTime()).toBe(new Date(2026, 8, 18, 9, 0).getTime());
    expect(wake("Monday").getTime()).toBe(new Date(2026, 8, 21, 9, 0).getTime());
    // Wednesday 9:00 has passed, so "wed" means next week.
    expect(wake("wed").getTime()).toBe(new Date(2026, 8, 23, 9, 0).getTime());
    expect(wake("wed 11").getTime()).toBe(new Date(2026, 8, 16, 11, 0).getTime());
    expect(wake("today 17:30").getTime()).toBe(new Date(2026, 8, 16, 17, 30).getTime());
    expect(parseSnoozeQuery("today", now)).toBeNull();
    expect(parseSnoozeQuery("today 9", now)).toBeNull();
  });

  it("rejects overflowing, sub-minute, and inherited-property inputs without throwing", () => {
    for (const query of [
      "9".repeat(400) + "d",
      "999999999999999w",
      "0.1m",
      "0.9m",
      "constructor",
    ]) {
      expect(parseSnoozeQuery(query, now), query).toBeNull();
    }
  });

  it("keeps calendar dates and clock times across local daylight-saving transitions", () => {
    vi.stubEnv("TZ", "America/New_York");
    try {
      const cases = [
        [new Date(2026, 2, 7, 23, 30), "tomorrow", new Date(2026, 2, 8, 9)],
        [new Date(2026, 9, 31, 23, 30), "tomorrow", new Date(2026, 10, 1, 9)],
        [new Date(2026, 10, 1, 0, 30), "tomorrow", new Date(2026, 10, 2, 9)],
        [new Date(2026, 2, 7, 23), "9am", new Date(2026, 2, 8, 9)],
        [new Date(2026, 9, 31, 23), "9am", new Date(2026, 10, 1, 9)],
        [new Date(2026, 2, 7, 23), "mon 9am", new Date(2026, 2, 9, 9)],
        [new Date(2026, 9, 31, 23), "sat 9am", new Date(2026, 10, 7, 9)],
      ] as const;
      expect(cases[0][0].getTimezoneOffset()).toBe(300);
      expect(cases[0][2].getTimezoneOffset()).toBe(240);
      for (const [base, query, expected] of cases) {
        expect(parseSnoozeQuery(query, base)?.snoozedUntil, query).toBe(expected.toISOString());
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects preset names and free text so they filter the list instead", () => {
    for (const query of ["", "tomorrow morning", "evening", "next week", "custom", "until", "0m"]) {
      expect(parseSnoozeQuery(query, now), query).toBeNull();
    }
  });
});
