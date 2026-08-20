import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveThreadListV2ArchiveQueueEnabled, resolveThreadListV2Enabled } from "./threadListV2";

/**
 * Resolved Thread List v2 state: on unless the device opted into the legacy
 * grouped list (Settings → Legacy). Every consumer must read through this
 * rather than the raw preference, which is undefined until explicitly chosen.
 */
export function useThreadListV2State(): {
  readonly enabled: boolean;
  readonly archiveQueueEnabled: boolean;
} {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferencesLoaded = AsyncResult.isSuccess(preferencesResult);
  const input = {
    legacyPreference: preferencesLoaded
      ? preferencesResult.value.legacyThreadListEnabled
      : undefined,
    preferencesLoaded,
  };
  return {
    enabled: resolveThreadListV2Enabled(input),
    archiveQueueEnabled: resolveThreadListV2ArchiveQueueEnabled(input),
  };
}

export function useThreadListV2Enabled(): boolean {
  return useThreadListV2State().enabled;
}
