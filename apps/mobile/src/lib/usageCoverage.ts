import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { UsageSummary } from "@t3tools/contracts";

export type EnvironmentUsageState =
  | { readonly kind: "reported"; readonly summary: UsageSummary }
  | { readonly kind: "reporting" }
  | { readonly kind: "failed" }
  | { readonly kind: "unreachable" };

function canAnswer(phase: EnvironmentConnectionPhase): boolean {
  return phase === "connected" || phase === "connecting";
}

export function classifyEnvironmentUsage(input: {
  readonly phase: EnvironmentConnectionPhase;
  readonly failed: boolean;
  readonly summary: UsageSummary | null;
}): EnvironmentUsageState {
  if (input.summary !== null) return { kind: "reported", summary: input.summary };
  if (input.failed) return { kind: "failed" };
  return canAnswer(input.phase) ? { kind: "reporting" } : { kind: "unreachable" };
}

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
