/**
 * Free-text wake times for the palette's snooze view: durations ("45m",
 * "1h30m", "2 days"), clock times ("14:00", "2pm", "at 9"), and day names
 * with an optional time ("tomorrow 8", "fri 9am", "mon"). Anything the
 * grammar rejects returns null and the presets stand alone.
 */
export interface ParsedSnoozeQuery {
  readonly snoozedUntil: string;
  /** "45 minutes" for durations; absent for absolute times. */
  readonly durationLabel?: string;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_WAKE_HOUR = 9;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_ALIASES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  tues: 2,
  wednesday: 3,
  weds: 3,
  thursday: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  saturday: 6,
};
for (const [index, day] of WEEKDAYS.entries()) WEEKDAY_ALIASES[day] = index;

const UNIT_MINUTES: ReadonlyArray<readonly [RegExp, number, string]> = [
  [/^(m|min|mins|minute|minutes)$/, 1, "minute"],
  [/^(h|hr|hrs|hour|hours)$/, 60, "hour"],
  [/^(d|day|days)$/, 24 * 60, "day"],
  [/^(w|wk|wks|week|weeks)$/, 7 * 24 * 60, "week"],
];

function parseDuration(text: string): { minutes: number; label: string } | null {
  const parts = text.match(/(\d+(?:\.\d+)?)\s*([a-z]+)/g);
  if (!parts || parts.join("").replace(/\s+/g, "") !== text.replace(/\s+/g, "")) return null;
  let minutes = 0;
  const labels: string[] = [];
  for (const part of parts) {
    const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(part);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = UNIT_MINUTES.find(([pattern]) => pattern.test(match[2]!));
    if (!unit || !(amount > 0)) return null;
    minutes += amount * unit[1];
    labels.push(`${amount} ${unit[2]}${amount === 1 ? "" : "s"}`);
  }
  return minutes > 0 ? { minutes: Math.round(minutes), label: labels.join(" ") } : null;
}

/** "14:00", "2pm", "2:30 pm", "9". Bare hours are only accepted when the
 * caller says so (after a day name or "at"), since "2" alone is ambiguous. */
function parseClock(
  text: string,
  options: { readonly allowBareHour: boolean },
): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3];
  if (match[2] === undefined && meridiem === undefined && !options.allowBareHour) return null;
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (hour > 23) return null;
  return { hour, minute };
}

function atTime(base: Date, hour: number, minute: number): Date {
  const date = new Date(base);
  date.setHours(hour, minute, 0, 0);
  return date;
}

export function parseSnoozeQuery(query: string, now: Date): ParsedSnoozeQuery | null {
  const text = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (text.length === 0) return null;

  const relative = text.replace(/^in /, "");
  const duration = parseDuration(relative);
  if (duration) {
    const wake = new Date(now.getTime() + duration.minutes * MINUTE_MS);
    wake.setSeconds(0, 0);
    return { snoozedUntil: wake.toISOString(), durationLabel: duration.label };
  }

  const clockOnly = parseClock(text.replace(/^at /, ""), { allowBareHour: text.startsWith("at ") });
  if (clockOnly) {
    let wake = atTime(now, clockOnly.hour, clockOnly.minute);
    if (wake.getTime() <= now.getTime()) wake = new Date(wake.getTime() + DAY_MS);
    return { snoozedUntil: wake.toISOString() };
  }

  const dayMatch = /^(today|tomorrow|tmr|tmrw|[a-z]+)(?: (?:at )?(.+))?$/.exec(text);
  if (!dayMatch) return null;
  const [, dayWord, timeText] = dayMatch;
  const time = timeText === undefined ? null : parseClock(timeText, { allowBareHour: true });
  if (timeText !== undefined && time === null) return null;
  const hour = time?.hour ?? DEFAULT_WAKE_HOUR;
  const minute = time?.minute ?? 0;

  if (dayWord === "today") {
    if (time === null) return null;
    const wake = atTime(now, hour, minute);
    return wake.getTime() > now.getTime() ? { snoozedUntil: wake.toISOString() } : null;
  }
  if (dayWord === "tomorrow" || dayWord === "tmr" || dayWord === "tmrw") {
    return { snoozedUntil: atTime(new Date(now.getTime() + DAY_MS), hour, minute).toISOString() };
  }
  const weekday = WEEKDAY_ALIASES[dayWord!];
  if (weekday === undefined) return null;
  let wake = atTime(now, hour, minute);
  const daysAhead = (weekday - now.getDay() + 7) % 7;
  wake = new Date(wake.getTime() + daysAhead * DAY_MS);
  // A same-day name whose time already passed means next week's.
  if (wake.getTime() <= now.getTime()) wake = new Date(wake.getTime() + 7 * DAY_MS);
  return { snoozedUntil: wake.toISOString() };
}
