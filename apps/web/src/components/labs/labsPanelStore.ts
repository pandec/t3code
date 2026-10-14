import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { useRightPanelStore } from "../../rightPanelStore";

/**
 * Fork (SP Labs): which lab the Labs surface shows in detail, per thread. Session-only: a reload
 * opens the list.
 */
interface LabsPanelState {
  readonly selectedLabByThreadKey: Readonly<Record<string, string>>;
  readonly select: (threadRef: ScopedThreadRef, labId: string | null) => void;
}

export const useLabsPanelStore = create<LabsPanelState>()((set) => ({
  selectedLabByThreadKey: {},
  select: (threadRef, labId) =>
    set((state) => {
      const key = scopedThreadKey(threadRef);
      if ((state.selectedLabByThreadKey[key] ?? null) === labId) return state;
      const { [key]: _previous, ...rest } = state.selectedLabByThreadKey;
      return { selectedLabByThreadKey: labId === null ? rest : { ...rest, [key]: labId } };
    }),
}));

export function useSelectedLab(threadRef: ScopedThreadRef | null): string | null {
  return useLabsPanelStore((state) =>
    threadRef === null ? null : (state.selectedLabByThreadKey[scopedThreadKey(threadRef)] ?? null),
  );
}

/** Opens the thread's Labs surface, on `labId`'s detail when given, else on the list. */
export function openLabsPanel(threadRef: ScopedThreadRef, labId: string | null = null): void {
  useLabsPanelStore.getState().select(threadRef, labId);
  useRightPanelStore.getState().open(threadRef, "labs");
}
