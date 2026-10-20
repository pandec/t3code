// @effect-diagnostics globalDate:off -- UI snooze presets use local calendar boundaries and Intl labels.
import * as DateTime from "effect/DateTime";
import {
  backgroundWorkHoldsCompletion,
  snoozeUntilDoneWorkContinues,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { type EnvironmentThreadShell, threadRuntimeCanArchive } from "./models.ts";

import type { PendingSubagentRequest } from "./models.ts";

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

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface ThreadSnoozeShell extends QueuedThreadShell {
  readonly source?: Pick<EnvironmentThreadShell["source"], "pendingRuntimeRequest">;
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  /** Fork: the run an "until it's done" snooze waits on. */
  readonly snoozedUntilRunId?: string | null;
  readonly pendingBackgroundTasks?: ReadonlyArray<{ readonly kind: string }>;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly pendingSubagentRequest?: PendingSubagentRequest | null;
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
 * Fork: the latest run's end time when an "until it's done" snooze's run
 * ended after the snooze was set, else null. Any ending counts (completed,
 * interrupted, failed, cancelled): the agent stopped either way and nothing
 * else would bring the thread back. Timed snoozes never wake on a run ending.
 */
function runEndedAfterSnooze(shell: ThreadSnoozeShell): string | null {
  if (!isUntilDoneSnooze(shell)) return null;
  const latestRun = shell.latestRun ?? shell.latestTurn ?? null;
  if (shell.snoozedAt == null || latestRun == null || latestRun.completedAt == null) return null;
  const endedAs = (outcome: string) => latestRun.state === outcome || latestRun.status === outcome;
  const ended =
    endedAs("completed") || endedAs("interrupted") || endedAs("failed") || endedAs("cancelled");
  return ended && Date.parse(latestRun.completedAt) > Date.parse(shell.snoozedAt)
    ? latestRun.completedAt
    : null;
}

/**
 * Only a request for the user or a fresh failure ends a timed snooze early. Completed runs never
 * do: a snoozed long-running thread keeps waking itself for background work and stays hidden
 * until its timer. Fork: an "until it's done" snooze also wakes when its work ends.
 */
export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return true;
  if (shell.source?.pendingRuntimeRequest != null) return true;
  if (shell.pendingSubagentRequest != null) return true;
  const failedAt = failureEdgeAt(shell);
  if (
    failedAt !== undefined &&
    (shell.snoozedAt == null ||
      (failedAt != null && Date.parse(failedAt) > Date.parse(shell.snoozedAt)))
  ) {
    return true;
  }
  // Fork: an ended run is not news while an "until it's done" snooze still
  // sees its subagents working.
  return runEndedAfterSnooze(shell) !== null && !untilDoneWorkContinues(shell);
}

// V2 runtime.updatedAt includes metadata writes; prefer the failed run's completion.
// Legacy sessions only expose the runtime timestamp.
function failureEdgeAt(shell: ThreadSnoozeShell): string | null | undefined {
  const runtime = shell.runtime ?? shell.session ?? null;
  if (runtime?.status !== "error" && runtime?.status !== "failed") return undefined;
  const latestRun = shell.latestRun ?? shell.latestTurn ?? null;
  if (latestRun?.status === "failed" && latestRun.completedAt != null) {
    return latestRun.completedAt;
  }
  return runtime.updatedAt ?? null;
}

/**
 * A thread may be snoozed unless the agent or one of its subagents is blocked
 * on the user (hiding a pending approval or user-input request defeats the
 * request) or a run is still waiting to start. A running session IS
 * snoozable — snooze only affects visibility, never the agent. Client-side
 * twin of the server invariants so the UI can reject before a round trip.
 * Run status only, never user-message timestamps: a message steered into the
 * running run is newer than every run timestamp yet is not queued work.
 */
export function canSnooze(
  shell: Pick<
    ThreadSnoozeShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "runtime" | "source"
  >,
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  // The server rejects snoozing even for nonblocking questions.
  if (shell.source?.pendingRuntimeRequest != null) return false;
  if (shell.pendingSubagentRequest != null) return false;
  const status = shell.runtime?.status;
  return status !== "preparing" && status !== "queued" && status !== "starting";
}

export function effectiveSnoozed(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): boolean {
  // Fork: "until it's done" holds only while its work goes on; any other
  // shape (ended and quiet, replaced, failed) wakes.
  if (isUntilDoneSnooze(shell)) {
    return untilDoneWorkContinues(shell) && !threadRaisedHandWhileSnoozed(shell);
  }
  if (shell.snoozedUntil == null) return false;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return false;
  if (wakeAtMs <= Date.parse(options.now)) return false;
  return !threadRaisedHandWhileSnoozed(shell);
}

export function threadWokeAt(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): string | null {
  const untilDone = isUntilDoneSnooze(shell);
  if (shell.snoozedUntil == null && !untilDone) return null;
  const wakeAtMs = shell.snoozedUntil == null ? Number.NaN : Date.parse(shell.snoozedUntil);
  if (!untilDone && Number.isNaN(wakeAtMs)) return null;
  // An early hand-raise wake stays authoritative even after the scheduled
  // wake time passes: reporting snoozedUntil then would resurface a Woke
  // indicator the user already cleared by visiting (snoozedUntil is newer
  // than that visit's lastVisitedAt).
  if (threadRaisedHandWhileSnoozed(shell)) {
    // An old failure must not replace the activity time of an approval or input wake.
    const failedAt = failureEdgeAt(shell);
    if (
      failedAt != null &&
      (shell.snoozedAt == null || Date.parse(failedAt) > Date.parse(shell.snoozedAt))
    ) {
      return failedAt;
    }
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
  // No raised hand: a timed snooze woke iff the timer elapsed (still-snoozed → null).
  return wakeAtMs <= Date.parse(options.now) ? (shell.snoozedUntil ?? null) : null;
}

/**
 * Fork: whether a wake reported by threadWokeAt came from the agent's work
 * ending rather than a timer. Only an "until it's done" snooze wakes that
 * way; timed snoozes ignore finished runs. Only meaningful
 * while threadWokeAt is non-null; the sidebar colors such wakes like Done.
 */
export function threadWokeOnFinishedWork(shell: ThreadSnoozeShell): boolean {
  return isUntilDoneSnooze(shell);
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

/** Fork: snoozed-shelf sort key, timed wakes ascending. Shared by web and mobile. */
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

/** Fork: snoozed-row label for an "until it's done" snooze, where a timed row shows its wake countdown. */
export const UNTIL_DONE_SNOOZE_LABEL = "until done";

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
