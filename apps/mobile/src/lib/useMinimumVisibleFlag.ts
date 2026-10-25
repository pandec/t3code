import { useEffect, useRef, useState } from "react";

/**
 * Holds a transient flag on for at least `minVisibleMs` so fast background work does not strobe
 * its indicator, without delaying its appearance. Re-arming while still held keeps the original
 * onset: the indicator never visibly disappeared.
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
