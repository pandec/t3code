import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createSessionImportEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    candidates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:session-import:candidates",
      tag: WS_METHODS.sessionImportListCandidates,
    }),
    importSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:session-import:import",
      tag: WS_METHODS.sessionImportImport,
    }),
  };
}
