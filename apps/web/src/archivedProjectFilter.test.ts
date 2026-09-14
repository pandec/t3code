import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  archivedThreadGroupMatchesScope,
  archivedThreadMatchesScope,
  resolveArchivedThreadScopeFilter,
  shouldDeferArchivedEmptyState,
} from "./archivedProjectFilter";
import type { ResolvedSettingsScope } from "./components/settings/settingsScope";
import type { SidebarProjectGroupMember, SidebarProjectSnapshot } from "./sidebarProjectGrouping";

const laptopId = EnvironmentId.make("laptop");
const serverId = EnvironmentId.make("server");

function member(id: string, environmentId: EnvironmentId): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "T3 Code",
    workspaceRoot: `/repos/${id}`,
    physicalProjectKey: `${environmentId}:/repos/${id}`,
    environmentLabel: environmentId === laptopId ? "Laptop" : "Server",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

const laptopCheckout = member("main", laptopId);
const serverCheckout = member("worktree", serverId);
const group: SidebarProjectSnapshot = {
  ...laptopCheckout,
  projectKey: "github.com/t3tools/t3code",
  displayName: "T3 Code",
  memberProjects: [laptopCheckout, serverCheckout],
  memberProjectRefs: [
    { environmentId: laptopId, projectId: laptopCheckout.id },
    { environmentId: serverId, projectId: serverCheckout.id },
  ],
  groupedProjectCount: 2,
  environmentPresence: "mixed",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: ["Server"],
};

const base = { members: group.memberProjects, environmentIds: [laptopId, serverId] };

function threadItem(project: SidebarProjectGroupMember) {
  return { project, thread: { environmentId: project.environmentId } };
}

function archivedGroup(key: string, projects: ReadonlyArray<SidebarProjectGroupMember>) {
  return { key, projects };
}

describe("resolveArchivedThreadScopeFilter", () => {
  it("does not narrow for the all scope or an unavailable selection", () => {
    expect(
      resolveArchivedThreadScopeFilter({ ...base, kind: "all", label: "All environments" }),
    ).toBeNull();
    expect(
      resolveArchivedThreadScopeFilter({
        ...base,
        kind: "unavailable",
        reason: "project-missing",
        label: "Unavailable selection",
        message: "This project is no longer available.",
      }),
    ).toBeNull();
  });

  it("labels a project across every checkout by its display name", () => {
    const scope: ResolvedSettingsScope = {
      ...base,
      kind: "project",
      group,
      environmentId: null,
      label: "T3 Code / All checkouts",
    };
    expect(resolveArchivedThreadScopeFilter(scope)).toEqual({
      label: "T3 Code",
      groupKey: group.projectKey,
      memberPhysicalProjectKeys: new Set([
        laptopCheckout.physicalProjectKey,
        serverCheckout.physicalProjectKey,
      ]),
      environmentId: null,
      physicalProjectKey: null,
    });
  });

  it("keeps the environment and checkout labels once the scope narrows further", () => {
    const projectOnServer: ResolvedSettingsScope = {
      ...base,
      kind: "project",
      group,
      environmentId: serverId,
      label: "T3 Code / Server",
    };
    expect(resolveArchivedThreadScopeFilter(projectOnServer)).toMatchObject({
      label: "T3 Code / Server",
      groupKey: group.projectKey,
      environmentId: serverId,
    });
    const checkout: ResolvedSettingsScope = {
      ...base,
      kind: "checkout",
      group,
      checkout: serverCheckout,
      environmentId: serverId,
      label: "T3 Code / Server · /repos/worktree",
    };
    expect(resolveArchivedThreadScopeFilter(checkout)).toMatchObject({
      label: "T3 Code / Server · /repos/worktree",
      groupKey: group.projectKey,
      environmentId: serverId,
      physicalProjectKey: serverCheckout.physicalProjectKey,
    });
  });
});

describe("archived scope matching", () => {
  it("matches every group and thread without a filter", () => {
    expect(archivedThreadGroupMatchesScope(archivedGroup("anything", []), null)).toBe(true);
    expect(archivedThreadMatchesScope(threadItem(laptopCheckout), null)).toBe(true);
  });

  it("narrows by logical group but keeps every checkout of that group", () => {
    const filter = resolveArchivedThreadScopeFilter({
      ...base,
      kind: "project",
      group,
      environmentId: null,
      label: "T3 Code / All checkouts",
    });
    expect(archivedThreadGroupMatchesScope(archivedGroup(group.projectKey, []), filter)).toBe(true);
    expect(archivedThreadGroupMatchesScope(archivedGroup("other", []), filter)).toBe(false);
    expect(archivedThreadMatchesScope(threadItem(laptopCheckout), filter)).toBe(true);
    expect(archivedThreadMatchesScope(threadItem(serverCheckout), filter)).toBe(true);
  });

  it("matches an archive group keyed differently for one of the selected checkouts", () => {
    // Archive grouping also sees snapshot projects, which can carry a fresher
    // repository identity than the live project and so land under another key.
    const filter = resolveArchivedThreadScopeFilter({
      ...base,
      kind: "project",
      group,
      environmentId: null,
      label: "T3 Code / All checkouts",
    });
    expect(
      archivedThreadGroupMatchesScope(
        archivedGroup("laptop:/repos/main", [laptopCheckout]),
        filter,
      ),
    ).toBe(true);
    expect(
      archivedThreadGroupMatchesScope(
        archivedGroup("laptop:/repos/elsewhere", [member("elsewhere", laptopId)]),
        filter,
      ),
    ).toBe(false);
  });

  it("narrows threads by environment without touching group membership", () => {
    const filter = resolveArchivedThreadScopeFilter({
      ...base,
      kind: "environment",
      environmentId: serverId,
      label: "Server",
    });
    expect(archivedThreadGroupMatchesScope(archivedGroup("other", []), filter)).toBe(true);
    expect(archivedThreadMatchesScope(threadItem(laptopCheckout), filter)).toBe(false);
    expect(archivedThreadMatchesScope(threadItem(serverCheckout), filter)).toBe(true);
  });

  it("narrows threads to the selected checkout", () => {
    const filter = resolveArchivedThreadScopeFilter({
      ...base,
      kind: "checkout",
      group,
      checkout: serverCheckout,
      environmentId: serverId,
      label: "T3 Code / Server · /repos/worktree",
    });
    expect(archivedThreadMatchesScope(threadItem(serverCheckout), filter)).toBe(true);
    expect(archivedThreadMatchesScope(threadItem(laptopCheckout), filter)).toBe(false);
    expect(archivedThreadMatchesScope(threadItem(member("other-worktree", serverId)), filter)).toBe(
      false,
    );
  });
});

describe("shouldDeferArchivedEmptyState", () => {
  it("does not claim an empty result while archive data is incomplete", () => {
    expect(
      shouldDeferArchivedEmptyState({ hasMatchingGroups: false, isLoading: true, hasError: false }),
    ).toBe(true);
    expect(
      shouldDeferArchivedEmptyState({ hasMatchingGroups: false, isLoading: false, hasError: true }),
    ).toBe(true);
  });

  it("allows a definitive empty state after successful loading", () => {
    expect(
      shouldDeferArchivedEmptyState({
        hasMatchingGroups: false,
        isLoading: false,
        hasError: false,
      }),
    ).toBe(false);
  });
});
