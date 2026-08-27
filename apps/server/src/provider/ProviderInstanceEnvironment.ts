import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Always a copy, even without instance variables: drivers retain the result
  // for the instance's lifetime, and a retained live `process.env` reference
  // would observe the Claude fork driver's temporary CLAUDE_CONFIG_DIR swap
  // (see ClaudeSessionFork.ts) at every later read.
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment ?? []) {
    next[variable.name] = variable.value;
  }
  return next;
}
