import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { threadLastActivityAt } from "./threadSettled.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * What the "Older" grouping needs from a thread. `movedToTopAt` counts as
 * activity on purpose: a manual move-to-top is the user saying the thread
 * matters again, and it would be absurd for a row to fall back into Older
 * the instant it was lifted out.
 */
export type ThreadOlderSource = Pick<
  OrchestrationThreadShell,
  | "createdAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "latestTurn"
  | "latestUserMessageAt"
  | "movedToTopAt"
  | "session"
>;

/**
 * The recency an Older row sorts and classifies by. `threadLastActivityAt`
 * covers messages and every turn stamp; creation time is the floor so a
 * thread that was opened and never used still ages, rather than reading as
 * infinitely old (null) or infinitely fresh.
 */
export function threadOlderRecencyAtMs(thread: ThreadOlderSource): number {
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.createdAt,
    threadLastActivityAt(thread),
    thread.movedToTopAt ?? null,
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
 * Blocked and live work is exempt, the same list effectiveSettled refuses to
 * classify away: an approval or user-input request is the agent waiting on
 * you, and a running session is work in flight. Either can outlive the
 * window — a request left unanswered for a fortnight is still a request —
 * and folding it behind a collapsed shelf would defeat it.
 *
 * Unparseable or missing timestamps never file a thread away: a row the
 * caller cannot date stays in the inbox where it is visible.
 */
export function threadIsOlder(
  thread: ThreadOlderSource,
  options: { readonly now: string; readonly afterDays: number },
): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  if (!Number.isFinite(options.afterDays) || options.afterDays <= 0) return false;
  const recencyMs = threadOlderRecencyAtMs(thread);
  if (!Number.isFinite(recencyMs)) return false;
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) return false;
  return recencyMs < nowMs - options.afterDays * DAY_MS;
}

/** Newest activity first — the same question the inbox above it answers. */
export function sortOlderThreadsForSidebar<T extends ThreadOlderSource & { readonly id: string }>(
  threads: readonly T[],
): T[] {
  return [...threads].toSorted(
    (left, right) =>
      threadOlderRecencyAtMs(right) - threadOlderRecencyAtMs(left) ||
      left.id.localeCompare(right.id),
  );
}
