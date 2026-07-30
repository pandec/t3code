import {
  MAX_ACCENT_TINT_INTENSITY_PERCENT,
  MAX_STEER_GRACE_WINDOW_MS,
  MIN_ACCENT_TINT_INTENSITY_PERCENT,
  MIN_STEER_GRACE_WINDOW_MS,
} from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  formatAccentTintIntensityPercent,
  formatSteerGraceWindowSeconds,
  toStoredAccentTintIntensityPercent,
  toStoredSteerGraceWindowMs,
} from "./extras-settings";

describe("formatSteerGraceWindowSeconds", () => {
  it("reads the stored milliseconds as seconds with one decimal", () => {
    expect(formatSteerGraceWindowSeconds(5_000)).toBe("5.0s");
    expect(formatSteerGraceWindowSeconds(2_500)).toBe("2.5s");
    expect(formatSteerGraceWindowSeconds(MIN_STEER_GRACE_WINDOW_MS)).toBe("0.0s");
    expect(formatSteerGraceWindowSeconds(MAX_STEER_GRACE_WINDOW_MS)).toBe("15.0s");
  });
});

describe("formatAccentTintIntensityPercent", () => {
  it("reads the stored intensity as a percentage", () => {
    expect(formatAccentTintIntensityPercent(12)).toBe("12%");
  });
});

describe("toStoredSteerGraceWindowMs", () => {
  it("snaps to the half-second step the slider moves in", () => {
    expect(toStoredSteerGraceWindowMs(2_499)).toBe(2_500);
    expect(toStoredSteerGraceWindowMs(2_749)).toBe(2_500);
    expect(toStoredSteerGraceWindowMs(2_751)).toBe(3_000);
  });

  it("clamps to the contract bounds rather than storing an out-of-range window", () => {
    expect(toStoredSteerGraceWindowMs(-1_000)).toBe(MIN_STEER_GRACE_WINDOW_MS);
    expect(toStoredSteerGraceWindowMs(60_000)).toBe(MAX_STEER_GRACE_WINDOW_MS);
  });
});

describe("toStoredAccentTintIntensityPercent", () => {
  it("stores whole percentages", () => {
    expect(toStoredAccentTintIntensityPercent(12.4)).toBe(12);
    expect(toStoredAccentTintIntensityPercent(12.6)).toBe(13);
  });

  it("clamps to the contract bounds", () => {
    expect(toStoredAccentTintIntensityPercent(0)).toBe(MIN_ACCENT_TINT_INTENSITY_PERCENT);
    expect(toStoredAccentTintIntensityPercent(99)).toBe(MAX_ACCENT_TINT_INTENSITY_PERCENT);
  });
});
