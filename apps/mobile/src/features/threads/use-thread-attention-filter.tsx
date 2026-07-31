import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type PropsWithChildren,
  type SetStateAction,
} from "react";

import { allEnvironmentShellsBootstrappedAtom } from "../../state/shell";
import { threadVisitRegistry } from "../../state/thread-visits";
import {
  admitNewThreadAttentionThreads,
  createThreadAttentionFilter,
  type ThreadAttentionFilterState,
} from "./threadAttention";

type AttentionFilterContextValue = {
  readonly state: ThreadAttentionFilterState | null;
  readonly setState: Dispatch<SetStateAction<ThreadAttentionFilterState | null>>;
};

const ThreadAttentionFilterContext = createContext<AttentionFilterContextValue | null>(null);

/** Keeps sticky attention membership stable while the app moves between the
    compact Home shell and the split-view sidebar (same contract as
    HomeListOptionsProvider). */
export function ThreadAttentionFilterProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<ThreadAttentionFilterState | null>(null);
  const value = useMemo(() => ({ state, setState }), [state]);
  return (
    <ThreadAttentionFilterContext.Provider value={value}>
      {children}
    </ThreadAttentionFilterContext.Provider>
  );
}

export interface ThreadAttentionFilter {
  readonly enabled: boolean;
  /** False while any environment's thread shells are still loading; the
      toggle stays disabled so a snapshot cannot miss late shells. */
  readonly ready: boolean;
  /** Sticky member keys while enabled, null while disabled. */
  readonly memberThreadKeys: ReadonlySet<string> | null;
  readonly toggle: () => void;
  readonly clear: () => void;
}

/**
 * Sticky attention filter over the full shell list (mirrors the web sidebar
 * v2): enabling snapshots the threads that currently need attention;
 * membership never shrinks while enabled; any thread first seen after the
 * snapshot is admitted; toggling off and on refreshes the snapshot.
 */
export function useThreadAttentionFilter(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ThreadAttentionFilter {
  const bootstrapped = useAtomValue(allEnvironmentShellsBootstrappedAtom);
  const shared = useContext(ThreadAttentionFilterContext);
  const [localState, setLocalState] = useState<ThreadAttentionFilterState | null>(null);
  const state = shared?.state ?? localState;
  const setState = shared?.setState ?? setLocalState;

  // Admission is derived synchronously so a shell created through the CLI or
  // another client never flashes out of the filtered list for one render. The
  // effect only commits the grown known/member sets for the next update.
  const effectiveState = useMemo(
    () => (state === null ? null : admitNewThreadAttentionThreads(state, threads)),
    [state, threads],
  );
  useEffect(() => {
    if (effectiveState !== null && effectiveState !== state) {
      setState(effectiveState);
    }
  }, [effectiveState, setState, state]);

  const toggle = useCallback(() => {
    setState((current) => {
      if (current !== null) return null;
      if (!bootstrapped) return null;
      return createThreadAttentionFilter({
        threads,
        now: new Date().toISOString(),
        lastVisitedAtByThreadKey: threadVisitRegistry.lastVisitedAtByThreadKey(),
      });
    });
  }, [bootstrapped, setState, threads]);
  const clear = useCallback(() => {
    setState(null);
  }, [setState]);

  return {
    enabled: effectiveState !== null,
    ready: bootstrapped,
    memberThreadKeys: effectiveState?.memberThreadKeys ?? null,
    toggle,
    clear,
  };
}
