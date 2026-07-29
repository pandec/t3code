import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadPrewarmAtoms,
  createThreadPrewarmSummaryAtom,
} from "@t3tools/client-runtime/state/threads";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const environmentThreadPrewarm = createEnvironmentThreadPrewarmAtoms(connectionAtomRuntime);

export const threadPrewarmSummaryAtom = createThreadPrewarmSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  statusAtom: environmentThreadPrewarm.statusAtom,
});

/**
 * Keeps the per-environment thread prewarm streams mounted for as long as the
 * caller stays mounted. See `threadPrewarm.ts` in client-runtime.
 */
export function useThreadPrewarm(): void {
  useAtomValue(threadPrewarmSummaryAtom);
}
