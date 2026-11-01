/** Fork: the Active work filter's bolt toggle, the same on every thread list surface. */
export const ACTIVE_WORK_TOGGLE_LABEL = "Show only active threads";

export function activeWorkToggleIcon(enabled: boolean) {
  return enabled ? ("bolt.fill" as const) : ("bolt" as const);
}
