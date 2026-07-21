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
  deriveProjectGroupLabel,
  type ProjectGroupingSettings,
} from "./logicalProject";

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
  readonly resolveEnvironmentLabel: (environmentId: EnvironmentId) => string;
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
}): ReadonlyArray<ArchivedThreadGroup> {
  const groupsByKey = new Map<
    string,
    { projects: EnvironmentProject[]; threads: ArchivedThreadListItem[] }
  >();

  for (const { environmentId, snapshot } of input.snapshots) {
    const projectById = new Map(
      snapshot.projects.map((project) => {
        const scopedProject = scopeProject(environmentId, project);
        return [scopedProject.id, scopedProject] as const;
      }),
    );

    for (const rawThread of snapshot.threads) {
      if (rawThread.archivedAt === null) continue;
      const project = projectById.get(rawThread.projectId);
      if (!project) continue;

      const key = deriveLogicalProjectKeyFromSettings(project, input.groupingSettings);
      const group = groupsByKey.get(key) ?? { projects: [], threads: [] };
      if (!group.projects.some((candidate) => candidate === project)) {
        group.projects.push(project);
      }
      group.threads.push({
        environmentLabel: input.resolveEnvironmentLabel(environmentId),
        project,
        thread: scopeThreadShell(environmentId, rawThread),
      });
      groupsByKey.set(key, group);
    }
  }

  const groups: ArchivedThreadGroup[] = [];
  for (const [key, group] of groupsByKey) {
    const representativeProject =
      (input.primaryEnvironmentId
        ? group.projects.find((project) => project.environmentId === input.primaryEnvironmentId)
        : undefined) ?? group.projects[0];
    if (!representativeProject) continue;

    groups.push({
      displayName:
        group.projects.length > 1
          ? deriveProjectGroupLabel({
              representative: representativeProject,
              members: group.projects,
            })
          : representativeProject.title,
      key,
      projects: group.projects,
      representativeProject,
      threads: group.threads.toSorted(
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
