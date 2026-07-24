import {
  parseScopedProjectKey,
  scopedProjectKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

const ALL_PROJECTS_SELECT_VALUE = "all";
const PROJECT_SELECT_VALUE_PREFIX = "project:";

export function archivedProjectFilterKey(project: {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}): string {
  return scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
}

export function parseArchivedProjectFilterKey(value: unknown): string | null {
  return typeof value === "string" && parseScopedProjectKey(value) !== null ? value : null;
}

export function archivedProjectSelectValue(projectFilterKey: string | null): string {
  return projectFilterKey === null
    ? ALL_PROJECTS_SELECT_VALUE
    : `${PROJECT_SELECT_VALUE_PREFIX}${projectFilterKey}`;
}

export function parseArchivedProjectSelectValue(value: string): string | null {
  if (value === ALL_PROJECTS_SELECT_VALUE) {
    return null;
  }
  if (!value.startsWith(PROJECT_SELECT_VALUE_PREFIX)) {
    return null;
  }
  return parseArchivedProjectFilterKey(value.slice(PROJECT_SELECT_VALUE_PREFIX.length));
}

export function archivedThreadMatchesProject(
  groupKey: string,
  logicalProjectFilterKey: string | null,
): boolean {
  return logicalProjectFilterKey === null || groupKey === logicalProjectFilterKey;
}

export function shouldDeferArchivedEmptyState(input: {
  readonly hasMatchingGroups: boolean;
  readonly isLoading: boolean;
  readonly hasError: boolean;
}): boolean {
  return !input.hasMatchingGroups && (input.isLoading || input.hasError);
}

export function resolveArchivedProjectFilterGroup<
  T extends {
    readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
  },
>(groups: ReadonlyArray<T>, projectFilterKey: string | null): T | null {
  if (projectFilterKey === null) {
    return null;
  }
  return (
    groups.find((group) =>
      group.memberProjectRefs.some(
        (projectRef) =>
          archivedProjectFilterKey({
            environmentId: projectRef.environmentId,
            id: projectRef.projectId,
          }) === projectFilterKey,
      ),
    ) ?? null
  );
}
