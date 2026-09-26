// @effect-diagnostics globalDate:off -- UI snooze presets use local calendar boundaries and Intl labels.
import type { OrchestrationThreadShell } from "@t3tools/contracts";

/**
 * A queued turn start lives for at most this long: session adoption takes
 * seconds, so a user message still unadopted after the grace window is a
 * failed start (or stale data — shells from older servers can carry user
 * messages with no latestTurn at all), not pending work. Without this bound
 * such threads would be permanently unsettleable.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * A user message no turn has picked up yet: the turn.start command was
 * dispatched (message-sent + turn-start-requested) but no session has
 * adopted it, so `session` is still null and the pending work is invisible
 * to the session-status checks. Detectable as a user message strictly newer
 * than every timestamp on the latest turn — on adoption the new turn's
 * requestedAt equals the message time, clearing the condition — and only
 * within the adoption grace window.
 */
export function hasQueuedTurnStart(
  shell: Pick<OrchestrationThreadShell, "latestUserMessageAt" | "latestTurn" | "session">,
  options: { readonly now: string },
): boolean {
  if (shell.latestUserMessageAt == null) return false;
  // A failed session start clears the queued state: the failure is already
  // visible (status edge / error).
  if (shell.session?.status === "error") return false;
  const messageAt = Date.parse(shell.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) return false;
  // Bounded on both sides: message timestamps originate on whichever device
  // sent the message, so a clock ahead of this one yields a negative age
  // that would otherwise hold the queued state for the whole skew. Mirrors
  // the decider's guard.
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = shell.latestTurn;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

/**
 * The snooze lifecycle fields plus everything needed to detect a raised
 * hand. Snooze is an overlay on the active state: a snoozed thread stays
 * "active" in the data model and is only suppressed from the inbox until
 * its wake time passes or the thread demands attention.
 */
export type ThreadSnoozeShell = Pick<
  OrchestrationThreadShell,
  | "snoozedUntil"
  | "snoozedAt"
  | "snoozedUntilTurnId"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "latestTurn"
  | "backgroundLiveness"
>;

/**
 * Whether the work an "until it's done" snooze waits on is still going: the
 * awaited turn is running, or it ended while its subagents work on. The
 * server moves the snooze onto a follow-up turn the agent starts for them,
 * so the awaited turn stays the latest one until the work goes quiet.
 * Watch loops alone ("monitoring") don't count: a dev server can outlive
 * the session. Mirrored by the server's untilDoneWorkContinues.
 */
export function untilDoneWorkContinues(
  shell: Pick<ThreadSnoozeShell, "snoozedUntilTurnId" | "latestTurn" | "backgroundLiveness">,
): boolean {
  return (
    shell.snoozedUntilTurnId != null &&
    shell.latestTurn?.turnId === shell.snoozedUntilTurnId &&
    (shell.latestTurn.state === "running" || shell.backgroundLiveness === "working")
  );
}

/**
 * A snoozed thread "raises its hand" when something happens that outranks
 * the user's snooze: the agent is blocked on them (approval / user input),
 * the session failed, or a turn ended after the snooze was set — the v1
 * taste of event-based snooze ("something happened" wakes early). An
 * interrupted turn counts the same as a completed one: either way the agent
 * stopped and the thread wants a look. Raising a hand never clears the
 * server-side snooze fields; it only stops the thread from classifying as
 * snoozed. Mirrored by the server's isThreadSnoozed; keep the two in step.
 */
export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return true;
  // Only a FRESH failure raises the hand: a thread snoozed while already
  // failed stays snoozed — that snooze was the user saying "I saw it, not
  // now". session.updatedAt stamps the status edge, so an error newer than
  // the snooze is new information.
  if (
    shell.session?.status === "error" &&
    (shell.snoozedAt == null || Date.parse(shell.session.updatedAt) > Date.parse(shell.snoozedAt))
  ) {
    return true;
  }
  // An ended turn is not news while an "until it's done" snooze still sees
  // its subagents working.
  if (
    shell.snoozedAt != null &&
    shell.latestTurn != null &&
    shell.latestTurn.state !== "running" &&
    shell.latestTurn.completedAt != null &&
    Date.parse(shell.latestTurn.completedAt) > Date.parse(shell.snoozedAt) &&
    !untilDoneWorkContinues(shell)
  ) {
    return true;
  }
  return false;
}

/**
 * Whether an "until it's done" snooze may be offered: the server rejects it
 * unless a turn is running or its subagents are still working, so the
 * client hides the preset on quiet threads.
 */
export function canSnoozeUntilDone(
  shell: Pick<OrchestrationThreadShell, "latestTurn" | "backgroundLiveness">,
): boolean {
  return (
    shell.latestTurn?.state === "running" ||
    (shell.latestTurn != null && shell.backgroundLiveness === "working")
  );
}

/**
 * A thread may be snoozed unless the agent is blocked on the user: hiding a
 * pending approval or user-input request defeats the request, and a queued
 * turn start (a message no turn has adopted yet) is invisible pending work
 * the same way it is for settle. A running session IS snoozable — snooze
 * only affects visibility, never the agent. Client-side twin of the server
 * invariants so the UI can reject before a round trip.
 */
export function canSnooze(
  shell: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt" | "latestTurn" | "session"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

/**
 * Snoozed resolution: hidden from the inbox while the wake time is in the
 * future and the thread has not raised its hand. Timer wakes are derived —
 * no server event fires when snoozedUntil passes; the stale fields simply
 * stop classifying as snoozed (and feed the woke indicator until the user
 * visits or re-engages).
 */
export function effectiveSnoozed(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): boolean {
  if (shell.snoozedUntil == null) {
    // Indefinite snooze ("until I wake it"): snoozedAt alone marks it. Both
    // fields clear together on wake, so a lone snoozedAt is never stale —
    // but malformed data never hides a thread, same as the timed branch.
    if (shell.snoozedAt == null || Number.isNaN(Date.parse(shell.snoozedAt))) return false;
    // "Until it's done": snoozed only while the awaited work continues.
    // Any other shape (ended and quiet, replaced, dropped) wakes.
    if (shell.snoozedUntilTurnId != null && !untilDoneWorkContinues(shell)) {
      return false;
    }
    return !threadRaisedHandWhileSnoozed(shell);
  }
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  // Malformed data never hides a thread.
  if (Number.isNaN(wakeAtMs)) return false;
  if (wakeAtMs <= Date.parse(options.now)) return false;
  return !threadRaisedHandWhileSnoozed(shell);
}

/**
 * When a previously-snoozed thread woke, or null if it never snoozed / is
 * still snoozed. Used for the "Woke" indicator: the thread reappears in its
 * original sort position (the inbox sort is deliberately static), so the
 * wake signal has to carry the weight. Compare against the client's
 * lastVisitedAt — visiting clears the indicator like it clears unread.
 *
 * Timer wakes report the wake time itself; raised-hand wakes report the
 * triggering timestamp so a visit BEFORE the early wake doesn't suppress
 * the indicator.
 */
export function threadWokeAt(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): string | null {
  // An indefinite snooze (snoozedAt without a wake time) can only wake by
  // raising its hand; there is no timer to elapse. A malformed marker never
  // classified as snoozed, so it can never wake either.
  if (
    shell.snoozedUntil == null &&
    (shell.snoozedAt == null || Number.isNaN(Date.parse(shell.snoozedAt)))
  ) {
    return null;
  }
  if (shell.snoozedUntil != null && Number.isNaN(Date.parse(shell.snoozedUntil))) return null;
  // An early hand-raise wake stays authoritative even after the scheduled
  // wake time passes: reporting snoozedUntil then would resurface a Woke
  // indicator the user already cleared by visiting (snoozedUntil is newer
  // than that visit's lastVisitedAt).
  if (threadRaisedHandWhileSnoozed(shell)) {
    if (
      shell.snoozedAt != null &&
      shell.latestTurn != null &&
      shell.latestTurn.state !== "running" &&
      shell.latestTurn.completedAt != null &&
      Date.parse(shell.latestTurn.completedAt) > Date.parse(shell.snoozedAt)
    ) {
      return shell.latestTurn.completedAt;
    }
    return shell.session?.updatedAt ?? shell.snoozedAt ?? null;
  }
  // "Until it's done" that woke without a raised hand: the awaited turn was
  // replaced or dropped (a new turn started, or it vanished), or it ended
  // with a completedAt no newer than the snooze (an interrupt keeps a
  // placeholder stamp from before the snooze). Either way the thread is
  // awake and the Woke pill needs a time.
  if (shell.snoozedUntilTurnId != null) {
    if (untilDoneWorkContinues(shell)) return null;
    if (shell.latestTurn?.turnId !== shell.snoozedUntilTurnId) {
      return shell.latestTurn?.requestedAt ?? shell.snoozedAt ?? null;
    }
    return shell.session?.updatedAt ?? shell.snoozedAt ?? null;
  }
  // No raised hand: an indefinite snooze is simply still snoozed; a timed
  // one woke iff the timer elapsed.
  if (shell.snoozedUntil == null) return null;
  return Date.parse(shell.snoozedUntil) <= Date.parse(options.now) ? shell.snoozedUntil : null;
}

const HOUR_MS = 60 * 60 * 1_000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export type SnoozePresetId =
  | "until-done"
  | "hour"
  | "three-hours"
  | "evening"
  | "tomorrow"
  | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** Menu-row time column. Complements the label instead of repeating it:
      "Tomorrow" pairs with "9:00 AM", not "tomorrow 9:00 AM". */
  readonly whenLabel: string;
  /** ISO wake time, or null for a condition-based preset. */
  readonly snoozedUntil: string | null;
  /** "Until it's done": wake when the running turn and its subagents finish. */
  readonly untilDone?: true;
}

/**
 * The "until it's done" preset: hides a working thread until its running
 * turn and the subagents it started finish. Listed first because it is the one choice that is about the
 * thread rather than the clock. Callers gate it on canSnoozeUntilDone and
 * the threadSnoozeUntilDone capability.
 */
export const SNOOZE_UNTIL_DONE_PRESET: SnoozePreset = {
  id: "until-done",
  label: "Until it's done",
  whenLabel: "when the work ends",
  snoozedUntil: null,
  untilDone: true,
};

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function snoozeAtHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Shared "snooze until" choices for every client. "This evening" only
 * appears while it is meaningfully before evening; after that the calendar
 * choices start at "Tomorrow". Calendar presets that land on the same
 * instant collapse: on Sundays "Tomorrow" and "Next week" are both Monday
 * morning, so only "Tomorrow" is offered.
 */
export function resolveSnoozePresets(
  now: Date,
  options?: { readonly untilDone?: boolean },
): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const inThreeHours = new Date(now.getTime() + 3 * HOUR_MS);
  const presets: SnoozePreset[] = [
    ...(options?.untilDone === true ? [SNOOZE_UNTIL_DONE_PRESET] : []),
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: snoozeTimeOfDayLabel(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      whenLabel: snoozeTimeOfDayLabel(inThreeHours),
      snoozedUntil: inThreeHours.toISOString(),
    },
  ];

  const evening = snoozeAtHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: snoozeTimeOfDayLabel(evening),
      snoozedUntil: evening.toISOString(),
    });
  }

  const tomorrow = snoozeAtHour(addSnoozeDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: snoozeTimeOfDayLabel(tomorrow),
    snoozedUntil: tomorrow.toISOString(),
  });

  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = snoozeAtHour(addSnoozeDays(now, daysUntilMonday), MORNING_HOUR);
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({
      id: "next-week",
      label: "Next week",
      whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${snoozeTimeOfDayLabel(nextWeek)}`,
      snoozedUntil: nextWeek.toISOString(),
    });
  }

  return presets;
}

/**
 * Compact "wakes in" label for snoozed rows: "2h", "18h", "3d". Minutes
 * round up so a snooze never reads "0m" while still hidden. Shared by web
 * and mobile so the same wake time never reads differently per client.
 */
export function snoozeWakeLabel(snoozedUntil: string, options: { readonly now: string }): string {
  const wakeMs = Date.parse(snoozedUntil);
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return "now";
  const remainingMs = wakeMs - nowMs;
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}

export type CustomSnoozeInput =
  | { readonly mode: "date"; readonly date: string; readonly time: string }
  | {
      readonly mode: "duration";
      readonly amount: string;
      readonly unit: "minutes" | "hours" | "days";
    };

/** Resolve local calendar input or elapsed time, rejecting past and invalid dates. */
export function resolveCustomSnooze(input: CustomSnoozeInput, now: Date): string | null {
  let wake: Date;
  if (input.mode === "duration") {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unitMs = { minutes: 60_000, hours: HOUR_MS, days: 24 * HOUR_MS }[input.unit];
    wake = new Date(now.getTime() + amount * unitMs);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) return null;
    wake = new Date(`${input.date}T${input.time}:00`);
    // Reject rolled-over dates and nonexistent local times during DST changes.
    if (localSnoozeDate(wake) !== input.date || localSnoozeTime(wake) !== input.time) return null;
  }
  return Number.isFinite(wake.getTime()) && wake.getTime() > now.getTime()
    ? wake.toISOString()
    : null;
}

export function localSnoozeDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localSnoozeTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
