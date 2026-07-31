import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type PropsWithChildren,
  type SetStateAction,
} from "react";

import { allEnvironmentShellsBootstrappedAtom } from "../../state/shell";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { markThreadVisited, mergeThreadVisits } from "../../state/thread-visits";
import {
  admitNewThreadAttentionThreads,
  createThreadAttentionFilter,
  type ThreadAttentionFilterState,
} from "./threadAttention";
import { useThreadListV2Enabled } from "./use-thread-list-v2-enabled";

const THREAD_VISIT_PERSIST_DEBOUNCE_MS = 500;

type AttentionFilterContextValue = {
  readonly state: ThreadAttentionFilterState | null;
  readonly setState: Dispatch<SetStateAction<ThreadAttentionFilterState | null>>;
  readonly lastVisitedAtByThreadKey: Readonly<Record<string, string>>;
  readonly visitsReady: boolean;
  readonly recordVisit: (threadKey: string, visitedAt: string) => void;
};

const ThreadAttentionFilterContext = createContext<AttentionFilterContextValue | null>(null);

/** Keeps sticky attention membership stable while the app moves between the
    compact Home shell and the split-view sidebar (same contract as
    HomeListOptionsProvider). */
export function ThreadAttentionFilterProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<ThreadAttentionFilterState | null>(null);
  const [lastVisitedAtByThreadKey, setLastVisitedAtByThreadKey] = useState<
    Readonly<Record<string, string>>
  >({});
  const [visitsReady, setVisitsReady] = useState(false);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const didHydrateVisitsRef = useRef(false);
  const visitsDirtyRef = useRef(false);
  const threadListV2Enabled = useThreadListV2Enabled();

  useEffect(() => {
    if (didHydrateVisitsRef.current || !AsyncResult.isSuccess(preferencesResult)) return;
    didHydrateVisitsRef.current = true;
    setLastVisitedAtByThreadKey((current) =>
      mergeThreadVisits(preferencesResult.value.threadLastVisitedAtById ?? {}, current),
    );
    setVisitsReady(true);
  }, [preferencesResult]);

  const recordVisit = useCallback((threadKey: string, visitedAt: string) => {
    setLastVisitedAtByThreadKey((current) => {
      const next = markThreadVisited(current, threadKey, visitedAt);
      if (next !== current) visitsDirtyRef.current = true;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!visitsReady || !visitsDirtyRef.current) return;
    const timeout = setTimeout(() => {
      visitsDirtyRef.current = false;
      savePreferences({ threadLastVisitedAtById: lastVisitedAtByThreadKey });
    }, THREAD_VISIT_PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [lastVisitedAtByThreadKey, savePreferences, visitsReady]);

  useEffect(() => {
    if (!threadListV2Enabled) setState(null);
  }, [threadListV2Enabled]);

  const value = useMemo(
    () => ({
      state,
      setState,
      lastVisitedAtByThreadKey,
      visitsReady,
      recordVisit,
    }),
    [lastVisitedAtByThreadKey, recordVisit, state, visitsReady],
  );
  return (
    <ThreadAttentionFilterContext.Provider value={value}>
      {children}
    </ThreadAttentionFilterContext.Provider>
  );
}

export function useRecordThreadVisit(): (threadKey: string, visitedAt: string) => void {
  const shared = useContext(ThreadAttentionFilterContext);
  if (shared === null) {
    throw new Error("useRecordThreadVisit must be used inside ThreadAttentionFilterProvider");
  }
  return shared.recordVisit;
}

export interface ThreadAttentionFilter {
  readonly enabled: boolean;
  /** False while any environment's thread shells are still loading; the
      toggle stays disabled so a snapshot cannot miss late shells. */
  readonly ready: boolean;
  /** Sticky member keys while enabled, null while disabled. */
  readonly memberThreadKeys: ReadonlySet<string> | null;
  /** Queued tasks admitted after the snapshot, null while disabled. */
  readonly memberPendingTaskKeys: ReadonlySet<string> | null;
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
  pendingTaskKeys: ReadonlyArray<string> = [],
): ThreadAttentionFilter {
  const bootstrapped = useAtomValue(allEnvironmentShellsBootstrappedAtom);
  const shared = useContext(ThreadAttentionFilterContext);
  const visitsReady = shared?.visitsReady ?? false;
  const lastVisitedAtByThreadKey = useMemo(
    () => new Map(Object.entries(shared?.lastVisitedAtByThreadKey ?? {})),
    [shared?.lastVisitedAtByThreadKey],
  );
  const [localState, setLocalState] = useState<ThreadAttentionFilterState | null>(null);
  const state = shared?.state ?? localState;
  const setState = shared?.setState ?? setLocalState;

  // Admission is derived synchronously so a shell created through the CLI or
  // another client never flashes out of the filtered list for one render. The
  // effect only commits the grown known/member sets for the next update.
  const effectiveState = useMemo(
    () => (state === null ? null : admitNewThreadAttentionThreads(state, threads, pendingTaskKeys)),
    [pendingTaskKeys, state, threads],
  );
  useEffect(() => {
    if (effectiveState !== null && effectiveState !== state) {
      setState(effectiveState);
    }
  }, [effectiveState, setState, state]);

  const toggle = useCallback(() => {
    setState((current) => {
      if (current !== null) return null;
      if (!bootstrapped || !visitsReady) return null;
      return createThreadAttentionFilter({
        threads,
        pendingTaskKeys,
        now: new Date().toISOString(),
        lastVisitedAtByThreadKey,
      });
    });
  }, [bootstrapped, lastVisitedAtByThreadKey, pendingTaskKeys, setState, threads, visitsReady]);
  const clear = useCallback(() => {
    setState(null);
  }, [setState]);

  return {
    enabled: effectiveState !== null,
    ready: bootstrapped && visitsReady,
    memberThreadKeys: effectiveState?.memberThreadKeys ?? null,
    memberPendingTaskKeys: effectiveState?.memberPendingTaskKeys ?? null,
    toggle,
    clear,
  };
}
