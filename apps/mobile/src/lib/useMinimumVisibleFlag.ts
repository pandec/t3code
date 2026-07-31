import { useEffect, useRef, useState } from "react";

/**
 * Holds a transient boolean on for at least `minVisibleMs` after it first
 * turns on. Background work that finishes in a few hundred milliseconds would
 * otherwise strobe its indicator; this makes the indicator readable without
 * delaying its appearance.
 *
 * Re-arming while the flag is still held keeps the original onset — the
 * indicator never visibly disappeared, so the minimum is already satisfied.
 */
export function useMinimumVisibleFlag(active: boolean, minVisibleMs: number): boolean {
  const [held, setHeld] = useState(false);
  const shownAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (active) {
      shownAtRef.current ??= Date.now();
      setHeld(true);
      return;
    }
    const shownAt = shownAtRef.current;
    if (shownAt === null) return;
    const release = () => {
      shownAtRef.current = null;
      setHeld(false);
    };
    const remaining = minVisibleMs - (Date.now() - shownAt);
    if (remaining <= 0) {
      release();
      return;
    }
    const timer = setTimeout(release, remaining);
    return () => clearTimeout(timer);
  }, [active, minVisibleMs]);

  return active || held;
}
