import type {
  ConnectionTargetKind,
  SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { safeTraceId } from "@t3tools/client-runtime/errors";
import type { EnvironmentId } from "@t3tools/contracts";

export type MobileDiagnosticValue = string | number | boolean | null;
export type MobileDiagnosticDetails = Readonly<Record<string, MobileDiagnosticValue>>;

export interface MobileDiagnosticEvent {
  readonly t: number;
  readonly m: number;
  readonly k: string;
  readonly d: MobileDiagnosticDetails;
}

export function mobileDiagnosticEvent(
  kind: string,
  details: MobileDiagnosticDetails,
  wallTimeMs: number,
  monotonicTimeMs: number,
): MobileDiagnosticEvent {
  return {
    t: wallTimeMs,
    m: Number(monotonicTimeMs.toFixed(1)),
    k: kind,
    d: details,
  };
}

export function diagnosticEnvironmentKey(environmentId: EnvironmentId): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < environmentId.length; index += 1) {
    hash ^= environmentId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function connectionDiagnosticDetails(
  environmentId: EnvironmentId,
  targetKind: ConnectionTargetKind,
  state: SupervisorConnectionState,
  nowMs: number,
): MobileDiagnosticDetails {
  return {
    env: diagnosticEnvironmentKey(environmentId),
    target: targetKind,
    desired: state.desired,
    network: state.network,
    phase: state.phase,
    stage: state.stage,
    attempt: state.attempt,
    generation: state.generation,
    failure: state.lastFailure?._tag ?? null,
    reason: state.lastFailure?.reason ?? null,
    // Every other field here is an enum, count, or digest. A trace id is the one
    // value a remote peer supplies as free-form text, so it goes through the same
    // gate the runtime uses before logging it rather than straight to disk.
    traceId: safeTraceId(state.lastFailure?.traceId),
    retryInMs: state.retryAt === null ? null : Math.max(0, state.retryAt - nowMs),
  };
}
