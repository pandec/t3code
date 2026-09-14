import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

import type { ResolvedSettingsScope } from "./components/settings/settingsScope";
import { derivePhysicalProjectKey } from "./logicalProject";

/**
 * The narrowing the archive takes from the shared settings scope. The project
 * axis narrows by logical group so every checkout's threads stay together; the
 * environment and checkout axes narrow the threads inside a group.
 */
export interface ArchivedThreadScopeFilter {
  readonly label: string;
  readonly groupKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly physicalProjectKey: string | null;
}

export function resolveArchivedThreadScopeFilter(
  scope: ResolvedSettingsScope,
): ArchivedThreadScopeFilter | null {
  switch (scope.kind) {
    case "environment":
      return {
        label: scope.label,
        groupKey: null,
        environmentId: scope.environmentId,
        physicalProjectKey: null,
      };
    case "project":
      return {
        label: scope.environmentId === null ? scope.group.displayName : scope.label,
        groupKey: scope.group.projectKey,
        environmentId: scope.environmentId,
        physicalProjectKey: null,
      };
    case "checkout":
      return {
        label: scope.label,
        groupKey: scope.group.projectKey,
        environmentId: scope.environmentId,
        physicalProjectKey: scope.checkout.physicalProjectKey,
      };
    default:
      return null;
  }
}

export function archivedThreadGroupMatchesScope(
  groupKey: string,
  filter: ArchivedThreadScopeFilter | null,
): boolean {
  return filter === null || filter.groupKey === null || filter.groupKey === groupKey;
}

export function archivedThreadMatchesScope(
  item: {
    readonly project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">;
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
