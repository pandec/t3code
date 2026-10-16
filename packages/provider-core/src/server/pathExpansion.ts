// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Spawned processes don't get shell expansion, so env vars like
 * `CODEX_HOME=~/.codex-work` would be passed verbatim and treated as relative
 * paths by the receiver.
 */
export function expandHomePath(value: string, home: string): string {
  if (!value) return value;
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(home, value.slice(2));
  }
  return value;
}

/**
 * Whether `value` currently resolves to a directory.
 *
 * Used before reusing a persisted working directory: a worktree can be removed
 * between sessions, and spawning a provider in a directory that no longer
 * exists fails at process start rather than surfacing a usable error.
 */
export function isExistingDirectory(value: string): boolean {
  return NodeFS.statSync(value, { throwIfNoEntry: false })?.isDirectory() === true;
}
