import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  archivedProjectFilterKey,
  archivedProjectSelectValue,
  archivedThreadMatchesProject,
  parseArchivedProjectFilterKey,
  parseArchivedProjectSelectValue,
  resolveArchivedProjectFilterGroup,
  shouldDeferArchivedEmptyState,
} from "./archivedProjectFilter";

describe("archived project filter keys", () => {
  it("uses a stable scoped project identity", () => {
    const key = archivedProjectFilterKey({
      environmentId: EnvironmentId.make("environment-a"),
      id: ProjectId.make("project-a"),
    });

    expect(key).toBe("environment-a:project-a");
    expect(parseArchivedProjectFilterKey(key)).toBe(key);
    expect(parseArchivedProjectFilterKey("not-scoped")).toBeNull();
  });

  it("keeps select control values separate from project keys", () => {
    const collisionProneKey = "all:project";

    expect(archivedProjectSelectValue(null)).toBe("all");
    expect(archivedProjectSelectValue(collisionProneKey)).toBe("project:all:project");
    expect(parseArchivedProjectSelectValue("all")).toBeNull();
    expect(parseArchivedProjectSelectValue("project:all:project")).toBe(collisionProneKey);
  });

  it("resolves the stable identity through a changed logical grouping key", () => {
    const projectRef = {
      environmentId: EnvironmentId.make("environment-a"),
      projectId: ProjectId.make("project-a"),
    };
    const projectFilterKey = archivedProjectFilterKey({
      environmentId: projectRef.environmentId,
      id: projectRef.projectId,
    });

    expect(
      resolveArchivedProjectFilterGroup(
        [{ projectKey: "github.com/t3tools/t3code", memberProjectRefs: [projectRef] }],
        projectFilterKey,
      )?.projectKey,
    ).toBe("github.com/t3tools/t3code");
    expect(
      resolveArchivedProjectFilterGroup(
        [{ projectKey: "environment-a:/workspace/t3code", memberProjectRefs: [projectRef] }],
        projectFilterKey,
      )?.projectKey,
    ).toBe("environment-a:/workspace/t3code");
  });
});

describe("archivedThreadMatchesProject", () => {
  it("matches every group without a project filter", () => {
    expect(archivedThreadMatchesProject("project-a", null)).toBe(true);
  });

  it("matches only the selected logical project", () => {
    expect(archivedThreadMatchesProject("project-a", "project-a")).toBe(true);
    expect(archivedThreadMatchesProject("project-b", "project-a")).toBe(false);
  });
});

describe("shouldDeferArchivedEmptyState", () => {
  it("does not claim an empty result while archive data is incomplete", () => {
    expect(
      shouldDeferArchivedEmptyState({
        hasMatchingGroups: false,
        isLoading: true,
        hasError: false,
      }),
    ).toBe(true);
    expect(
      shouldDeferArchivedEmptyState({
        hasMatchingGroups: false,
        isLoading: false,
        hasError: true,
      }),
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
