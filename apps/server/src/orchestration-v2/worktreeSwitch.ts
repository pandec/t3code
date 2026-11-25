import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

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
  const git = yield* GitVcsDriver.GitVcsDriver;
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
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation: "resolveWorktreeSwitchTarget", cwd, args, allowNonZeroExit: true })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.split(/\r?\n/u) : null)),
        Effect.orElseSucceed(() => null),
      );
  // Git resolves the common directory for every layout (git-annex symlinks `.git` to its admin
  // directory); null unless `cwd`, a physical path, is a checkout's top level.
  const commonDir = Effect.fn("resolveWorktreeSwitchTarget.commonDir")(function* (cwd: string) {
    const lines = yield* run(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
    if (!lines?.[0] || !lines[1] || path.resolve(lines[0]) !== cwd) return null;
    return yield* fs.realPath(path.resolve(cwd, lines[1])).pipe(Effect.orElseSucceed(() => null));
  });
  const [repository, targetRepository] = yield* Effect.all([commonDir(root), commonDir(target)]);
  if (repository === null || targetRepository !== repository) {
    return yield* new WorktreeSwitchError({
      message:
        "The target must be a checkout of this thread's repository, not a subdirectory or another clone.",
    });
  }
  if (target === root) return { targetPath: target, worktreePath: null, branch: null };
  const head = yield* run(target, ["symbolic-ref", "--quiet", "HEAD"]);
  const branch = /^refs\/heads\/(.+)$/u.exec(head?.[0] ?? "")?.[1] ?? null;
  return { targetPath: target, worktreePath: target, branch };
});
