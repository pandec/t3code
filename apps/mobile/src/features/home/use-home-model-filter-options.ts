import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useMemo } from "react";

import { environmentServerConfigsAtom } from "../../state/server";
import { buildHomeModelFilterOptions } from "./home-model-filter";

/**
 * Filter-menu model options, plus the availability set `useHomeListOptions`
 * needs to mask a pin whose model no longer appears in any live thread. Both
 * thread-list shells derive these identically, so they are assembled once
 * here. Kept out of `home-model-filter.ts` so the derivation itself stays
 * free of React Native imports and unit-testable.
 */
export function useHomeModelFilterOptions(threads: ReadonlyArray<EnvironmentThreadShell>) {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const modelFilterOptions = useMemo(
    () => buildHomeModelFilterOptions({ threads, serverConfigs }),
    [serverConfigs, threads],
  );
  const availableModels = useMemo(
    () => new Set(modelFilterOptions.map((model) => model.key)),
    [modelFilterOptions],
  );
  return { modelFilterOptions, availableModels, serverConfigs } as const;
}
