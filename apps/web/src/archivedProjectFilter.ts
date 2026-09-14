import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

import type { ResolvedSettingsScope } from "./components/settings/settingsScope";
import { derivePhysicalProjectKey } from "./logicalProject";

type ProjectIdentity = Pick<EnvironmentProject, "environmentId" | "workspaceRoot">;

/**
 * The narrowing the archive takes from the shared settings scope. The project
 * axis narrows by logical group so every checkout's threads stay together; the
 * environment and checkout axes narrow the threads inside a group.
 */
export interface ArchivedThreadScopeFilter {
  readonly label: string;
  readonly groupKey: string | null;
  /**
   * Physical keys of the selected group's live checkouts. Archive grouping also
   * sees snapshot projects, which can key the same checkout under a different
   * group, so a group that contains one of these checkouts matches too.
   */
  readonly memberPhysicalProjectKeys: ReadonlySet<string>;
  readonly environmentId: EnvironmentId | null;
  readonly physicalProjectKey: string | null;
}

const NO_MEMBERS: ReadonlySet<string> = new Set();

export function resolveArchivedThreadScopeFilter(
  scope: ResolvedSettingsScope,
): ArchivedThreadScopeFilter | null {
  switch (scope.kind) {
    case "environment":
      return {
        label: scope.label,
        groupKey: null,
        memberPhysicalProjectKeys: NO_MEMBERS,
        environmentId: scope.environmentId,
        physicalProjectKey: null,
      };
    case "project":
    case "checkout":
      return {
        label:
          scope.kind === "project" && scope.environmentId === null
            ? scope.group.displayName
            : scope.label,
        groupKey: scope.group.projectKey,
        memberPhysicalProjectKeys: new Set(
          scope.group.memberProjects.map((member) => member.physicalProjectKey),
        ),
        environmentId: scope.environmentId,
        physicalProjectKey: scope.kind === "checkout" ? scope.checkout.physicalProjectKey : null,
      };
    default:
      return null;
  }
}

export function archivedThreadGroupMatchesScope(
  group: { readonly key: string; readonly projects: ReadonlyArray<ProjectIdentity> },
  filter: ArchivedThreadScopeFilter | null,
): boolean {
  if (filter === null || filter.groupKey === null || filter.groupKey === group.key) return true;
  return group.projects.some((project) =>
    filter.memberPhysicalProjectKeys.has(derivePhysicalProjectKey(project)),
  );
}

export function archivedThreadMatchesScope(
  item: {
    readonly project: ProjectIdentity;
    readonly thread: Pick<EnvironmentProject, "environmentId">;
  },
  filter: ArchivedThreadScopeFilter | null,
): boolean {
  if (filter === null) return true;
  if (filter.environmentId !== null && item.thread.environmentId !== filter.environmentId) {
    return false;
  }
  return (
    filter.physicalProjectKey === null ||
    derivePhysicalProjectKey(item.project) === filter.physicalProjectKey
  );
}

export function shouldDeferArchivedEmptyState(input: {
  readonly hasMatchingGroups: boolean;
  readonly isLoading: boolean;
  readonly hasError: boolean;
}): boolean {
  return !input.hasMatchingGroups && (input.isLoading || input.hasError);
}
