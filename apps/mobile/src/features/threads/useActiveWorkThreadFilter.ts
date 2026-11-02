import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  matchesActiveWorkFilter,
  nextActiveWorkThreadKeys,
} from "@t3tools/client-runtime/state/thread-active-work";
import { useEffect, useMemo } from "react";

import { updateMobilePreferencesAtom } from "../../state/preferences";
import { liveShellEnvironmentIdsAtom } from "../../state/presentation";
import { useActiveWorkFilter, useMobilePreferences } from "../../state/use-mobile-preferences";
import { resolveThreadListV2Status, threadHasUnseenCompletion } from "./threadListV2";

const NO_RETAINED_KEYS: readonly string[] = [];

/** Fork: the Active work filter's row predicate, or null while the filter is off. */
export function useActiveWorkThreadFilter(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: string;
  readonly openThreadKey: string | null;
  /** False while the threads are a held snapshot, which must not overwrite live membership. */
  readonly persists: boolean;
}): ((thread: EnvironmentThreadShell) => boolean) | null {
  const { threads, now, openThreadKey } = input;
  const { enabled, includeDone } = useActiveWorkFilter();
  const { preferences, hydrated } = useMobilePreferences();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const liveEnvironmentIds = useAtomValue(liveShellEnvironmentIdsAtom);
  const stored = preferences.activeWorkThreadKeys ?? NO_RETAINED_KEYS;
  const next = nextActiveWorkThreadKeys(
    stored,
    enabled,
    threads,
    now,
    liveEnvironmentIds,
    resolveThreadListV2Status,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Persist filter membership across launches, like the web sidebar.
  useEffect(() => {
    if (!input.persists || !hydrated || next === stored) return;
    savePreferences({
      transform: (current) => ({
        activeWorkThreadKeys: nextActiveWorkThreadKeys(
          current.activeWorkThreadKeys ?? NO_RETAINED_KEYS,
          enabled,
          threads,
          now,
          liveEnvironmentIds,
          resolveThreadListV2Status,
        ),
      }),
    });
  }, [
    enabled,
    hydrated,
    input.persists,
    liveEnvironmentIds,
    next,
    now,
    savePreferences,
    stored,
    threads,
  ]);
  // The thread list memoizes its layout on this predicate, so keep it stable between renders.
  return useMemo(() => {
    if (!enabled) return null;
    const retainedKeys = new Set(next);
    return (thread: EnvironmentThreadShell) =>
      matchesActiveWorkFilter(thread, {
        retainedKeys,
        openThreadKey,
        now,
        status: resolveThreadListV2Status,
        includesDone: includeDone ? threadHasUnseenCompletion : undefined,
      });
  }, [enabled, next, openThreadKey, now, includeDone]);
}
