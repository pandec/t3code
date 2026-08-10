/**
 * Which filter to blame when the sidebar comes out empty.
 *
 * Three rewrites of this attribution keyed on "which filters are enabled",
 * and each one shipped a message whose recovery button did not refill the
 * list. Enabled is the wrong question: a filter that is on but removed no
 * rows is not the reason you are looking at nothing. The right question is
 * counterfactual — would clearing this one filter, and nothing else, admit a
 * row? The caller answers it while partitioning threads, which it already
 * walks, and this decides what to say.
 */
export type SidebarEmptyStateCause =
  /** Exactly one filter is hiding rows; offer its clear action. */
  | "environment"
  | "projects"
  | "attention"
  /** Several are, so no single clear action fixes it and offering one lies. */
  | "multiple"
  /** Nothing is hidden — the list is genuinely empty. */
  | "none";

export function resolveSidebarEmptyStateCause(input: {
  readonly environmentScopeActive: boolean;
  readonly projectFiltersActive: boolean;
  readonly attentionFilterActive: boolean;
  /** Threads admitted by every filter EXCEPT the environment scope. */
  readonly admittedWithoutEnvironment: number;
  /** Threads admitted by every filter EXCEPT project scope and hidden projects. */
  readonly admittedWithoutProjects: number;
  /** Threads admitted by every filter EXCEPT the attention filter. */
  readonly admittedWithoutAttention: number;
}): SidebarEmptyStateCause {
  const culprits: SidebarEmptyStateCause[] = [];
  if (input.environmentScopeActive && input.admittedWithoutEnvironment > 0) {
    culprits.push("environment");
  }
  if (input.projectFiltersActive && input.admittedWithoutProjects > 0) {
    culprits.push("projects");
  }
  if (input.attentionFilterActive && input.admittedWithoutAttention > 0) {
    culprits.push("attention");
  }
  const [only] = culprits;
  if (only === undefined) return "none";
  return culprits.length === 1 ? only : "multiple";
}
