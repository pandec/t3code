import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { readCheckedOutBranch, readGitCommonDir } from "../git/Utils.ts";

export class WorktreeSwitchError extends Schema.TaggedError<WorktreeSwitchError>()(
  "WorktreeSwitchError",
  { message: Schema.String },
) {}

/** Accept an existing checkout of this repository, including a return to its root. */
export const resolveWorktreeSwitchTarget = Effect.fn("resolveWorktreeSwitchTarget")(function* (
  workspaceRoot: string,
  targetPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(targetPath)) {
    return yield* new WorktreeSwitchError({
      message: "Pass an absolute path to an existing worktree.",
    });
  }
  const [root, target] = yield* Effect.all([
    fs.realPath(workspaceRoot),
    fs.realPath(targetPath),
  ]).pipe(
    Effect.mapError(
      () =>
        new WorktreeSwitchError({ message: "The project or target directory no longer exists." }),
    ),
  );
  const repository = readGitCommonDir(root);
  if (repository === null || readGitCommonDir(target) !== repository) {
    return yield* new WorktreeSwitchError({
      message:
        "The target must be a checkout of this thread's repository, not a subdirectory or another clone.",
    });
  }
  return {
    targetPath: target,
    worktreePath: target === root ? null : target,
    branch: target === root ? null : readCheckedOutBranch(target),
  };
});
