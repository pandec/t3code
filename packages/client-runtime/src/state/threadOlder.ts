import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { threadLastActivityAt, threadWokeAt } from "./threadSettled.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * What the "Older" grouping needs from a thread: everything that counts as
 * the thread being alive, plus the two ways it can be blocked on the user.
 */
export type ThreadOlderSource = Pick<
  OrchestrationThreadShell,
  | "backgroundLiveness"
  | "createdAt"
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "latestTurn"
  | "latestUserMessageAt"
  | "movedToTopAt"
  | "session"
  | "snoozedAt"
  | "snoozedUntil"
>;

/**
 * The recency an Older row both sorts and classifies by, so the shelf can
 * never order by one clock and file rows away by another.
 *
 * `threadLastActivityAt` covers messages and every turn stamp. Creation time
 * is the floor, so a thread opened and never used still ages instead of
 * reading as undateable. A manual move to top counts as activity — it is the
 * user saying the thread matters again, and a row lifted to the top must not
 * fall straight back down. So does a snooze wake: "show me this on the 1st"
 * is answered by the thread reappearing in the list, not by it landing in a
 * folded shelf still aged from the work it was snoozed on top of.
 */
export function threadOlderRecencyAtMs(
  thread: ThreadOlderSource,
  options: { readonly now: string },
): number {
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.createdAt,
    threadLastActivityAt(thread),
    thread.movedToTopAt ?? null,
    threadWokeAt(thread, { now: options.now }),
  ]) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed) && parsed > latestMs) latestMs = parsed;
  }
  return latestMs;
}

/**
 * Whether a thread belongs in the sidebar's "Older" section: nothing has
 * happened in it for longer than the configured window. Unlike settling,
 * this is purely derived from timestamps — no server state, no user action,
 * and it reverses itself the moment the thread is touched again.
 *
 * Live and blocked work is exempt however long it has sat there. A running
 * session, native background work that outlives the turn (subagents, watch
 * loops), an approval or input request, and an undecided plan all paint a
 * row that says the thread is alive or waiting on the user; folding those
 * behind a collapsed shelf would contradict the row and defeat the request.
 *
 * Unparseable or missing timestamps never file a thread away: a row the
 * caller cannot date stays in the list where it is visible.
 */
export function threadIsOlder(
  thread: ThreadOlderSource,
  options: { readonly now: string; readonly afterDays: number },
): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.hasActionableProposedPlan) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  if (thread.backgroundLiveness != null) return false;
  if (!Number.isFinite(options.afterDays) || options.afterDays <= 0) return false;
  const recencyMs = threadOlderRecencyAtMs(thread, options);
  if (!Number.isFinite(recencyMs)) return false;
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) return false;
  return recencyMs < nowMs - options.afterDays * DAY_MS;
}

/**
 * Newest activity first — the same question the list above it answers. The
 * key is computed once per thread rather than inside the comparator: this is
 * by construction the largest bucket, and it is re-sorted on every shell
 * update.
 */
export function sortOlderThreadsForSidebar<T extends ThreadOlderSource & { readonly id: string }>(
  threads: readonly T[],
  options: { readonly now: string },
): T[] {
  // .sort() on the mapped copy, not .toSorted(): client-runtime state modules
  // are bundled into the mobile app and Hermes lacks the ES2023 method.
  const decorated = threads.map((thread) => ({
    thread,
    recencyMs: threadOlderRecencyAtMs(thread, options),
  }));
  decorated.sort(
    (left, right) =>
      right.recencyMs - left.recencyMs || left.thread.id.localeCompare(right.thread.id),
  );
  return decorated.map((entry) => entry.thread);
}
