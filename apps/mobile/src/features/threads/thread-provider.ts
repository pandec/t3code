import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ServerConfig } from "@t3tools/contracts";

/**
 * Driver id ("claudeAgent", "codex", "hermes", …) of the provider a thread
 * runs on, or null when the environment's config is not loaded. The live
 * session wins over the stored selection so a thread that was re-pointed at
 * another provider mid-run reports what is actually running.
 */
export function resolveThreadProviderDriver(
  providers: ServerConfig["providers"] | undefined,
  thread: EnvironmentThreadShell,
): string | null {
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  return providers?.find((provider) => provider.instanceId === instanceId)?.driver ?? null;
}
