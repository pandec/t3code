import { useEffect, useMemo, useRef } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  canSyncThreadGroups,
  mergeThreadGroups,
  retryThreadGroupSync,
  visibleThreadGroups,
} from "@t3tools/shared/threadGroups";
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
          canSyncThreadGroups(environment.serverConfig?.environment.capabilities),
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
  const inFlight = useRef(
    new Map<EnvironmentId, { signature: string; controller: AbortController }>(),
  );
  useEffect(() => {
    const pending = inFlight.current;
    return () => {
      for (const entry of pending.values()) entry.controller.abort();
      pending.clear();
    };
  }, []);
  useEffect(() => {
    const signature = JSON.stringify(catalog);
    const connected = new Set(targets.map((environment) => environment.environmentId));
    for (const [id, entry] of inFlight.current) {
      if (!connected.has(id) || entry.signature !== signature) {
        entry.controller.abort();
        inFlight.current.delete(id);
      }
    }
    for (const environment of targets) {
      if (
        JSON.stringify(mergeThreadGroups(environment.serverConfig?.settings.threadGroups ?? [])) ===
        signature
      )
        continue;
      if (inFlight.current.get(environment.environmentId)?.signature === signature) continue;
      const pending = { signature, controller: new AbortController() };
      inFlight.current.set(environment.environmentId, pending);
      void retryThreadGroupSync(async () => {
        const result = await persist({
          environmentId: environment.environmentId,
          input: { patch: { threadGroups: catalog } },
        });
        return result._tag === "Success";
      }, pending.controller.signal).then(() => {
        if (inFlight.current.get(environment.environmentId) === pending)
          inFlight.current.delete(environment.environmentId);
      });
    }
  }, [catalog, targets, persist]);
  return { groups };
}
