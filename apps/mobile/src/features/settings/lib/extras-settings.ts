/**
 * Presentation for the fork's device-local Extras settings.
 *
 * Mobile stores these per device (no client-settings sync), but the slider
 * granularity and the readout format are the same ones web's Extras panel uses,
 * so a value set on the phone reads identically to one set on the desktop.
 */
import {
  clampArchivedSectionVisibleCount,
  clampAccentTintIntensityPercent,
  clampSteerGraceWindowMs,
  type AccentTintIntensityPercent,
  type ArchivedSectionVisibleCount,
  type SteerGraceWindowMs,
} from "@t3tools/contracts/settings";

/** Half-second granularity keeps the steer window readable in seconds. */
export const STEER_GRACE_WINDOW_STEP_MS = 500;

/** The tint intensity is a whole percentage, as web's slider writes it. */
export const ACCENT_TINT_INTENSITY_STEP_PERCENT = 1;

/** e.g. `5.0s` — one decimal, so a half-step move is visible. */
export function formatSteerGraceWindowSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

export function formatAccentTintIntensityPercent(percent: number): string {
  return `${percent}%`;
}

/**
 * A slider position as a storable steer window. The slider is already stepped
 * and bounded, so this only exists to keep a rounding artefact or a stale value
 * from ever reaching the preference blob.
 */
export function toStoredSteerGraceWindowMs(value: number): SteerGraceWindowMs {
  return clampSteerGraceWindowMs(
    Math.round(value / STEER_GRACE_WINDOW_STEP_MS) * STEER_GRACE_WINDOW_STEP_MS,
  );
}

/** The same guard for the tint intensity, which stores whole percentages. */
export function toStoredAccentTintIntensityPercent(value: number): AccentTintIntensityPercent {
  return clampAccentTintIntensityPercent(Math.round(value));
}

export function toStoredArchivedSectionVisibleCount(value: number): ArchivedSectionVisibleCount {
  return clampArchivedSectionVisibleCount(Math.round(value));
}
