import { create } from "zustand";

/** Which field the dialog focuses on open: the new-group input for "New
 * group", or the popup itself so Tab walks the existing groups. */
export type ThreadGroupsDialogFocus = "new-group" | "none";

interface ThreadGroupsDialogState {
  readonly request: { readonly focus: ThreadGroupsDialogFocus } | null;
  readonly open: (focus?: ThreadGroupsDialogFocus) => void;
  readonly close: () => void;
}

/** One dialog instance serves the sidebar button, group header context menus,
 * and the command palette, so the button can be hidden without losing access. */
export const useThreadGroupsDialog = create<ThreadGroupsDialogState>((set) => ({
  request: null,
  open: (focus = "none") => set({ request: { focus } }),
  close: () => set({ request: null }),
}));

export function openThreadGroupsDialog(focus: ThreadGroupsDialogFocus = "none"): void {
  useThreadGroupsDialog.getState().open(focus);
}
