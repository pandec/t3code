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

export function isEnvironmentShellReadyForTurnCompletion(
  shell: EnvironmentShellState,
  connection: Option.Option<SupervisorConnectionState>,
): boolean {
  if (Option.isNone(connection)) {
    return false;
  }
  if (connectionProjectionPhase(connection.value) === "ready") {
    return shell.status === "live";
  }
  return disconnectedEnvironmentIsSettled(connection.value);
}

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
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));

export const environmentIdsReadyForTurnCompletionAtom = Atom.make((get) => {
  const readyEnvironmentIds = new Set<EnvironmentId>();
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return readyEnvironmentIds;
  }
  for (const environmentId of catalog.value.entries.keys()) {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    const connection = AsyncResult.value(get(environmentCatalog.stateAtom(environmentId)));
    if (isEnvironmentShellReadyForTurnCompletion(shell, connection)) {
      readyEnvironmentIds.add(environmentId);
    }
  }
  return readyEnvironmentIds;
}).pipe(Atom.withLabel("web-environment-ids-ready-for-turn-completion"));
