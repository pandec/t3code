import { create } from "zustand";

/**
 * Fork: per-thread Compact/Full chip overrides, keyed by `scopedThreadKey`.
 * Lives outside ChatView so an override survives the pane remounting it for
 * another thread; in-memory only, the staleSessionSend setting is the default.
 */
interface KeepFullHistoryOverrideStoreState {
  overrides: ReadonlyMap<string, boolean>;
  /** Sets the thread's override, or drops it with `null`. */
  setOverride: (threadKey: string, keep: boolean | null) => void;
}

export const useKeepFullHistoryOverrideStore = create<KeepFullHistoryOverrideStoreState>()(
  (set) => ({
    overrides: new Map(),
    setOverride: (threadKey, keep) =>
      set((state) => {
        if ((state.overrides.get(threadKey) ?? null) === keep) return state;
        const overrides = new Map(state.overrides);
        if (keep === null) overrides.delete(threadKey);
        else overrides.set(threadKey, keep);
        return { overrides };
      }),
  }),
);
