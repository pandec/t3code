// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  isSameDirectory,
  readCheckedOutBranch,
  sanitizeGitRepositoryEnvironment,
} from "./Utils.ts";

function makeTempDir(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-git-utils-"));
}

it("reads the branch from a primary checkout", () => {
  const root = makeTempDir();
  NodeFS.mkdirSync(NodePath.join(root, ".git"));
  NodeFS.writeFileSync(NodePath.join(root, ".git", "HEAD"), "ref: refs/heads/dev\n");

  expect(readCheckedOutBranch(root)).toBe("dev");
});

it("follows a linked worktree's gitdir pointer to its own HEAD", () => {
  const root = makeTempDir();
  const gitDir = NodePath.join(root, "repo.git", "worktrees", "feature");
  NodeFS.mkdirSync(gitDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(gitDir, "HEAD"), "ref: refs/heads/fix/nested/name\n");

  const worktree = NodePath.join(root, "worktree");
  NodeFS.mkdirSync(worktree);
  NodeFS.writeFileSync(NodePath.join(worktree, ".git"), `gitdir: ${gitDir}\n`);

  expect(readCheckedOutBranch(worktree)).toBe("fix/nested/name");
});

it("reports no branch for a detached HEAD, a non-repository, or a missing directory", () => {
  const detached = makeTempDir();
  NodeFS.mkdirSync(NodePath.join(detached, ".git"));
  NodeFS.writeFileSync(
    NodePath.join(detached, ".git", "HEAD"),
    "9fceb02f1a3b4c5d6e7f8091a2b3c4d5e6f70819\n",
  );

  expect(readCheckedOutBranch(detached)).toBeNull();
  expect(readCheckedOutBranch(makeTempDir())).toBeNull();
  expect(readCheckedOutBranch(NodePath.join(makeTempDir(), "absent"))).toBeNull();
});

it("treats trailing separators and symlinked paths as the same directory", () => {
  const root = makeTempDir();
  const target = NodePath.join(root, "target");
  NodeFS.mkdirSync(target);
  const link = NodePath.join(root, "link");
  NodeFS.symlinkSync(target, link);

  expect(isSameDirectory(target, `${target}${NodePath.sep}`)).toBe(true);
  expect(isSameDirectory(link, target)).toBe(true);
  expect(isSameDirectory(target, NodePath.join(root, "other"))).toBe(false);
});

it("compares deleted directories textually", () => {
  const removed = NodePath.join(makeTempDir(), "gone");

  expect(isSameDirectory(removed, removed)).toBe(true);
  expect(isSameDirectory(removed, `${removed}-other`)).toBe(false);
});

it("removes repository-scoping Git variables without dropping ordinary configuration", () => {
  expect(
    sanitizeGitRepositoryEnvironment({
      GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
      GIT_DIR: "/tmp/other.git",
      GIT_WORK_TREE: "/tmp/other-worktree",
      GIT_COMMON_DIR: "/tmp/common",
      GIT_INDEX_FILE: "/tmp/index",
      PATH: "/usr/bin",
    }),
  ).toEqual({
    GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
    PATH: "/usr/bin",
  });
});
