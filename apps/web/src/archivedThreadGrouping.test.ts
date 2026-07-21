import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import { scopeProject } from "@t3tools/client-runtime/state/shell";
import type { OrchestrationProjectShell, OrchestrationThreadShell } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildArchivedThreadGroups } from "./archivedThreadGrouping";

const localEnvironmentId = EnvironmentId.make("local");
const remoteEnvironmentId = EnvironmentId.make("remote");
const groupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(input: {
  id: string;
  root: string;
  title: string;
  canonicalKey?: string;
  updatedAt?: string;
}): OrchestrationProjectShell {
  return {
    id: ProjectId.make(input.id),
    title: input.title,
    workspaceRoot: input.root,
    repositoryIdentity: input.canonicalKey
      ? {
          canonicalKey: input.canonicalKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${input.canonicalKey}`,
          },
          displayName: "T3 Code",
          name: "t3code",
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

function makeThread(input: {
  archivedAt?: string | null;
  id: string;
  projectId: OrchestrationProjectShell["id"];
  title: string;
}): OrchestrationThreadShell {
  return {
    id: ThreadId.make(input.id),
    projectId: input.projectId,
    title: input.title,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    archivedAt: "archivedAt" in input ? (input.archivedAt ?? null) : "2026-07-02T00:00:00.000Z",
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function snapshot(
  environmentId: EnvironmentId,
  project: OrchestrationProjectShell,
  threads: ReadonlyArray<OrchestrationThreadShell>,
): ArchivedSnapshotEntry {
  return {
    environmentId,
    snapshot: {
      snapshotSequence: 1,
      projects: [project],
      threads,
      updatedAt: "2026-07-03T00:00:00.000Z",
    },
  };
}

describe("buildArchivedThreadGroups", () => {
  it("groups the same repository across environments and keeps thread provenance", () => {
    const localProject = makeProject({
      id: "local-project",
      root: "/Users/example/t3code",
      title: "Local checkout",
      canonicalKey: "github.com/t3tools/t3code",
    });
    const remoteProject = makeProject({
      id: "remote-project",
      root: "/workspace/t3code",
      title: "Remote checkout",
      canonicalKey: "github.com/t3tools/t3code",
    });

    const groups = buildArchivedThreadGroups({
      groupingSettings,
      primaryEnvironmentId: localEnvironmentId,
      projects: [],
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === localEnvironmentId ? "Mac" : "Grey Mac",
      snapshots: [
        snapshot(localEnvironmentId, localProject, [
          makeThread({ id: "local-thread", projectId: localProject.id, title: "Local chat" }),
        ]),
        snapshot(remoteEnvironmentId, remoteProject, [
          makeThread({
            archivedAt: "2026-07-03T00:00:00.000Z",
            id: "remote-thread",
            projectId: remoteProject.id,
            title: "Remote chat",
          }),
        ]),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.displayName).toBe("T3 Code");
    expect(groups[0]?.representativeProject.environmentId).toBe(localEnvironmentId);
    expect(
      groups[0]?.threads.map(({ environmentLabel, thread }) => [thread.id, environmentLabel]),
    ).toEqual([
      ["remote-thread", "Grey Mac"],
      ["local-thread", "Mac"],
    ]);
  });

  it("keeps projects without shared repository identity separate", () => {
    const localProject = makeProject({
      id: "project",
      root: "/Users/example/t3code",
      title: "T3 Code",
    });
    const remoteProject = makeProject({
      id: "project",
      root: "/workspace/t3code",
      title: "T3 Code",
    });

    const groups = buildArchivedThreadGroups({
      groupingSettings,
      primaryEnvironmentId: localEnvironmentId,
      projects: [],
      resolveEnvironmentLabel: String,
      snapshots: [
        snapshot(localEnvironmentId, localProject, [
          makeThread({ id: "local-thread", projectId: localProject.id, title: "Local chat" }),
        ]),
        snapshot(remoteEnvironmentId, remoteProject, [
          makeThread({ id: "remote-thread", projectId: remoteProject.id, title: "Remote chat" }),
        ]),
      ],
    });

    expect(groups).toHaveLength(2);
  });

  it("uses the primary project as representative when only a remote member has archived chats", () => {
    const localProject = makeProject({
      id: "local-project",
      root: "/Users/example/t3code",
      title: "Local checkout",
      canonicalKey: "github.com/t3tools/t3code",
    });
    const remoteProject = makeProject({
      id: "remote-project",
      root: "/workspace/t3code",
      title: "Remote checkout",
      canonicalKey: "github.com/t3tools/t3code",
    });

    const groups = buildArchivedThreadGroups({
      groupingSettings,
      primaryEnvironmentId: localEnvironmentId,
      projects: [
        scopeProject(localEnvironmentId, localProject),
        scopeProject(remoteEnvironmentId, remoteProject),
      ],
      resolveEnvironmentLabel: String,
      snapshots: [
        snapshot(remoteEnvironmentId, remoteProject, [
          makeThread({ id: "remote-thread", projectId: remoteProject.id, title: "Remote chat" }),
        ]),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.representativeProject.environmentId).toBe(localEnvironmentId);
    expect(groups[0]?.displayName).toBe("T3 Code");
  });

  it("routes stale duplicate project records through the current physical-project winner", () => {
    const staleProject = makeProject({
      id: "stale-project",
      root: "/Users/example/t3code",
      title: "Stale checkout",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const canonicalProject = makeProject({
      id: "canonical-project",
      root: "/Users/example/t3code",
      title: "Current checkout",
      canonicalKey: "github.com/t3tools/t3code",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });

    const groups = buildArchivedThreadGroups({
      groupingSettings,
      primaryEnvironmentId: localEnvironmentId,
      projects: [scopeProject(localEnvironmentId, canonicalProject)],
      resolveEnvironmentLabel: String,
      snapshots: [
        snapshot(localEnvironmentId, staleProject, [
          makeThread({ id: "stale-thread", projectId: staleProject.id, title: "Archived chat" }),
        ]),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("github.com/t3tools/t3code");
    expect(groups[0]?.representativeProject.id).toBe(canonicalProject.id);
    expect(groups[0]?.threads.map(({ thread }) => thread.id)).toEqual(["stale-thread"]);
  });

  it("omits active threads returned by an archive snapshot", () => {
    const project = makeProject({ id: "project", root: "/repo", title: "Project" });
    const groups = buildArchivedThreadGroups({
      groupingSettings,
      primaryEnvironmentId: localEnvironmentId,
      projects: [],
      resolveEnvironmentLabel: String,
      snapshots: [
        snapshot(localEnvironmentId, project, [
          makeThread({ archivedAt: null, id: "active", projectId: project.id, title: "Active" }),
        ]),
      ],
    });

    expect(groups).toEqual([]);
  });
});
