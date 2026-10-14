import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

/** sp-labs writes this marker into every lab worktree it provisions. */
const SP_LAB_MARKER_FILE = ".sp-lab.json";

/**
 * Whether `directory` is an sp-labs lab worktree. sp-labs owns a lab's provisioning (its `up`
 * installs dependencies), so T3 skips the project's worktree setup action there: running it
 * beside `up` would race the dev stack's install and WXT prepare. A failed check counts as not a
 * lab, which keeps upstream's behaviour.
 */
export const isSpLabWorktree = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
): Effect.Effect<boolean> =>
  fileSystem
    .exists(path.join(directory, SP_LAB_MARKER_FILE))
    .pipe(Effect.orElseSucceed(() => false));
