import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { indefiniteSnoozeWokeByRun, isIndefinitelySnoozed } from "./IndefiniteSnooze.ts";

const SNOOZED_AT = DateTime.makeUnsafe("2026-10-04T10:00:00.000Z");
const before = DateTime.makeUnsafe("2026-10-04T09:00:00.000Z");
const after = DateTime.makeUnsafe("2026-10-04T11:00:00.000Z");

describe("isIndefinitelySnoozed", () => {
  it("is marked by snoozedAt without a wake time", () => {
    expect(isIndefinitelySnoozed({ snoozedUntil: null, snoozedAt: SNOOZED_AT })).toBe(true);
    expect(isIndefinitelySnoozed({ snoozedUntil: after, snoozedAt: SNOOZED_AT })).toBe(false);
    expect(isIndefinitelySnoozed({ snoozedUntil: null, snoozedAt: null })).toBe(false);
  });
});

describe("indefiniteSnoozeWokeByRun", () => {
  it("wakes on any run that ended after the snooze, not on live or earlier runs", () => {
    for (const status of ["completed", "interrupted", "failed"] as const) {
      expect(indefiniteSnoozeWokeByRun([{ status, completedAt: after }], SNOOZED_AT)).toBe(true);
    }
    expect(
      indefiniteSnoozeWokeByRun([{ status: "completed", completedAt: before }], SNOOZED_AT),
    ).toBe(false);
    expect(indefiniteSnoozeWokeByRun([{ status: "running", completedAt: null }], SNOOZED_AT)).toBe(
      false,
    );
    expect(
      indefiniteSnoozeWokeByRun([{ status: "cancelled", completedAt: after }], SNOOZED_AT),
    ).toBe(false);
  });
});
