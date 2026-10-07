import type { EnvironmentId, ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import { canSyncThreadGroups } from "@t3tools/shared/threadGroups";

/**
 * Environments the merged custom-group catalog is replicated to: connected,
 * capable, and granted `settings:write`. Every readable catalog still feeds
 * the merge; only the write targets are narrowed.
 */
export function threadGroupReplicationTargets<
  E extends {
    readonly environmentId: EnvironmentId;
    readonly connection: { readonly phase: string };
    readonly serverConfig?: {
      readonly environment: {
        readonly capabilities?: Pick<
          ExecutionEnvironmentCapabilities,
          "threadCustomGroups" | "threadGroupPlacement"
        >;
      };
    } | null;
  },
>(environments: ReadonlyArray<E>, writable: ReadonlySet<EnvironmentId>): E[] {
  return environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      writable.has(environment.environmentId) &&
      canSyncThreadGroups(environment.serverConfig?.environment.capabilities),
  );
}
