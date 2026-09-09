import {
  resolveSnoozePresets as resolveSharedSnoozePresets,
  type SnoozePreset as SharedSnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

export { snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatShortTimestamp, parseTimestampDate } from "../timestampFormat";

type SnoozePresetId = SharedSnoozePreset["id"] | "until-woken";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** Menu-row time column. Complements the label instead of repeating it:
      "Tomorrow" pairs with "9:00 AM", not "tomorrow 9:00 AM". */
  readonly whenLabel: string;
  /** ISO wake time, or null for the indefinite "until I wake it" and the
      "until it's done" snoozes. */
  readonly snoozedUntil: string | null;
  /** "Until it's done": wake when the running turn ends. */
  readonly untilDone?: true;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function timeOfDayLabel(date: Date, timestampFormat: TimestampFormat): string {
  return formatShortTimestamp(date.toISOString(), timestampFormat);
}

/**
 * Presets for "snooze until", computed against local time. "Until it's
 * done" leads when the thread has a running turn and the server supports
 * it; the indefinite "Until I wake it" preset is opt-in because it requires
 * the threadSnoozeIndefinite server capability.
 */
export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  options?: { readonly untilWoken?: boolean; readonly untilDone?: boolean },
): ReadonlyArray<SnoozePreset> {
  const presets: SnoozePreset[] = resolveSharedSnoozePresets(now, {
    untilDone: options?.untilDone === true,
  }).map((preset) => {
    if (preset.snoozedUntil === null) return preset;
    const wake = parseTimestampDate(preset.snoozedUntil);
    if (wake === null) return preset;
    const time = timeOfDayLabel(wake, timestampFormat);
    return {
      ...preset,
      whenLabel:
        preset.id === "next-week"
          ? `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
          : time,
    };
  });

  if (options?.untilWoken === true) {
    presets.push({
      id: "until-woken",
      label: "Until I wake it",
      whenLabel: "no timer",
      snoozedUntil: null,
    });
  }

  return presets;
}

/**
 * Human wake time for menus and toasts: "tomorrow 9:00", "Mon 9:00",
 * "17:30" (today).
 */
export function snoozeWakeDescription(
  snoozedUntil: string,
  now: Date,
  timestampFormat: TimestampFormat,
): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "";
  const time = timeOfDayLabel(wake, timestampFormat);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.floor((wake.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `tomorrow ${time}`;
  const weekday = wake.toLocaleDateString(undefined, { weekday: "short" });
  if (dayDelta < 7) return `${weekday} ${time}`;
  const date = wake.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date}, ${time}`;
}

/**
 * Toast title for a completed snooze. The single place that maps the
 * indefinite preset's null wake time onto prose, so `snoozeWakeDescription`
 * is never called with null from any surface.
 */
export function snoozedUntilToastTitle(
  preset: Pick<SnoozePreset, "snoozedUntil" | "untilDone">,
  timestampFormat: TimestampFormat,
): string {
  if (preset.untilDone === true) return "Snoozed until it's done";
  return preset.snoozedUntil === null
    ? "Snoozed until you wake it"
    : `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date(), timestampFormat)}`;
}
