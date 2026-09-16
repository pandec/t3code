import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  type EnvironmentShellState,
} from "@t3tools/client-runtime/state/shell";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

function disconnectedEnvironmentIsSettled(connection: SupervisorConnectionState): boolean {
  if (connectionProjectionPhase(connection) !== "disconnected") {
    return false;
  }
  // A retrying environment is only transiently disconnected; give it its
  // first retries before treating its current shell as settled.
  return !(connection.phase === "backoff" && connection.desired && connection.attempt <= 2);
}

// Ported from apps/web/src/state/shell.ts: true once every cataloged
// environment either delivered a shell snapshot or is settled-disconnected.
// Gates the attention-filter snapshot so a late-loading environment cannot
// dump its entire (mostly quiet) thread list into the sticky membership as
// "newly appeared" threads.
export const allEnvironmentShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return false;
  }
  for (const environmentId of enabledEnvironmentIds(catalog.value)) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      continue;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (!disconnectedEnvironmentIsSettled(connection)) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("mobile-all-environment-shells-bootstrapped"));
const EMPTY_ENVIRONMENT_SHELL_STATE_ATOM = Atom.make(
  AsyncResult.success<EnvironmentShellState>({
    snapshot: Option.none(),
    archiveInvalidationSequence: 0,
    status: "empty",
    error: Option.none(),
  }),
).pipe(Atom.withLabel("mobile-environment-shell:empty"));

/** Reads one environment's shell projection without waiting on other environments. */
export function useEnvironmentShellState(environmentId: EnvironmentId | null) {
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_ENVIRONMENT_SHELL_STATE_ATOM
      : environmentShell.stateAtom(environmentId),
  );
  return Option.getOrElse(AsyncResult.value(result), () => ({
    snapshot: Option.none(),
    archiveInvalidationSequence: 0,
    status: "empty" as const,
    error: Option.none(),
  }));
}
