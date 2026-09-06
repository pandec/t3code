import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState,
  assetUrlStateFromResult,
  EMPTY_ASSET_URL_ATOM,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { assetEnvironment } from "~/state/assets";
import { environmentSession, usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl, type AssetUrlState } from "@t3tools/client-runtime/state/assets";

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  return assetUrlStateFromResult(
    result,
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
  );
}

/**
 * Imperative one-shot asset URL resolution, independent of any component
 * lifetime: subscribing through the app registry keeps the query mounted
 * until it settles, so a caller can outlive the row that started it. Calls
 * onResolved exactly once with the absolute URL, or null on failure; the
 * returned function cancels the watch.
 */
export function watchAssetUrl(
  environmentId: EnvironmentId,
  resource: AssetResource,
  onResolved: (url: string | null) => void,
): () => void {
  const urlAtom = assetEnvironment.createUrl({ environmentId, input: { resource } });
  const connectionAtom = environmentSession.preparedConnectionValueAtom(environmentId);
  let done = false;
  let unsubscribeUrl: (() => void) | null = null;
  let unsubscribeConnection: (() => void) | null = null;

  const finish = (url: string | null) => {
    if (done) return;
    done = true;
    unsubscribeUrl?.();
    unsubscribeConnection?.();
    onResolved(url);
  };
  const evaluate = () => {
    const result = appAtomRegistry.get(urlAtom);
    const connection = appAtomRegistry.get(connectionAtom);
    const state = assetUrlStateFromResult(
      result,
      connection._tag === "Some" ? connection.value.httpBaseUrl : null,
    );
    if (state._tag === "Loading") return;
    finish(state._tag === "Success" ? state.url : null);
  };

  unsubscribeUrl = appAtomRegistry.subscribe(urlAtom, evaluate);
  unsubscribeConnection = appAtomRegistry.subscribe(connectionAtom, evaluate);
  evaluate();
  return () => {
    if (done) return;
    done = true;
    unsubscribeUrl?.();
    unsubscribeConnection?.();
  };
}

export function useAssetUrlRefresh(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<void> {
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(async () => {
    if (environmentId === null || resource === null) return;
    const result = await refresh({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  }, [environmentId, resource, refresh]);
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources,
    }),
  );
  return useMemo(
    () =>
      preparedConnection._tag === "None"
        ? resources.map(() => null)
        : results.map((result) =>
            AsyncResult.isSuccess(result)
              ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
              : null,
          ),
    [preparedConnection, resources, results],
  );
}
