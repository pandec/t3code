/**
 * In-memory per-thread last-visited timestamps, feeding the attention
 * filter's unseen-completion / unseen-wake criteria (threadAttention.ts).
 *
 * Deliberately NOT persisted: web keeps threadLastVisitedAtById in
 * localStorage, but mobile does not need a persistent visit-tracking
 * subsystem for the sticky attention snapshot — after an app restart every
 * thread simply reads as never-visited, which is the same semantics web
 * applies to a thread never opened in that browser. Reads happen only at
 * snapshot time (attention toggle-on), so the registry is not reactive.
 */

export interface ThreadVisitRegistry {
  /** Records a visit; keeps the newest valid timestamp per thread. */
  readonly recordVisit: (threadKey: string, visitedAt: string) => void;
  readonly lastVisitedAtByThreadKey: () => ReadonlyMap<string, string>;
}

export function createThreadVisitRegistry(): ThreadVisitRegistry {
  const visits = new Map<string, string>();
  return {
    recordVisit: (threadKey, visitedAt) => {
      const visitedAtMs = Date.parse(visitedAt);
      if (Number.isNaN(visitedAtMs)) return;
      const current = visits.get(threadKey);
      if (current !== undefined) {
        const currentMs = Date.parse(current);
        if (!Number.isNaN(currentMs) && currentMs >= visitedAtMs) return;
      }
      visits.set(threadKey, visitedAt);
    },
    lastVisitedAtByThreadKey: () => visits,
  };
}

export const threadVisitRegistry = createThreadVisitRegistry();
