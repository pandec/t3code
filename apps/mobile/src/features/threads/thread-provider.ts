import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

/**
 * Driver id ("claudeAgent", "codex", "hermes", …) of the provider a thread
 * runs on, or null when the environment's config is not loaded. The live
 * session wins over the stored selection so a thread that was re-pointed at
 * another provider mid-run reports what is actually running.
 */
export function resolveThreadProviderDriver(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
  thread: EnvironmentThreadShell,
): string | null {
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  return (
    serverConfigs
      .get(thread.environmentId)
      ?.providers.find((provider) => provider.instanceId === instanceId)?.driver ?? null
  );
}

/**
 * Spoken name for a driver, for row accessibility labels. Null for drivers
 * with no established name — {@link ProviderIcon} falls back to the OpenAI
 * mark for those, and announcing a raw driver id would be worse than silence.
 */
export function providerDisplayName(driver: string | null): string | null {
  switch (driver) {
    case "claudeAgent":
      return "Claude";
    case "codex":
      return "Codex";
    case "hermes":
      return "Hermes";
    default:
      return null;
  }
}
