// @effect-diagnostics globalDate:off -- UI snooze presets use local calendar boundaries and Intl labels.
import * as DateTime from "effect/DateTime";
import { DEFAULT_SNOOZE_PRESETS, type SnoozePresetSetting } from "@t3tools/contracts/settings";
import {
  backgroundWorkHoldsCompletion,
  snoozeUntilDoneWorkContinues,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { type EnvironmentThreadShell, threadRuntimeCanArchive } from "./models.ts";

import type { PendingSubagentRequest } from "./models.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

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
 * Fork: what an archive control does. A pending archive is cancelled; an active or checkpointing
 * run, or completion-holding background work, schedules one for when the thread is done; anything
 * else archives now. Every archive surface (menus, shortcut, palette) resolves through this.
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

export interface ArchiveQueuedMessageDiscard {
  readonly total: number;
  /** The part of `total` queued in side chats, which follow their parent's archive. */
  readonly inSideChats: number;
}

const NO_QUEUED_MESSAGE_DISCARD: ArchiveQueuedMessageDiscard = { total: 0, inSideChats: 0 };

/**
 * Fork: queued messages the archive control would discard, so every surface confirms while
 * `total` is positive. Archiving now cancels the thread's queued runs, held ones included (Stop
 * holds the queue). The archive, now or when done, also takes the thread's unarchived side chats
 * from `threads` with their queues. Cancel discards nothing.
 */
export function archiveDiscardedQueuedMessages(
  shell: Pick<
    EnvironmentThreadShell,
    | "environmentId"
    | "id"
    | "archivedAt"
    | "archiveRequest"
    | "runtime"
    | "pendingBackgroundTasks"
    | "queuedMessageCount"
  >,
  threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "lineage" | "archivedAt" | "queuedMessageCount">
  > = [],
): ArchiveQueuedMessageDiscard {
  const action = resolveArchiveToggleAction(shell);
  if (action === "cancel") return NO_QUEUED_MESSAGE_DISCARD;
  let inSideChats = 0;
  for (const thread of threads) {
    if (
      thread.environmentId === shell.environmentId &&
      thread.lineage.sideChat === true &&
      thread.lineage.parentThreadId === shell.id &&
      thread.archivedAt === null
    ) {
      inSideChats += thread.queuedMessageCount ?? 0;
    }
  }
  const own = action === "archive" ? (shell.queuedMessageCount ?? 0) : 0;
  return own + inSideChats === 0
    ? NO_QUEUED_MESSAGE_DISCARD
    : { total: own + inSideChats, inSideChats };
}

/** Fork: whether a re-read discard exceeds what the user confirmed, so it must ask again. */
export function discardExceedsConfirmed(
  next: ArchiveQueuedMessageDiscard,
  confirmed: ArchiveQueuedMessageDiscard,
): boolean {
  return (
    next.total > confirmed.total ||
    next.total - next.inSideChats > confirmed.total - confirmed.inSideChats
  );
}

export interface ThreadSnoozeShell extends QueuedThreadShell {
  readonly source?: Pick<EnvironmentThreadShell["source"], "pendingRuntimeRequest">;
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  /** Fork: the run an "until it's done" snooze waits on. */
  readonly snoozedUntilRunId?: string | null;
  readonly pendingBackgroundTasks?: ReadonlyArray<{ readonly kind: string }> | undefined;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly pendingUserInputAt?: string | null;
  readonly pendingSubagentRequest?: PendingSubagentRequest | null;
  readonly pendingGuestMessageCount?: number;
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

function pendingQuestionAt(shell: ThreadSnoozeShell): string | null {
  const request = shell.source?.pendingRuntimeRequest;
  return (
    shell.pendingUserInputAt ??
    (request?.kind === "user_input" ? DateTime.formatIso(request.createdAt) : null)
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
 * Fork: whether an "until it's done" snooze's work goes on: the awaited run is still the latest
 * and live, or it ended while its subagents work on (the server moves the snooze onto a wake run).
 * Watch loops alone don't count. Mirrors the server via snoozeUntilDoneWorkContinues.
 */
function untilDoneWorkContinues(
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
  shell: Pick<
    ThreadSnoozeShell,
    "latestRun" | "latestTurn" | "pendingBackgroundTasks" | "hasPendingUserInput" | "source"
  >,
): boolean {
  // A pending question blocks the work an "until it's done" snooze waits on.
  if (shell.hasPendingUserInput || shell.source?.pendingRuntimeRequest != null) return false;
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
  const request = shell.source?.pendingRuntimeRequest;
  if (shell.hasPendingApprovals || (request != null && request.kind !== "user_input")) return true;
  const questionAt = pendingQuestionAt(shell);
  // Snoozing an existing question means "ask me later". Only a new question
  // wakes it early; missing or invalid timestamps keep the request visible.
  // Fork: "until it's done" always wakes for a question.
  if (
    (shell.hasPendingUserInput || request?.kind === "user_input") &&
    (isUntilDoneSnooze(shell) ||
      shell.snoozedAt == null ||
      questionAt == null ||
      !(Date.parse(questionAt) <= Date.parse(shell.snoozedAt)))
  ) {
    return true;
  }
  if (shell.pendingSubagentRequest != null) return true;
  if ((shell.pendingGuestMessageCount ?? 0) > 0) return true;
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

// V2 runtime.updatedAt includes metadata writes, not just failures.
// Legacy sessions only expose the runtime timestamp.
function failureEdgeAt(shell: ThreadSnoozeShell): string | null | undefined {
  const runtime = shell.runtime ?? shell.session ?? null;
  if (runtime?.status !== "error" && runtime?.status !== "failed") return undefined;
  const latestRun = shell.latestRun ?? shell.latestTurn ?? null;
  if (latestRun?.status === "failed") {
    return latestRun.completedAt ?? null;
  }
  return runtime.updatedAt ?? null;
}

/**
 * Client twin of the server's snooze invariants: rejects while the agent or a subagent is blocked
 * on the user, a guest message waits, or a run waits to start. Running sessions are snoozable.
 * Run status only, never user-message timestamps: a steered message is newer than every run
 * timestamp yet is not queued work.
 */
export function canSnooze(
  shell: Pick<
    ThreadSnoozeShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "runtime"
    | "source"
  >,
): boolean {
  if (shell.hasPendingApprovals) return false;
  const request = shell.source?.pendingRuntimeRequest;
  if (request != null && request.kind !== "user_input") return false;
  if (shell.pendingSubagentRequest != null) return false;
  // A waiting guest message would wake it at once.
  if ((shell.pendingGuestMessageCount ?? 0) > 0) return false;
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
    const failedAt = failureEdgeAt(shell);
    const questionAt = pendingQuestionAt(shell);
    const freshFailure =
      failedAt != null &&
      (shell.snoozedAt == null || Date.parse(failedAt) > Date.parse(shell.snoozedAt));
    const freshQuestion =
      questionAt != null &&
      shell.snoozedAt != null &&
      Date.parse(questionAt) > Date.parse(shell.snoozedAt);
    if (freshFailure && (!freshQuestion || Date.parse(failedAt) >= Date.parse(questionAt))) {
      return failedAt;
    }
    if (freshQuestion) return questionAt;
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

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const;

export interface SnoozePreset {
  readonly id: string;
  readonly label: string;
  /** Menu-row time column. Complements the label instead of repeating it:
      "Tomorrow" pairs with "6:00 AM", not "tomorrow 6:00 AM". */
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

export interface SnoozePresetOptions {
  readonly presets?: ReadonlyArray<SnoozePresetSetting>;
  readonly formatTime?: (date: Date) => string;
}

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = DateTime.toDate(DateTime.makeUnsafe(base));
  next.setDate(next.getDate() + days);
  return next;
}

/** "In 3 hours", "In 90 minutes", "In 2 days": the largest unit that divides evenly. */
function snoozeDurationLabel(minutes: number, resolve: MFunctionType): string {
  if (minutes % (24 * 60) === 0) {
    return resolve(
      msg("{count, plural, one {In {count} day} other {In {count} days}}", {
        count: minutes / (24 * 60),
      }),
    );
  }
  if (minutes % 60 === 0) {
    return resolve(
      msg("{count, plural, one {In {count} hour} other {In {count} hours}}", {
        count: minutes / 60,
      }),
    );
  }
  return resolve(
    msg("{count, plural, one {In {count} minute} other {In {count} minutes}}", { count: minutes }),
  );
}

const WEEKDAY_LABELS = {
  sunday: msg("Sunday"),
  monday: msg("Monday"),
  tuesday: msg("Tuesday"),
  wednesday: msg("Wednesday"),
  thursday: msg("Thursday"),
  friday: msg("Friday"),
  saturday: msg("Saturday"),
} satisfies Record<keyof typeof WEEKDAY_INDEX, string>;

const NEXT_WEEKDAY_LABELS = {
  sunday: msg("Next Sunday"),
  monday: msg("Next Monday"),
  tuesday: msg("Next Tuesday"),
  wednesday: msg("Next Wednesday"),
  thursday: msg("Next Thursday"),
  friday: msg("Next Friday"),
  saturday: msg("Next Saturday"),
} satisfies Record<keyof typeof WEEKDAY_INDEX, string>;

function snoozePresetDaysAhead(
  setting: Extract<SnoozePresetSetting, { kind: "at" }>,
  now: Date,
): number {
  if (setting.day === "today") return 0;
  if (setting.day === "tomorrow") return 1;
  return (WEEKDAY_INDEX[setting.day] - now.getDay() + 7) % 7 || 7;
}

/** Labels follow the actual day gap, so a Monday option on a Sunday reads "Tomorrow". */
function snoozePresetLabel(
  setting: SnoozePresetSetting,
  daysAhead: number,
  resolve: MFunctionType,
): string {
  if (setting.kind === "after") return snoozeDurationLabel(setting.minutes, resolve);
  if (daysAhead === 0) {
    const hour = Number(setting.time.slice(0, 2));
    return hour < 12
      ? resolve(msg("This morning"))
      : hour < 17
        ? resolve(msg("This afternoon"))
        : resolve(msg("This evening"));
  }
  if (daysAhead === 1) return resolve(msg("Tomorrow"));
  if (setting.day === "monday") return resolve(msg("Next week"));
  if (setting.day === "today" || setting.day === "tomorrow") return "";
  return resolve(daysAhead === 7 ? NEXT_WEEKDAY_LABELS[setting.day] : WEEKDAY_LABELS[setting.day]);
}

export function snoozePresetId(setting: SnoozePresetSetting): string {
  return setting.kind === "after"
    ? `after:${setting.minutes}`
    : `at:${setting.day}:${setting.time}`;
}

export function resolveSnoozePreset(
  setting: SnoozePresetSetting,
  now: Date,
  formatTime: (date: Date) => string = snoozeTimeOfDayLabel,
  resolve: MFunctionType = mFallback,
): SnoozePreset | null {
  let wake: Date;
  let daysAhead = 0;
  if (setting.kind === "after") {
    wake = DateTime.toDate(DateTime.makeUnsafe(now.getTime() + setting.minutes * 60_000));
  } else {
    daysAhead = snoozePresetDaysAhead(setting, now);
    wake = addSnoozeDays(now, daysAhead);
    wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0);
    // A today option whose time has passed is left out until tomorrow.
    if (wake.getTime() <= now.getTime()) return null;
  }
  const label = snoozePresetLabel(setting, daysAhead, resolve);
  // Durations and "Next week" don't name the wake day, so a wake on another day shows it.
  const labelNamesDay = setting.kind === "at" && !(daysAhead > 1 && setting.day === "monday");
  const time = formatTime(wake);
  return {
    id: snoozePresetId(setting),
    label,
    whenLabel:
      labelNamesDay || wake.toDateString() === now.toDateString()
        ? time
        : `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`,
    snoozedUntil: wake.toISOString(),
  };
}

/** The snooze menu: soonest first, one row per wake minute. */
export function resolveSnoozePresets(
  now: Date,
  options: SnoozePresetOptions = {},
  resolve: MFunctionType = mFallback,
): ReadonlyArray<SnoozePreset> {
  // By minute, so a duration (which keeps the clock's seconds) and a set time in the same
  // minute tie, and the stable sort keeps whichever comes first in settings.
  const wakeMinute = (preset: SnoozePreset) => Math.floor(Date.parse(preset.snoozedUntil) / 60_000);
  const seen = new Set<number>();
  return (
    (options.presets ?? DEFAULT_SNOOZE_PRESETS)
      .flatMap((setting) => resolveSnoozePreset(setting, now, options.formatTime, resolve) ?? [])
      // flatMap returned a new array; Hermes has no `toSorted`.
      .sort((a, b) => wakeMinute(a) - wakeMinute(b))
      .filter((preset) => {
        if (seen.has(wakeMinute(preset))) return false;
        seen.add(wakeMinute(preset));
        return true;
      })
  );
}

/**
 * A menu choice as picked. A duration re-resolves from its setting (not the deduped menu) so it
 * starts at selection. A set time keeps the shown wake, which a day change would otherwise shift.
 */
export function pickSnoozePreset(input: {
  readonly shown: ReadonlyArray<SnoozePreset>;
  readonly id: string;
  readonly now: Date;
  readonly presets?: ReadonlyArray<SnoozePresetSetting>;
  readonly formatTime?: (date: Date) => string;
  readonly resolve?: MFunctionType;
}): SnoozePreset | undefined {
  const original = input.shown.find((preset) => preset.id === input.id);
  const ahead =
    original && Date.parse(original.snoozedUntil) > input.now.getTime() ? original : undefined;
  const setting = (input.presets ?? DEFAULT_SNOOZE_PRESETS).find(
    (candidate) => candidate.kind === "after" && snoozePresetId(candidate) === input.id,
  );
  return (
    (setting && resolveSnoozePreset(setting, input.now, input.formatTime, input.resolve)) ?? ahead
  );
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

export function snoozeWakeLabel(
  snoozedUntil: string,
  options: { readonly now: string },
  resolve: MFunctionType = mFallback,
): string {
  const wakeMs = Date.parse(snoozedUntil);
  const nowMs = Date.parse(options.now);
  const now = () => resolve(msg("now", { $context: "a snoozed thread wakes now" }));
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return now();
  if (wakeMs <= nowMs) return now();
  // Count clock minutes: callers pass a minute-floored or live `now`, and durations keep seconds.
  const minutes = Math.max(1, Math.floor(wakeMs / 60_000) - Math.floor(nowMs / 60_000));
  if (minutes < 60) return resolve(msg("{minutes}m", { minutes: String(minutes) }));
  if (minutes < 24 * 60) {
    return resolve(msg("{hours}h", { hours: String(Math.ceil(minutes / 60)) }));
  }
  return resolve(msg("{days}d", { days: String(Math.ceil(minutes / (24 * 60))) }));
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

/**
 * Whether a woken thread woke after the user last saw it. A run that completed
 * after the last visit counts as seeing it, since the user watched it finish.
 */
export function isThreadWokeUnseen(input: {
  readonly wokeAt: string | null;
  readonly settled: boolean;
  readonly lastVisitedAt: string | null | undefined;
  readonly latestRunCompletedAt: string | null;
}): boolean {
  if (input.wokeAt === null || input.settled) return false;
  const wokeAtMs = Date.parse(input.wokeAt);
  if (Number.isNaN(wokeAtMs)) return false;
  const seenAt = [input.lastVisitedAt, input.latestRunCompletedAt]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((ms) => !Number.isNaN(ms));
  return seenAt.every((ms) => ms < wokeAtMs);
}

/**
 * Whether the latest run failed after the user last saw the thread. Only the run dates the
 * failure, since the shell's updatedAt also moves on renames. A failed run without a
 * completion time, from older data, is dated by its start.
 */
export function hasUnseenRunFailure(
  thread: Pick<EnvironmentThreadShell, "latestRun"> & {
    readonly lastVisitedAt?: string | null | undefined;
  },
): boolean {
  const run = thread.latestRun;
  if (run?.status !== "failed") return false;
  if (!thread.lastVisitedAt) return true;
  const failedAtMs = Date.parse(run.completedAt ?? run.startedAt ?? run.requestedAt ?? "");
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(failedAtMs) || Number.isNaN(lastVisitedAtMs)) return true;
  return failedAtMs > lastVisitedAtMs;
}
