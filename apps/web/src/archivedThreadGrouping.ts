import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import {
  scopeProject,
  scopeThreadShell,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "./logicalProject";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
} from "./sidebarProjectGrouping";

export interface ArchivedThreadListItem {
  readonly environmentLabel: string;
  readonly project: EnvironmentProject;
  readonly thread: EnvironmentThreadShell;
}

export interface ArchivedThreadGroup {
  readonly displayName: string;
  readonly key: string;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly representativeProject: EnvironmentProject;
  readonly threads: ReadonlyArray<ArchivedThreadListItem>;
}

function archiveTimestamp(thread: EnvironmentThreadShell): string {
  return thread.archivedAt ?? thread.createdAt;
}

export function buildArchivedThreadGroups(input: {
  readonly groupingSettings: ProjectGroupingSettings;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly resolveEnvironmentLabel: (environmentId: EnvironmentId) => string;
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
}): ReadonlyArray<ArchivedThreadGroup> {
  const scopedProjectKey = (environmentId: EnvironmentId, projectId: string) =>
    `${environmentId}\u0000${projectId}`;
  const archivedProjectByScopedKey = new Map<string, EnvironmentProject>();

  for (const { environmentId, snapshot } of input.snapshots) {
    for (const project of snapshot.projects) {
      const scopedProject = scopeProject(environmentId, project);
      archivedProjectByScopedKey.set(scopedProjectKey(environmentId, project.id), scopedProject);
    }
  }

  const projectCandidates = [...input.projects, ...archivedProjectByScopedKey.values()];
  const physicalToLogicalKey = buildPhysicalToLogicalProjectKeyMap({
    projects: projectCandidates,
    settings: input.groupingSettings,
    primaryEnvironmentId: input.primaryEnvironmentId,
  });
  const projectGroups = buildSidebarProjectSnapshots({
    projects: projectCandidates,
    settings: input.groupingSettings,
    primaryEnvironmentId: input.primaryEnvironmentId,
    resolveEnvironmentLabel: input.resolveEnvironmentLabel,
  });
  const threadsByGroupKey = new Map<string, ArchivedThreadListItem[]>();

  for (const { environmentId, snapshot } of input.snapshots) {
    for (const rawThread of snapshot.threads) {
      if (rawThread.archivedAt === null) continue;
      const project = archivedProjectByScopedKey.get(
        scopedProjectKey(environmentId, rawThread.projectId),
      );
      if (!project) continue;

      const physicalKey = derivePhysicalProjectKey(project);
      const groupKey =
        physicalToLogicalKey.get(physicalKey) ??
        deriveLogicalProjectKeyFromSettings(project, input.groupingSettings);
      const threads = threadsByGroupKey.get(groupKey) ?? [];
      threads.push({
        environmentLabel: input.resolveEnvironmentLabel(environmentId),
        project,
        thread: scopeThreadShell(environmentId, rawThread),
      });
      threadsByGroupKey.set(groupKey, threads);
    }
  }

  const groups: ArchivedThreadGroup[] = [];
  for (const projectGroup of projectGroups) {
    const threads = threadsByGroupKey.get(projectGroup.projectKey);
    if (!threads || threads.length === 0) continue;

    groups.push({
      displayName: projectGroup.displayName,
      key: projectGroup.projectKey,
      projects: projectGroup.memberProjects,
      representativeProject: projectGroup,
      threads: threads.toSorted(
        (left, right) =>
          archiveTimestamp(right.thread).localeCompare(archiveTimestamp(left.thread)) ||
          right.thread.id.localeCompare(left.thread.id),
      ),
    });
  }

  return groups.toSorted(
    (left, right) =>
      archiveTimestamp(right.threads[0]!.thread).localeCompare(
        archiveTimestamp(left.threads[0]!.thread),
      ) ||
      left.displayName.localeCompare(right.displayName) ||
      left.key.localeCompare(right.key),
  );
}
