import type { ThreadGroup } from "@t3tools/contracts";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";

/** Reordering writes only the moved entry, preserving unrelated offline edits. */
export function planThreadGroupMove(
  groups: readonly ThreadGroup[],
  index: number,
  delta: number,
): ThreadGroup | null {
  const remaining = [...groups];
  const [group] = remaining.splice(index, 1);
  if (!group || index + delta < 0 || index + delta > remaining.length) return null;
  let destination = index + delta;
  // Concurrent creation can produce equal keys. Move past the tied run so
  // the new key still has distinct bounds without rewriting its neighbors.
  while (
    destination > 0 &&
    destination < remaining.length &&
    remaining[destination - 1]?.orderKey === remaining[destination]?.orderKey
  )
    destination += Math.sign(delta);
  const orderKey = pinOrderKeyBetween(
    remaining[destination - 1]?.orderKey ?? null,
    remaining[destination]?.orderKey ?? null,
  );
  return orderKey === null ? null : { ...group, orderKey };
}
