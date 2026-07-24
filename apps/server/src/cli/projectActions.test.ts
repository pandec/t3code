import { expect, it } from "@effect/vitest";
import { ProjectId, type ProjectScript } from "@t3tools/contracts";

import {
  addProjectAction,
  ProjectActionAlreadyExistsError,
  ProjectActionNotFoundError,
  ProjectActionValidationError,
  removeProjectAction,
  updateProjectAction,
} from "./projectActions.ts";

const projectId = ProjectId.make("project-actions");

const setupAction: ProjectScript = {
  id: "setup",
  name: "Setup",
  command: "pnpm install",
  icon: "configure",
  runOnWorktreeCreate: true,
};

const testAction: ProjectScript = {
  id: "test",
  name: "Test",
  command: "pnpm test",
  icon: "test",
  runOnWorktreeCreate: false,
};

it("adds a trimmed action with a UI-compatible generated id", () => {
  const result = addProjectAction({
    projectId,
    scripts: [testAction],
    action: {
      name: " Install iOS ",
      command: " pnpm ios:local:release ",
      icon: "build",
      runOnWorktreeCreate: false,
      autoOpenPreview: false,
    },
  });

  expect(result).not.toBeInstanceOf(ProjectActionValidationError);
  if ("_tag" in result) throw result;
  expect(result.action).toEqual({
    id: "install-ios",
    name: "Install iOS",
    command: "pnpm ios:local:release",
    icon: "build",
    runOnWorktreeCreate: false,
  });
  expect(result.scripts).toHaveLength(2);
});

it("rejects invalid and duplicate explicit ids", () => {
  const invalid = addProjectAction({
    projectId,
    scripts: [],
    action: {
      id: "Install iOS",
      name: "Install iOS",
      command: "pnpm ios:local",
      icon: "build",
      runOnWorktreeCreate: false,
      autoOpenPreview: false,
    },
  });
  expect(invalid).toBeInstanceOf(ProjectActionValidationError);

  const duplicate = addProjectAction({
    projectId,
    scripts: [testAction],
    action: {
      id: "test",
      name: "Test again",
      command: "pnpm test",
      icon: "test",
      runOnWorktreeCreate: false,
      autoOpenPreview: false,
    },
  });
  expect(duplicate).toBeInstanceOf(ProjectActionAlreadyExistsError);
});

it("keeps at most one automatic worktree action", () => {
  const result = addProjectAction({
    projectId,
    scripts: [setupAction],
    action: {
      id: "setup-new",
      name: "New setup",
      command: "pnpm install --frozen-lockfile",
      icon: "configure",
      runOnWorktreeCreate: true,
      autoOpenPreview: false,
    },
  });

  if ("_tag" in result) throw result;
  expect(result.clearedRunOnWorktreeCreate).toEqual(["setup"]);
  expect(result.scripts.map((action) => [action.id, action.runOnWorktreeCreate])).toEqual([
    ["setup", false],
    ["setup-new", true],
  ]);
});

it("updates fields, clears preview metadata, and preserves the action id", () => {
  const previewAction: ProjectScript = {
    ...testAction,
    previewUrl: "http://localhost:5173",
    autoOpenPreview: true,
  };
  const result = updateProjectAction({
    projectId,
    scripts: [previewAction],
    actionId: "test",
    updates: {
      name: "Unit tests",
      previewUrl: null,
    },
  });

  if ("_tag" in result) throw result;
  expect(result.action).toEqual({
    id: "test",
    name: "Unit tests",
    command: "pnpm test",
    icon: "test",
    runOnWorktreeCreate: false,
  });
  expect("previewUrl" in result.action).toBe(false);
  expect("autoOpenPreview" in result.action).toBe(false);
});

it("rejects automatic preview without a preview URL", () => {
  const result = updateProjectAction({
    projectId,
    scripts: [testAction],
    actionId: "test",
    updates: { autoOpenPreview: true },
  });

  expect(result).toBeInstanceOf(ProjectActionValidationError);
});

it("removes an exact action id and reports unknown ids", () => {
  const removed = removeProjectAction({
    projectId,
    scripts: [setupAction, testAction],
    actionId: "test",
  });
  if ("_tag" in removed) throw removed;
  expect(removed.action).toEqual(testAction);
  expect(removed.scripts).toEqual([setupAction]);

  const missing = removeProjectAction({
    projectId,
    scripts: [setupAction],
    actionId: "missing",
  });
  expect(missing).toBeInstanceOf(ProjectActionNotFoundError);
  if ("_tag" in missing) {
    expect(missing.availableActionIds).toEqual(["setup"]);
  }
});
