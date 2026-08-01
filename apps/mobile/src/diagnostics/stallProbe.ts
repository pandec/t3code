export const MOBILE_DIAGNOSTIC_STALL_INTERVAL_MS = 500;
export const MOBILE_DIAGNOSTIC_STALL_THRESHOLD_MS = 150;

/**
 * A hang this long is the most likely precursor to an iOS watchdog kill, which
 * takes the whole in-memory batch with it. Stalls at or above this are persisted
 * immediately instead of waiting for the periodic flush; the probe interval caps
 * that at roughly one small append per second, and only while already degraded.
 */
export const MOBILE_DIAGNOSTIC_STALL_DURABLE_MS = 1_000;

export function eventLoopStallDuration(expectedAtMs: number, observedAtMs: number): number {
  return Math.max(0, observedAtMs - expectedAtMs);
}

export function eventLoopStallBucket(durationMs: number): string {
  if (durationMs >= 2_000) return "2000+";
  if (durationMs >= 1_000) return "1000-1999";
  if (durationMs >= 500) return "500-999";
  if (durationMs >= 250) return "250-499";
  return "150-249";
}
