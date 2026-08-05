// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function isGitRepository(cwd: string): boolean {
  return NodeFS.existsSync(NodePath.join(cwd, ".git"));
}

/**
 * Compare two directory paths for identity, resolving symlinks when both sides
 * still exist. Falls back to a normalized textual comparison so a directory
 * that has since been deleted can still be recognized.
 */
export function isSameDirectory(left: string, right: string): boolean {
  if (NodePath.resolve(left) === NodePath.resolve(right)) return true;
  return canonicalizeDirectory(left) === canonicalizeDirectory(right);
}

/**
 * Resolve a directory to its canonical form, falling back to a normalized path
 * when it cannot be resolved (most often because it no longer exists).
 *
 * Persisted worktree paths are compared with strict equality across the server,
 * so storing an alias — `/tmp` for `/private/tmp`, or any symlinked parent —
 * makes later comparisons miss.
 */
export function canonicalizeDirectory(value: string): string {
  try {
    return NodeFS.realpathSync(value);
  } catch {
    return NodePath.resolve(value);
  }
}

/**
 * Resolve the shared git directory backing `cwd` — the repository a checkout
 * belongs to. A primary checkout points at its own `.git`; a linked worktree's
 * `gitdir` sits under `<repo>/.git/worktrees/<name>`, whose repository is two
 * levels up. Returns `null` when `cwd` is not a checkout.
 *
 * Two checkouts of the same repository share this value, which is what
 * distinguishes a worktree of the project from an unrelated clone.
 */
export function readGitCommonDir(cwd: string): string | null {
  try {
    const dotGit = NodePath.join(cwd, ".git");
    const stats = NodeFS.statSync(dotGit, { throwIfNoEntry: false });
    if (!stats) return null;
    if (stats.isDirectory()) return canonicalizeDirectory(dotGit);

    const pointer = NodeFS.readFileSync(dotGit, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (!match?.[1]) return null;
    const target = match[1].trim();
    const gitDir = NodePath.isAbsolute(target) ? target : NodePath.resolve(cwd, target);
    const parent = NodePath.dirname(gitDir);
    return NodePath.basename(parent) === "worktrees"
      ? canonicalizeDirectory(NodePath.dirname(parent))
      : canonicalizeDirectory(gitDir);
  } catch {
    return null;
  }
}

/**
 * Read the branch checked out at `cwd` without shelling out to git.
 *
 * `.git` is a directory in a primary checkout and a `gitdir:` pointer file in a
 * linked worktree; both cases expose a `HEAD` holding either a symbolic ref or
 * a raw commit id. Returns `null` for a detached HEAD, a non-repository, or any
 * layout this cannot parse — callers treat that as "branch unknown" rather than
 * an error, so a surprising on-disk shape must not fail the caller.
 */
export function readCheckedOutBranch(cwd: string): string | null {
  try {
    const dotGit = NodePath.join(cwd, ".git");
    const stats = NodeFS.statSync(dotGit, { throwIfNoEntry: false });
    if (!stats) return null;

    let gitDir = dotGit;
    if (!stats.isDirectory()) {
      const pointer = NodeFS.readFileSync(dotGit, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!match?.[1]) return null;
      const target = match[1].trim();
      gitDir = NodePath.isAbsolute(target) ? target : NodePath.resolve(cwd, target);
    }

    const head = NodeFS.readFileSync(NodePath.join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    const branch = ref?.[1]?.trim();
    return branch && branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

const REPOSITORY_SCOPING_GIT_ENVIRONMENT_KEYS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
] as const;

/** Keep ordinary Git configuration while ensuring `cwd` selects the repository. */
export function sanitizeGitRepositoryEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  for (const key of REPOSITORY_SCOPING_GIT_ENVIRONMENT_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}
