// @effect-diagnostics globalDate:off -- UI snooze presets use local calendar boundaries and Intl labels.
import * as DateTime from "effect/DateTime";
import {
  backgroundWorkHoldsCompletion,
  snoozeUntilDoneWorkContinues,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { type EnvironmentThreadShell, threadRuntimeCanArchive } from "./models.ts";

interface SettlementRunLike {
  readonly runId?: unknown;
  readonly turnId?: unknown;
  readonly assistantMessageId?: unknown;
  readonly status?: string;
  readonly state?: string;
  readonly requestedAt?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

interface SettlementRuntimeLike {
  readonly threadId?: unknown;
  readonly providerName?: unknown;
  readonly runtimeMode?: unknown;
  readonly activeTurnId?: unknown;
  readonly lastError?: unknown;
  readonly status: string;
  readonly updatedAt?: string;
}

interface QueuedThreadShell {
  readonly latestUserMessageAt?: string | null;
  readonly latestTurn?: SettlementRunLike | null;
  readonly latestRun?: SettlementRunLike | null;
  readonly session?: SettlementRuntimeLike | null;
  readonly runtime?: SettlementRuntimeLike | null;
}

/**
 * Fork: an archive scheduled to run once the current turn and background work
 * finish. Clients mark the row and offer a control to cancel it.
 */
export function hasPendingArchive(shell: {
  readonly archivedAt: string | null;
  readonly archiveRequest?: { readonly status: string } | null;
}): boolean {
  return shell.archivedAt === null && shell.archiveRequest?.status === "pending";
}

export type ArchiveToggleAction = "archive" | "schedule" | "cancel";

/**
 * Fork: what an archive control does for a thread. A pending archive is
 * cancelled; an active or checkpointing run, or background work that holds
 * completion, schedules one for when the thread is done; anything else
 * archives now. Every archive surface (menus, shortcut, palette) resolves
 * through this.
 */
export function resolveArchiveToggleAction(
  shell: Pick<
    EnvironmentThreadShell,
    "archivedAt" | "archiveRequest" | "runtime" | "pendingBackgroundTasks"
  >,
): ArchiveToggleAction {
  if (hasPendingArchive(shell)) return "cancel";
  // A `waiting` run is capturing its final checkpoint; the server's deferred
  // archive treats it as active, so archive after it completes.
  return shell.runtime?.status !== "waiting" &&
    threadRuntimeCanArchive(shell.runtime) &&
    !backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks)
    ? "archive"
    : "schedule";
}

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
  shell: QueuedThreadShell,
  options: { readonly now: string },
): boolean {
  if (
    shell.runtime?.status === "preparing" ||
    shell.runtime?.status === "queued" ||
    shell.runtime?.status === "starting"
  ) {
    return true;
  }
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
  const turn = shell.latestRun ?? shell.latestTurn ?? null;
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
export interface ThreadSnoozeShell extends QueuedThreadShell {
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  /** Fork: the run an "until it's done" snooze waits on. */
  readonly snoozedUntilRunId?: string | null;
  readonly pendingBackgroundTasks?: ReadonlyArray<{ readonly kind: string }>;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

/** A snooze without a wake time whose marker is usable (malformed never hides). */
function isWakeTimelessSnooze(
  shell: Pick<ThreadSnoozeShell, "snoozedUntil" | "snoozedAt">,
): boolean {
  return (
    shell.snoozedUntil == null &&
    shell.snoozedAt != null &&
    !Number.isNaN(Date.parse(shell.snoozedAt))
  );
}

/**
 * Fork: an indefinite snooze ("until I wake it") carries no wake time, so
 * snoozedAt alone marks it. Both fields clear together on wake.
 */
function isIndefiniteSnooze(
  shell: Pick<ThreadSnoozeShell, "snoozedUntil" | "snoozedAt" | "snoozedUntilRunId">,
): boolean {
  return isWakeTimelessSnooze(shell) && shell.snoozedUntilRunId == null;
}

/**
 * Fork: the "until it's done" snooze: no wake time, waiting on a run's work.
 */
function isUntilDoneSnooze(
  shell: Pick<ThreadSnoozeShell, "snoozedUntil" | "snoozedAt" | "snoozedUntilRunId">,
): boolean {
  return isWakeTimelessSnooze(shell) && shell.snoozedUntilRunId != null;
}

function latestRunOf(shell: QueuedThreadShell): SettlementRunLike | null {
  return shell.latestRun ?? shell.latestTurn ?? null;
}

function runIdOf(run: SettlementRunLike | null): string | null {
  const runId = run?.runId ?? run?.turnId;
  return typeof runId === "string" ? runId : null;
}

/**
 * Fork: whether the work an "until it's done" snooze waits on goes on: the
 * awaited run is still the latest and live, or it ended while its subagents
 * work on. The server moves the snooze onto a wake run that carries the
 * work on. Watch loops alone (commands, monitors) don't count. Mirrors the
 * server through the shared snoozeUntilDoneWorkContinues.
 */
export function untilDoneWorkContinues(
  shell: Pick<
    ThreadSnoozeShell,
    "snoozedUntilRunId" | "latestRun" | "latestTurn" | "pendingBackgroundTasks"
  >,
): boolean {
  const latestRun = latestRunOf(shell);
  return snoozeUntilDoneWorkContinues({
    snoozedUntilRunId: shell.snoozedUntilRunId,
    latestRunId: runIdOf(latestRun),
    latestRunStatus: latestRun?.status ?? latestRun?.state ?? null,
    pendingBackgroundTasks: shell.pendingBackgroundTasks ?? [],
  });
}

/**
 * Fork: whether "Until it's done" may be offered. The server rejects it
 * unless a run is live or its subagents still work, so clients hide the
 * preset on quiet threads. Callers also gate on threadSnoozeUntilDone.
 */
export function canSnoozeUntilDone(
  shell: Pick<ThreadSnoozeShell, "latestRun" | "latestTurn" | "pendingBackgroundTasks">,
): boolean {
  const latestRunId = runIdOf(latestRunOf(shell));
  return (
    latestRunId !== null && untilDoneWorkContinues({ ...shell, snoozedUntilRunId: latestRunId })
  );
}

/**
 * The latest run's end time when it ended after the snooze was set, else
 * null. Timed snoozes wake on completion only; indefinite and "until it's
 * done" snoozes also wake when the run was interrupted or failed, since the
 * agent stopped either way and nothing else would bring the thread back.
 */
function runEndedAfterSnooze(shell: ThreadSnoozeShell): string | null {
  const latestRun = shell.latestRun ?? shell.latestTurn ?? null;
  if (shell.snoozedAt == null || latestRun == null || latestRun.completedAt == null) return null;
  const endedAs = (outcome: string) => latestRun.state === outcome || latestRun.status === outcome;
  const ended =
    endedAs("completed") ||
    ((isIndefiniteSnooze(shell) || isUntilDoneSnooze(shell)) &&
      (endedAs("interrupted") || endedAs("failed"))) ||
    // Fork: a cancelled run also ends the work an "until it's done" waits on.
    (isUntilDoneSnooze(shell) && endedAs("cancelled"));
  return ended && Date.parse(latestRun.completedAt) > Date.parse(shell.snoozedAt)
    ? latestRun.completedAt
    : null;
}

/**
 * A snoozed thread "raises its hand" when something happens that outranks
 * the user's snooze: the agent is blocked on them (approval / user input),
 * the session failed, or a run completed after the snooze was set — the
 * v1 taste of event-based snooze ("something happened" wakes early).
 * Raising a hand never clears the server-side snooze fields; it only stops
 * the thread from classifying as snoozed.
 */
export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return true;
  const runtime = shell.runtime ?? shell.session ?? null;
  // Only a FRESH failure raises the hand: a thread snoozed while already
  // failed stays snoozed — that snooze was the user saying "I saw it, not
  // now". session.updatedAt stamps the status edge, so an error newer than
  // the snooze is new information.
  if (
    (runtime?.status === "error" || runtime?.status === "failed") &&
    (shell.snoozedAt == null ||
      (runtime.updatedAt != null && Date.parse(runtime.updatedAt) > Date.parse(shell.snoozedAt)))
  ) {
    return true;
  }
  // Fork: an ended run is not news while an "until it's done" snooze still
  // sees its subagents working.
  return runEndedAfterSnooze(shell) !== null && !untilDoneWorkContinues(shell);
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
    ThreadSnoozeShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "latestUserMessageAt"
    | "latestTurn"
    | "latestRun"
    | "session"
    | "runtime"
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
  // Fork: "until it's done" holds only while its work goes on; any other
  // shape (ended and quiet, replaced, failed) wakes.
  if (isUntilDoneSnooze(shell)) {
    return untilDoneWorkContinues(shell) && !threadRaisedHandWhileSnoozed(shell);
  }
  // Fork: an indefinite snooze holds until the user wakes it or the thread
  // raises its hand. Malformed markers never hide a thread.
  if (isIndefiniteSnooze(shell)) return !threadRaisedHandWhileSnoozed(shell);
  if (shell.snoozedUntil == null) return false;
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
  // Fork: an indefinite snooze has no timer, so it only wakes by raising
  // its hand.
  const indefinite = isIndefiniteSnooze(shell);
  const untilDone = isUntilDoneSnooze(shell);
  if (shell.snoozedUntil == null && !indefinite && !untilDone) return null;
  const wakeAtMs = shell.snoozedUntil == null ? Number.NaN : Date.parse(shell.snoozedUntil);
  if (!indefinite && !untilDone && Number.isNaN(wakeAtMs)) return null;
  // An early hand-raise wake stays authoritative even after the scheduled
  // wake time passes: reporting snoozedUntil then would resurface a Woke
  // indicator the user already cleared by visiting (snoozedUntil is newer
  // than that visit's lastVisitedAt).
  if (threadRaisedHandWhileSnoozed(shell)) {
    const runtime = shell.runtime ?? shell.session ?? null;
    return runEndedAfterSnooze(shell) ?? runtime?.updatedAt ?? shell.snoozedAt ?? null;
  }
  // Fork: "until it's done" that woke without a raised hand: the awaited run
  // was replaced or dropped, or ended without a stamp newer than the snooze.
  if (untilDone) {
    if (untilDoneWorkContinues(shell)) return null;
    const latestRun = latestRunOf(shell);
    const replacedAt =
      runIdOf(latestRun) === shell.snoozedUntilRunId ? null : (latestRun?.requestedAt ?? null);
    return replacedAt ?? (shell.runtime ?? shell.session)?.updatedAt ?? shell.snoozedAt ?? null;
  }
  // No raised hand: an indefinite snooze is still snoozed; a timed one woke
  // iff the timer elapsed (still-snoozed → null).
  if (indefinite) return null;
  return wakeAtMs <= Date.parse(options.now) ? (shell.snoozedUntil ?? null) : null;
}

const HOUR_MS = 60 * 60 * 1_000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 6;

export type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** Menu-row time column. Complements the label instead of repeating it:
      "Tomorrow" pairs with "6:00 AM", not "tomorrow 6:00 AM". */
  readonly whenLabel: string;
  /** ISO wake time. */
  readonly snoozedUntil: string;
}

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function snoozeAtHour(base: Date, hour: number): Date {
  const next = DateTime.toDate(DateTime.makeUnsafe(base));
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = DateTime.toDate(DateTime.makeUnsafe(base));
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
export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = DateTime.toDate(DateTime.makeUnsafe(now.getTime() + HOUR_MS));
  const inThreeHours = DateTime.toDate(DateTime.makeUnsafe(now.getTime() + 3 * HOUR_MS));
  const presets: SnoozePreset[] = [
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
 * Fork: snoozed-shelf sort key. Timed wakes ascend; indefinite snoozes (no
 * wake time) come back last by definition. Shared by web and mobile.
 */
export function snoozeWakeSortMs(thread: {
  readonly snoozedUntil?: string | null;
  readonly snoozedUntilRunId?: string | null;
}): number {
  // Fork: "until it's done" rows lead: they come back soonest, and the agent
  // is working on them right now.
  if (thread.snoozedUntilRunId != null) return Number.MIN_SAFE_INTEGER;
  if (thread.snoozedUntil == null) return Number.MAX_SAFE_INTEGER;
  const wakeMs = Date.parse(thread.snoozedUntil);
  return Number.isNaN(wakeMs) ? 0 : wakeMs;
}

/** Fork: snoozed-row label where a timed row shows its wake countdown. */
export const INDEFINITE_SNOOZE_LABEL = "parked";

/** Fork: snoozed-row label for an "until it's done" snooze. */
export const UNTIL_DONE_SNOOZE_LABEL = "until done";

/** Fork: snoozed-shelf label for a row without a wake countdown. */
export function snoozeShelfLabel(thread: { readonly snoozedUntilRunId?: string | null }): string {
  return thread.snoozedUntilRunId != null ? UNTIL_DONE_SNOOZE_LABEL : INDEFINITE_SNOOZE_LABEL;
}

/**
 * Fork: the "until it's done" preset. Listed first because it is the one
 * choice about the thread rather than the clock. Callers gate it on
 * canSnoozeUntilDone and the threadSnoozeUntilDone capability.
 */
export const SNOOZE_UNTIL_DONE_PRESET = {
  id: "until-done",
  label: "Until it's done",
  whenLabel: "when the work ends",
} as const;

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
