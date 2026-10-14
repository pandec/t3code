import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Fork: SP Labs. `snapshot` is the live view; the server polls the CLI only while someone
 * subscribes, so it lets go soon after the last reader unmounts. `inventory` is the cheap
 * lab-worktree list for marking lab threads; reservation changes refresh it.
 */
export function createLabsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const inventoryGeneration = Atom.family((environmentId: string) =>
    Atom.make(0).pipe(
      Atom.withLabel(`environment-data:labs:inventory-generation:${environmentId}`),
    ),
  );
  const refreshInventory = (
    target: { readonly environmentId: string },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      const generation = inventoryGeneration(target.environmentId);
      registry.set(generation, registry.get(generation) + 1);
    });
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:labs:snapshot",
      tag: WS_METHODS.labsSubscribe,
      idleTtlMs: 15_000,
    }),
    inventory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:labs:inventory",
      tag: WS_METHODS.labsGetInventory,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => inventoryGeneration(environmentId),
    }),
    history: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:labs:history",
      tag: WS_METHODS.labsHistory,
    }),
    logs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:labs:logs",
      tag: WS_METHODS.labsLogs,
    }),
    prepareThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:labs:prepare-thread",
      tag: WS_METHODS.labsPrepareThread,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.labId}`,
      },
      onSuccess: refreshInventory,
    }),
    action: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:labs:action",
      tag: WS_METHODS.labsAction,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.envId}`,
      },
    }),
    release: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:labs:release",
      tag: WS_METHODS.labsRelease,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.labId}`,
      },
      onSuccess: refreshInventory,
    }),
  };
}
