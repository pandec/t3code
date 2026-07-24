import {
  parseScopedProjectKey,
  scopedProjectKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

const ALL_PROJECTS_SELECT_VALUE = "all";
const PROJECT_SELECT_VALUE_PREFIX = "project:";

export interface ArchivedProjectFilterOption {
  readonly environmentLabel: string;
  readonly label: string;
  readonly logicalKey: string;
  readonly projectKey: string;
  readonly workspaceRoot: string;
}

type ArchivedProjectFilterOptionCandidate = Omit<ArchivedProjectFilterOption, "label"> & {
  readonly displayName: string;
};

function countBy<T>(items: ReadonlyArray<T>, getValue: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = getValue(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

export function buildArchivedProjectFilterOptions(
  candidates: ReadonlyArray<ArchivedProjectFilterOptionCandidate>,
): ReadonlyArray<ArchivedProjectFilterOption> {
  const displayNameCounts = countBy(candidates, (candidate) => candidate.displayName);
  const pathLabels = candidates.map((candidate) => ({
    ...candidate,
    label:
      (displayNameCounts.get(candidate.displayName) ?? 0) > 1
        ? `${candidate.displayName} — ${candidate.workspaceRoot}`
        : candidate.displayName,
  }));
  const pathLabelCounts = countBy(pathLabels, (candidate) => candidate.label);
  const environmentLabels = pathLabels.map((candidate) => ({
    ...candidate,
    label:
      (pathLabelCounts.get(candidate.label) ?? 0) > 1
        ? `${candidate.label} · ${candidate.environmentLabel}`
        : candidate.label,
  }));
  const environmentLabelCounts = countBy(environmentLabels, (candidate) => candidate.label);
  return environmentLabels.map((candidate) => ({
    environmentLabel: candidate.environmentLabel,
    label:
      (environmentLabelCounts.get(candidate.label) ?? 0) > 1
        ? `${candidate.label} · ${candidate.logicalKey}`
        : candidate.label,
    logicalKey: candidate.logicalKey,
    projectKey: candidate.projectKey,
    workspaceRoot: candidate.workspaceRoot,
  }));
}

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

export function shouldShowUnresolvedArchivedProjectFilterOption(input: {
  readonly hasProjectFilter: boolean;
  readonly hasResolvedProject: boolean;
}): boolean {
  return input.hasProjectFilter && !input.hasResolvedProject;
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
