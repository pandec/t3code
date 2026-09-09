import type { ProviderSessionStartInput } from "@t3tools/contracts";

/** Session identity is stable; native turn IDs are allocated after process launch. */
export function providerThreadEnvironment(
  input: Pick<ProviderSessionStartInput, "threadId" | "cwd">,
  base: NodeJS.ProcessEnv = process.env,
  paths?: { readonly baseDir: string; readonly stateDir: string },
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base, T3CODE_THREAD_ID: input.threadId };
  if (paths) {
    environment.T3CODE_HOME = paths.baseDir;
    environment.T3CODE_STATE_DIR = paths.stateDir;
  }
  delete environment.T3CODE_TURN_ID;
  delete environment.T3CODE_WORKTREE_PATH;
  if (input.cwd) environment.T3CODE_WORKTREE_PATH = input.cwd;
  return environment;
}
