// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function isGitRepository(cwd: string): boolean {
  return NodeFS.existsSync(NodePath.join(cwd, ".git"));
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
