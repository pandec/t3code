import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";

// The fork's auto-settle master gate and worktree-recreation preference are
// edited by the same mobile section, so they replicate and mismatch-check with
// the per-reason toggles they sit beside.
export type AutoSettleSettings = Pick<
  ServerSettings,
  | "threadAutoSettleEnabled"
  | "skipMissingWorktreeRecreation"
  | "sidebarAutoSettleAfterDays"
  | "sidebarAutoSettleOnMerge"
>;

const AUTO_SETTLE_SETTING_KEYS = [
  "threadAutoSettleEnabled",
  "skipMissingWorktreeRecreation",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleOnMerge",
] as const satisfies ReadonlyArray<keyof AutoSettleSettings>;

interface AutoSettleSyncTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly settings: AutoSettleSettings | null;
}

/** Receives connected, capable targets. Applying these defaults must preserve other settings. */
export function planAutoSettleSettingsSync(
  reference: { readonly environmentId: EnvironmentId; readonly settings: AutoSettleSettings },
  targets: readonly AutoSettleSyncTarget[],
) {
  const patch: AutoSettleSettings = {
    threadAutoSettleEnabled: reference.settings.threadAutoSettleEnabled,
    skipMissingWorktreeRecreation: reference.settings.skipMissingWorktreeRecreation,
    sidebarAutoSettleAfterDays: reference.settings.sidebarAutoSettleAfterDays,
    sidebarAutoSettleOnMerge: reference.settings.sidebarAutoSettleOnMerge,
  };
  const mismatches = targets.filter((target) => {
    if (target.environmentId === reference.environmentId || target.settings === null) {
      return false;
    }
    const settings = target.settings;
    return AUTO_SETTLE_SETTING_KEYS.some((key) => settings[key] !== patch[key]);
  });
  return { patch, mismatches };
}
