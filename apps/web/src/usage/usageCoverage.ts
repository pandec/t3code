/**
 * Terminal-vs-pending classification of each environment's usage answer.
 *
 * A saved environment that is not connected never runs its usage query: the
 * underlying query atom waits for a connection indefinitely. Without looking
 * at the connection phase the page would count such an environment as "still
 * scanning" forever and never leave the loading skeleton. Classification is
 * pure so the offline rules can be tested directly.
 *
 * "Terminal" is per render, not sticky: if an unreachable environment later
 * connects, the presentations atom recomputes and the environment moves back
 * through `reporting` to `reported`.
 *
 * @module usageCoverage
 */
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { UsageSummary } from "@t3tools/contracts";

/** One environment's answer, reduced to what the page can act on. */
export type EnvironmentUsageState =
  /** Answered; its summary contributes to the merged totals. */
  | { readonly kind: "reported"; readonly summary: UsageSummary }
  /** Connected (or still connecting) and expected to answer. */
  | { readonly kind: "reporting" }
  /** Reachable, but the scan itself failed. Terminal. */
  | { readonly kind: "failed" }
  /** Saved but not connected; it cannot answer. Terminal. */
  | { readonly kind: "unreachable" };

/**
 * Whether the query can still produce an answer from this phase.
 * `reconnecting` deliberately cannot: an environment stuck in its retry loop
 * would hold the page forever, and if it does come back the classification
 * self-corrects.
 */
function canAnswer(phase: EnvironmentConnectionPhase): boolean {
  return phase === "connected" || phase === "connecting";
}

export function classifyEnvironmentUsage(input: {
  readonly phase: EnvironmentConnectionPhase;
  readonly failed: boolean;
  readonly summary: UsageSummary | null;
}): EnvironmentUsageState {
  // A summary cached from an earlier connection stays useful after a drop:
  // partial coverage beats discarding data the environment already produced.
  if (input.summary !== null) return { kind: "reported", summary: input.summary };
  if (input.failed) return { kind: "failed" };
  return canAnswer(input.phase) ? { kind: "reporting" } : { kind: "unreachable" };
}

/**
 * Page-level progress: pending until the first answer, partial until the last.
 * Only `reporting` environments count as outstanding — failed and unreachable
 * ones are terminal, so totals will not improve by waiting on them.
 */
export function usageProgress(states: readonly EnvironmentUsageState[]): {
  readonly isPending: boolean;
  readonly isPartial: boolean;
} {
  const reported = states.filter((state) => state.kind === "reported").length;
  const reporting = states.filter((state) => state.kind === "reporting").length;
  return {
    isPending: reported === 0 && reporting > 0,
    isPartial: reported > 0 && reporting > 0,
  };
}
