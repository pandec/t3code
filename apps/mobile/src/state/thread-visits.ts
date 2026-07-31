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

  return { ...current, [threadKey]: visitedAt };
}

export function mergeThreadVisits(
  persisted: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  let merged = persisted;
  for (const [threadKey, visitedAt] of Object.entries(current)) {
    merged = markThreadVisited(merged, threadKey, visitedAt);
  }
  return merged;
}
