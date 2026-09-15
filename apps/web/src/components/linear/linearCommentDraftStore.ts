import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export function linearCommentDraftKey(
  environmentId: EnvironmentId,
  threadRef: ScopedThreadRef | null,
  issueId: string,
): string {
  return JSON.stringify([environmentId, threadRef?.threadId ?? null, issueId]);
}

interface LinearCommentDraftStore {
  readonly drafts: Readonly<Record<string, { readonly body: string; readonly posting: boolean }>>;
  readonly setBody: (key: string, body: string) => void;
  readonly beginPost: (key: string) => string | null;
  readonly finishPost: (key: string, posted: boolean) => void;
}

// Panels unmount when another tab opens. Keep drafts and pending posts for this browser session,
// scoped by issue UUID so changing workspaces cannot attach a draft to a reused identifier.
export const useLinearCommentDraftStore = create<LinearCommentDraftStore>()((set, get) => ({
  drafts: {},
  setBody: (key, body) =>
    set((state) => {
      if (state.drafts[key]?.posting) return state;
      if (body.length > 0) {
        return { drafts: { ...state.drafts, [key]: { body, posting: false } } };
      }
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
    }),
  beginPost: (key) => {
    const draft = get().drafts[key];
    if (!draft || draft.posting || draft.body.trim().length === 0) return null;
    set((state) => ({ drafts: { ...state.drafts, [key]: { ...draft, posting: true } } }));
    return draft.body.trim();
  },
  finishPost: (key, posted) =>
    set((state) => {
      const draft = state.drafts[key];
      if (!draft) return state;
      if (!posted) {
        return { drafts: { ...state.drafts, [key]: { ...draft, posting: false } } };
      }
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
    }),
}));
