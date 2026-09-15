import { useEffect, useMemo, useRef } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { mergeThreadGroups, visibleThreadGroups } from "@t3tools/shared/threadGroups";
import { useEnvironments } from "./environments";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

/** Connected clients bridge the catalog between servers; thread membership stays with its owner. */
export function useThreadGroups() {
  const { environments } = useEnvironments();
  const persist = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const targets = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.connection.phase === "connected" &&
          environment.serverConfig?.environment.capabilities.threadCustomGroups === true,
      ),
    [environments],
  );
  const catalog = useMemo(
    () =>
      mergeThreadGroups(
        ...environments.flatMap((environment) =>
          environment.serverConfig ? [environment.serverConfig.settings.threadGroups] : [],
        ),
      ),
    [environments],
  );
  const groups = useMemo(() => visibleThreadGroups(catalog), [catalog]);
  const inFlight = useRef(new Map<EnvironmentId, string>());
  useEffect(() => {
    const signature = JSON.stringify(catalog);
    for (const environment of targets) {
      if (
        JSON.stringify(mergeThreadGroups(environment.serverConfig?.settings.threadGroups ?? [])) ===
        signature
      )
        continue;
      if (inFlight.current.get(environment.environmentId) === signature) continue;
      inFlight.current.set(environment.environmentId, signature);
      void persist({
        environmentId: environment.environmentId,
        input: { patch: { threadGroups: catalog } },
      }).then(() => {
        if (inFlight.current.get(environment.environmentId) === signature)
          inFlight.current.delete(environment.environmentId);
      });
    }
  }, [catalog, targets, persist]);
  return { groups };
}
