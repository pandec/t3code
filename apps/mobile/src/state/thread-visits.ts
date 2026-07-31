const MAX_THREAD_VISIT_MARKERS = 1_000;

/**
 * Records a visit with the thread's environment-issued `updatedAt`, exactly
 * as web does. Keeping the map device-local preserves unseen completion/wake
 * behavior across mobile process restarts without introducing server state.
 */
export function markThreadVisited(
  current: Readonly<Record<string, string>>,
  threadKey: string,
  visitedAt: string,
): Readonly<Record<string, string>> {
  const visitedAtMs = Date.parse(visitedAt);
  if (threadKey.length === 0 || Number.isNaN(visitedAtMs)) return current;

  const previous = current[threadKey];
  if (previous !== undefined) {
    const previousMs = Date.parse(previous);
    if (!Number.isNaN(previousMs) && previousMs >= visitedAtMs) return current;
  }

  const next = { ...current, [threadKey]: visitedAt };
  const entries = Object.entries(next);
  if (entries.length <= MAX_THREAD_VISIT_MARKERS) return next;

  entries.sort((left, right) => Date.parse(right[1]) - Date.parse(left[1]));
  return Object.fromEntries(entries.slice(0, MAX_THREAD_VISIT_MARKERS));
}
