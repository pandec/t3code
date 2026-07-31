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
} from "@t3tools/client-runtime/state/shell";
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
  for (const environmentId of catalog.value.entries.keys()) {
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
