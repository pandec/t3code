import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  resolveSnoozePresets as resolveSharedSnoozePresets,
  SNOOZE_UNTIL_DONE_PRESET,
  snoozeWakeLabel,
  type SnoozePreset as SharedSnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { formatShortTimestamp, parseTimestampDate } from "../timestampFormat";

export { snoozeWakeLabel };

/** The shared timed presets plus the fork's "Until it's done". */
export interface SnoozePreset extends Omit<SharedSnoozePreset, "id" | "snoozedUntil"> {
  readonly id: SharedSnoozePreset["id"] | "until-done";
  /** ISO wake time, or null for the "until it's done" snooze. */
  readonly snoozedUntil: string | null;
  /** "Until it's done": wake when the running work and its subagents end. */
  readonly untilDone?: true;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function timeOfDayLabel(date: Date, timestampFormat: TimestampFormat): string {
  return formatShortTimestamp(date.toISOString(), timestampFormat);
}

/**
 * Presets for "snooze until", computed against local time. "Until it's
 * done" leads when the caller offers it (a working thread on a server with
 * threadSnoozeUntilDone).
 */
export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  options?: { readonly untilDone?: boolean },
): ReadonlyArray<SnoozePreset> {
  const presets: SnoozePreset[] = resolveSharedSnoozePresets(now).map((preset) => {
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
  if (options?.untilDone === true) {
    presets.unshift({ ...SNOOZE_UNTIL_DONE_PRESET, snoozedUntil: null, untilDone: true });
  }
  return presets;
}

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
