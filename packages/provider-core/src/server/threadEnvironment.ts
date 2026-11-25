import type { ThreadId } from "@t3tools/contracts";

export interface ProviderThreadIdentity {
  readonly threadId: ThreadId;
  readonly cwd?: string | null | undefined;
}

export interface ProviderThreadPaths {
  readonly baseDir: string;
  readonly stateDir: string;
}

/**
 * The variables that tell a provider's commands which thread and T3 install
 * they serve. Providers whose process outlives one thread (Codex app-server)
 * apply these per thread instead of on the process.
 */
export function providerThreadEnvironmentVariables(
  input: ProviderThreadIdentity,
  paths?: ProviderThreadPaths,
): Record<string, string> {
  return {
    T3CODE_THREAD_ID: input.threadId,
    ...(paths ? { T3CODE_HOME: paths.baseDir, T3CODE_STATE_DIR: paths.stateDir } : {}),
    ...(input.cwd ? { T3CODE_WORKTREE_PATH: input.cwd } : {}),
  };
}

const THREAD_VARIABLES = new Set(["T3CODE_THREAD_ID", "T3CODE_TURN_ID", "T3CODE_WORKTREE_PATH"]);

/** `base` without thread-scoped variables, such as those the server inherited from an agent shell. */
export function withoutThreadEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base };
  // Windows reads names without regard to case, and a copy of process.env keeps its spelling.
  for (const name of Object.keys(environment)) {
    if (THREAD_VARIABLES.has(name.toUpperCase())) delete environment[name];
  }
  return environment;
}

/** Session identity is stable; native turn IDs are allocated after process launch. */
export function providerThreadEnvironment(
  input: ProviderThreadIdentity,
  base: NodeJS.ProcessEnv = process.env,
  paths?: ProviderThreadPaths,
): NodeJS.ProcessEnv {
  return { ...withoutThreadEnvironment(base), ...providerThreadEnvironmentVariables(input, paths) };
}
