import type { ContextMenuItem } from "@t3tools/contracts";

/**
 * Ids for the per-thread action menu. Snooze presets are dispatched as
 * `snooze:<presetId>` so the union stays closed while the preset list
 * remains data-driven.
 */
export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "move-to-top"
  | "fork"
  | "archive"
  | "copy-path"
  | "copy-thread-id"
  | "copy-branch"
  | "delete";

/**
 * Fork-only entries. Surfaces that have no handler for them omit this block
 * entirely, so the shared builder stays the single ordering authority while
 * each surface still decides which actions it can actually perform.
 */
export interface ThreadActionMenuForkExtras {
  // Reorders the unpinned active partition only, so it is hidden once the
  // thread is pinned, settled, or snoozed (those rows have their own order).
  readonly moveToTop: boolean;
  readonly fork: boolean;
  // Archiving mid-turn would strand a running session, so the entry stays
  // visible but disabled until the turn ends.
  readonly canArchiveNow: boolean;
}

export interface ThreadActionMenuState {
  readonly branch: string | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  /**
   * Only the fields the menu renders, so surfaces can pass the fork's wider
   * preset list (which adds the indefinite "until I wake it" entry with a
   * null wake time) as well as the shared timed presets.
   */
  readonly snoozePresets: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly whenLabel: string;
  }>;
  readonly forkExtras?: ThreadActionMenuForkExtras;
}

/**
 * Single source for the per-thread action menu: the sidebar row's right-click
 * menu and the chat header menu both render exactly this list, so labels,
 * ordering, and capability gating cannot drift between the two surfaces.
 */
export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return [
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread" }
            : { id: "pin" as const, label: "Pin thread" },
        ]
      : []),
    // Both lifecycle actions stay available on pinned threads: settling
    // clears the pin ("done" beats "keep on top"), and snoozing hides the
    // card until wake with the pin intact.
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread" }
            : { id: "settle" as const, label: "Settle thread" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                disabled: !state.canSnoozeNow,
                children: state.snoozePresets.map((preset) => ({
                  id: `snooze:${preset.id}` as const,
                  label: `${preset.label} (${preset.whenLabel})`,
                })),
              },
        ]
      : []),
    { id: "rename", label: "Rename thread" },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread" },
    ...(state.forkExtras?.moveToTop && !state.isPinned && !state.isSettled && !state.isSnoozed
      ? [{ id: "move-to-top" as const, label: "Move to top" }]
      : []),
    ...(state.forkExtras?.fork ? [{ id: "fork" as const, label: "Fork conversation" }] : []),
    ...(state.forkExtras
      ? [
          {
            id: "archive" as const,
            label: "Archive thread",
            disabled: !state.forkExtras.canArchiveNow,
          },
        ]
      : []),
    { id: "copy-path", label: "Copy path", icon: "copy" },
    ...(state.forkExtras
      ? [{ id: "copy-thread-id" as const, label: "Copy thread ID", icon: "copy" }]
      : []),
    ...(state.branch ? [{ id: "copy-branch" as const, label: "Copy branch", icon: "copy" }] : []),
    { id: "delete", label: "Delete", destructive: true, icon: "trash" },
  ];
}
