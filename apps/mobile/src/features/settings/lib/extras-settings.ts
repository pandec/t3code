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
  clampSidebarOlderSectionAfterDays,
  clampSteerGraceWindowMs,
  DEFAULT_SIDEBAR_OLDER_SECTION_AFTER_DAYS,
  type AccentTintIntensityPercent,
  type ArchivedSectionVisibleCount,
  type SidebarOlderSectionAfterDays,
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

/**
 * Stops for the Older window, which the contract allows anywhere from a day
 * to a year. A plain day slider across that range would put a week and a
 * fortnight a pixel apart, so the phone offers a coarsening scale instead:
 * dense where the choice is delicate, sparse where a month either way is
 * the same decision. Web's number field still reaches every day in between.
 */
export const OLDER_SECTION_AFTER_DAY_STOPS: ReadonlyArray<{
  readonly days: number;
  readonly label: string;
}> = [
  { days: 1, label: "1 day" },
  { days: 2, label: "2 days" },
  { days: 3, label: "3 days" },
  { days: 5, label: "5 days" },
  { days: 7, label: "1 week" },
  { days: 10, label: "10 days" },
  { days: 14, label: "2 weeks" },
  { days: 21, label: "3 weeks" },
  { days: 30, label: "1 month" },
  { days: 45, label: "6 weeks" },
  { days: 60, label: "2 months" },
  { days: 90, label: "3 months" },
  { days: 180, label: "6 months" },
  { days: 365, label: "1 year" },
];

/**
 * The stop a stored window sits on. Values between stops (set on web, where
 * every day is reachable) snap to the nearest one so the slider still has a
 * position to render, without rewriting the preference.
 */
export function olderSectionAfterDaysStopIndex(days: number): number {
  let nearest = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [index, stop] of OLDER_SECTION_AFTER_DAY_STOPS.entries()) {
    const distance = Math.abs(stop.days - days);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function olderSectionAfterDaysAtStop(index: number): SidebarOlderSectionAfterDays {
  const stop =
    OLDER_SECTION_AFTER_DAY_STOPS[
      Math.min(OLDER_SECTION_AFTER_DAY_STOPS.length - 1, Math.max(0, Math.round(index)))
    ];
  return clampSidebarOlderSectionAfterDays(stop?.days ?? DEFAULT_SIDEBAR_OLDER_SECTION_AFTER_DAYS);
}

/** The readout beside the slider: the nearest stop's label. */
export function formatOlderSectionAfterDays(value: number): string {
  return (
    OLDER_SECTION_AFTER_DAY_STOPS[olderSectionAfterDaysStopIndex(value)]?.label ?? `${value} days`
  );
}
