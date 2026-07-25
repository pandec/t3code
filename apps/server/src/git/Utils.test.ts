import { expect, it } from "@effect/vitest";

import { sanitizeGitRepositoryEnvironment } from "./Utils.ts";

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
