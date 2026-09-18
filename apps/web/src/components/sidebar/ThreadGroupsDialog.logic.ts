import type { ThreadGroup } from "@t3tools/contracts";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import { threadGroupSections } from "@t3tools/shared/threadGroups";

/** Move one row of the dialog list (groups plus the Active divider) by
 * `delta`. The result always states its side explicitly; the new orderKey
 * sits between the neighbors on that side. Only the moved entry is written,
 * preserving unrelated offline edits. */
export function planThreadGroupMove(
  groups: readonly ThreadGroup[],
  index: number,
  delta: number,
): ThreadGroup | null {
  const sections = threadGroupSections(groups);
  const group = sections[index];
  if (!group || index + delta < 0 || index + delta >= sections.length) return null;
  const remaining = sections.filter((_, i) => i !== index);
  let destination = index + delta;
  // Concurrent creation can produce equal keys. Move past the tied run so
  // the new key still has distinct bounds without rewriting its neighbors.
  while (
    destination > 0 &&
    destination < remaining.length &&
    remaining[destination - 1]?.orderKey === remaining[destination]?.orderKey
  )
    destination += Math.sign(delta);
  const aboveActive = remaining.indexOf(null) >= destination;
  // Active is a null bound: keys only order groups within one side.
  const orderKey = pinOrderKeyBetween(
    remaining[destination - 1]?.orderKey ?? null,
    remaining[destination]?.orderKey ?? null,
  );
  if (orderKey === null) return null;
  return { ...group, orderKey, aboveActive };
}

/** New groups always start at the bottom of the below-Active side. */
export function newThreadGroupOrderKey(groups: readonly ThreadGroup[]): string {
  const last = groups.filter((group) => group.aboveActive !== true).at(-1);
  return pinOrderKeyBetween(last?.orderKey ?? null, null) ?? "n";
}
