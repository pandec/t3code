import { createLabsEnvironmentAtoms } from "@t3tools/client-runtime/state/labs";
import type { EnvironmentId, LabsInventory, LabsSnapshot, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery, type EnvironmentQueryView } from "./query";
import { waitForAtomValue } from "./waitForAtomValue";

/** Fork: SP Labs. One family per environment; every consumer shares the same keys. */
export const labsEnvironment = createLabsEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_INPUT = {} as const;

/**
 * The live snapshot. The server polls sp-labs while this is mounted, so only visible
 * consumers (an open Labs panel, a lab thread's header chip, the Lab-mode picker) call it.
 */
export function useLabsSnapshot(
  environmentId: EnvironmentId | null,
): EnvironmentQueryView<LabsSnapshot> {
  return useEnvironmentQuery(
    environmentId === null ? null : labsEnvironment.snapshot({ environmentId, input: EMPTY_INPUT }),
  );
}

/**
 * The cheap, non-polling lab worktree list; safe for sidebar rows. Every reader of one
 * environment shares one query atom, so a row adds a subscription, not a fetch.
 */
export function useLabsInventory(environmentId: EnvironmentId | null): LabsInventory | null {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : labsEnvironment.inventory({ environmentId, input: EMPTY_INPUT }),
  ).data;
}

/** Whether `projectId` is the environment's configured labs project. */
export function isLabsProjectInventory(
  inventory: LabsInventory | null,
  projectId: ProjectId | null,
): boolean {
  return (
    inventory !== null &&
    inventory.configured &&
    projectId !== null &&
    inventory.projectId === projectId
  );
}

/** The Labs panel also opens in the sp-labs project itself; Lab mode stays in the labs project. */
export function useIsLabsPanelProject(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): boolean {
  const inventory = useLabsInventory(projectId === null ? null : environmentId);
  return isLabsPanelProjectInventory(inventory, projectId);
}

export function isLabsPanelProjectInventory(
  inventory: LabsInventory | null,
  projectId: ProjectId | null,
): boolean {
  return (
    isLabsProjectInventory(inventory, projectId) ||
    (inventory !== null &&
      inventory.configured &&
      projectId !== null &&
      inventory.spLabsProjectId === projectId)
  );
}

/** The latest snapshot already in memory, without subscribing. */
export function readLabsSnapshot(environmentId: EnvironmentId): LabsSnapshot | null {
  const result = appAtomRegistry.get(
    labsEnvironment.snapshot({ environmentId, input: EMPTY_INPUT }),
  );
  return Option.getOrNull(AsyncResult.value(result));
}

/** The inventory, fetching it when nothing is cached yet; null when it does not arrive in time. */
export async function loadLabsInventory(
  environmentId: EnvironmentId,
  timeoutMs = 2_000,
): Promise<LabsInventory | null> {
  const atom = labsEnvironment.inventory({ environmentId, input: EMPTY_INPUT });
  await waitForAtomValue({
    registry: appAtomRegistry,
    atom,
    predicate: (result) => !result.waiting && result._tag !== "Initial",
    timeoutMs,
  });
  return Option.getOrNull(AsyncResult.value(appAtomRegistry.get(atom)));
}

/** Reservation changes refresh the inventory; so do saved labs settings. */
export function refreshLabsInventory(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(labsEnvironment.inventory({ environmentId, input: EMPTY_INPUT }));
}
