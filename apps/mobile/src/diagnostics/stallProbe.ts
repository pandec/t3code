export const MOBILE_DIAGNOSTIC_STALL_INTERVAL_MS = 500;
export const MOBILE_DIAGNOSTIC_STALL_THRESHOLD_MS = 150;

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
