/**
 * Blames a filter only when clearing that one filter alone would admit a row. Whether a
 * filter is enabled is the wrong test: an enabled filter that removed nothing is not why
 * the list is empty, and keying on it yields recovery buttons that do not refill the list.
 */
export type SidebarEmptyStateCause =
  /** Exactly one filter is hiding rows; offer its clear action. */
  | "environment"
  | "projects"
  /** Several are, so no single clear action fixes it and offering one lies. */
  | "multiple"
  /** Nothing is hidden — the list is genuinely empty. */
  | "none";

export function resolveSidebarEmptyStateCause(input: {
  readonly environmentScopeActive: boolean;
  readonly projectFiltersActive: boolean;
  /** Threads admitted by every filter EXCEPT the environment scope. */
  readonly admittedWithoutEnvironment: number;
  /** Threads admitted by every filter EXCEPT project scope and hidden projects. */
  readonly admittedWithoutProjects: number;
}): SidebarEmptyStateCause {
  const culprits: SidebarEmptyStateCause[] = [];
  if (input.environmentScopeActive && input.admittedWithoutEnvironment > 0) {
    culprits.push("environment");
  }
  if (input.projectFiltersActive && input.admittedWithoutProjects > 0) {
    culprits.push("projects");
  }
  const [only] = culprits;
  if (only === undefined) return "none";
  return culprits.length === 1 ? only : "multiple";
}
