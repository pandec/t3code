import { QUEUED_RUN_EDIT_HOLD_LEASE_MS, type OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Fork: a client editing a queued message holds it via `queued-run.edit-hold` so it neither
 * starts nor is steered mid-edit. The hold is a renewed lease, so an abandoned edit stops
 * blocking the queue once it lapses.
 */

/** The queued run while a live edit hold keeps it from starting or being steered. */
export function isQueuedRunEditHeld(run: OrchestrationV2Run, now: DateTime.Utc): boolean {
  return (
    run.status === "queued" &&
    run.editHeldUntil !== undefined &&
    DateTime.isGreaterThan(run.editHeldUntil, now)
  );
}

/**
 * The run with `holderId`'s lease renewed from now, or released. Leases are
 * per editing session, so one client ending its edit never releases another
 * client's hold; lapsed leases are dropped on every change.
 */
export function withEditHold(
  run: OrchestrationV2Run,
  holderId: string,
  held: boolean,
  now: DateTime.Utc,
): OrchestrationV2Run {
  const { editHeldUntil: _editHeldUntil, editHolds, ...released } = run;
  const holds = (editHolds ?? []).filter(
    (hold) => hold.holderId !== holderId && DateTime.isGreaterThan(hold.until, now),
  );
  if (held) {
    holds.push({
      holderId,
      until: DateTime.add(now, { milliseconds: QUEUED_RUN_EDIT_HOLD_LEASE_MS }),
    });
  }
  if (holds.length === 0) return released;
  const latest = holds.reduce((max, hold) => DateTime.max(max, hold.until), holds[0]!.until);
  return { ...released, editHeldUntil: latest, editHolds: holds };
}
