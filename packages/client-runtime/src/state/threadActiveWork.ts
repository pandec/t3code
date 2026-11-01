import type { EnvironmentId } from "@t3tools/contracts";

import { parseScopedThreadKey, scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { effectiveSnoozed } from "./threadSettled.ts";

/** Fork: the Active work filter shared by the web sidebar and the mobile thread list. */

const ACTIVE_WORK_STATUSES: ReadonlySet<string> = new Set([
  "working",
  "monitoring",
  "waiting",
  "approval",
  "input",
  "request",
]);

/** A client's list status for a thread; "ready" is the resting state. */
type ResolveStatus<T> = (thread: T) => string;

/** Marked threads plus threads that are running or need the user right now. */
export function isActiveWorkThread<T extends Pick<EnvironmentThreadShell, "activeMarkedAt">>(
  thread: T,
  status: ResolveStatus<T>,
): boolean {
  return thread.activeMarkedAt != null || ACTIVE_WORK_STATUSES.has(status(thread));
}

function threadKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function isEligible(thread: EnvironmentThreadShell, now: string): boolean {
  return (
    thread.archivedAt === null &&
    thread.settledOverride !== "settled" &&
    !effectiveSnoozed(thread, { now })
  );
}

/** Threads stay in the filter after their work stops, until it is turned off or they are parked. */
export function nextActiveWorkThreadKeys<T extends EnvironmentThreadShell>(
  previous: readonly string[],
  enabled: boolean,
  threads: readonly T[],
  now: string,
  liveEnvironmentIds: ReadonlySet<EnvironmentId>,
  status: ResolveStatus<T>,
): readonly string[] {
  if (!enabled) return previous.length === 0 ? previous : [];
  // Live snapshots omit archived/deleted threads; missing offline shells prove no removal.
  const present = new Set(threads.map(threadKey));
  const next = new Set(
    previous.filter((key) => {
      const ref = parseScopedThreadKey(key);
      return ref !== null && (!liveEnvironmentIds.has(ref.environmentId) || present.has(key));
    }),
  );
  for (const thread of threads) {
    // Cached or resyncing shells can be stale, so only live ones change membership.
    if (!liveEnvironmentIds.has(thread.environmentId)) continue;
    const key = threadKey(thread);
    if (!isEligible(thread, now)) next.delete(key);
    else if (isActiveWorkThread(thread, status)) next.add(key);
  }
  return next.size === previous.length && previous.every((key) => next.has(key))
    ? previous
    : [...next];
}

export function matchesActiveWorkFilter<T extends EnvironmentThreadShell>(
  thread: T,
  options: {
    readonly retainedKeys: ReadonlySet<string>;
    readonly openThreadKey: string | null;
    readonly now: string;
    readonly status: ResolveStatus<T>;
    /** Unread completed replies, when the Include Done setting is on. */
    readonly includesDone?: ((thread: T) => boolean) | undefined;
  },
): boolean {
  const key = threadKey(thread);
  if (key === options.openThreadKey) return true;
  if (!isEligible(thread, options.now)) return false;
  return (
    options.retainedKeys.has(key) ||
    isActiveWorkThread(thread, options.status) ||
    (options.includesDone !== undefined &&
      options.status(thread) === "ready" &&
      options.includesDone(thread))
  );
}
