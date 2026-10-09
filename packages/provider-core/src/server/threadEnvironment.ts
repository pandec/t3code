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

/** Session identity is stable; native turn IDs are allocated after process launch. */
export function providerThreadEnvironment(
  input: ProviderThreadIdentity,
  base: NodeJS.ProcessEnv = process.env,
  paths?: ProviderThreadPaths,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base };
  delete environment.T3CODE_TURN_ID;
  delete environment.T3CODE_WORKTREE_PATH;
  return { ...environment, ...providerThreadEnvironmentVariables(input, paths) };
}
