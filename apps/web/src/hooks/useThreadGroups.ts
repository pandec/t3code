import { randomUUID } from "~/lib/utils";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { EnvironmentId, ThreadGroup } from "@t3tools/contracts";
import {
  mergeThreadGroups,
  retryThreadGroupSync,
  nextThreadGroupRevision,
  visibleThreadGroups,
} from "@t3tools/shared/threadGroups";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

/** Merged group catalog across environments, read-only. Mount `useThreadGroups`
 * exactly once (the sidebar) for replication; every other reader uses this. */
export function useThreadGroupCatalog() {
  const { environments } = useEnvironments();
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
  return { catalog, groups, targets, canEdit: targets.length > 0 };
}

/** Connected clients bridge the catalog between servers; thread membership stays with its owner. */
export function useThreadGroups() {
  const { catalog, groups, targets, canEdit } = useThreadGroupCatalog();
  const persist = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const save = useAtomCommand(serverEnvironment.updateSettings, "thread groups update");
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
  const latest = useRef(catalog);
  useEffect(() => {
    latest.current = mergeThreadGroups(latest.current, catalog);
  }, [catalog]);
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
  const update = useCallback(
    async (entries: ReadonlyArray<Omit<ThreadGroup, "revision">>) => {
      const revision = nextThreadGroupRevision(
        mergeThreadGroups(latest.current, catalog),
        Date.now(),
        randomUUID(),
      );
      const patch = entries.map((entry) => ({ ...entry, revision }));
      latest.current = mergeThreadGroups(latest.current, patch);
      const results = await Promise.all(
        targets.map((environment) =>
          save({
            environmentId: environment.environmentId,
            input: { patch: { threadGroups: patch } },
          }),
        ),
      );
      const success = results.some((result) => result._tag === "Success");
      if (success) latest.current = mergeThreadGroups(latest.current, patch);
      return success;
    },
    [save, targets, catalog],
  );
  return { groups, update, canEdit };
}
