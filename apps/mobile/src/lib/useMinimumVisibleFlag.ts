import { useState } from "react";

import { useDeadlinePassed } from "./clock";

/** Holds a transient indicator through its minimum duration, including a restart while held. */
export function useMinimumVisibleFlag(active: boolean, minVisibleMs: number): boolean {
  const [shownAt, setShownAt] = useState<number | null>(() => (active ? Date.now() : null));
  if (active && shownAt === null) setShownAt(() => Date.now());
  const passed = useDeadlinePassed(shownAt === null || active ? null : shownAt + minVisibleMs);
  if (!active && passed && shownAt !== null) setShownAt(null);
  return active || (shownAt !== null && !passed);
}
