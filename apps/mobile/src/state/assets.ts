import { useAtomValue } from "@effect/atom-react";
import { createAssetEnvironmentAtoms, resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { environmentSession, usePreparedConnection } from "./session";
import { useAtomQueryRunner } from "./use-atom-query-runner";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure" }
  | { readonly _tag: "Success"; readonly url: string };

const EMPTY_ASSET_URL_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-asset-url:empty"),
);

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
  if (result._tag === "Failure") {
    return { _tag: "Failure" };
  }
  if (preparedConnection._tag === "None" || result._tag !== "Success") {
    return { _tag: "Loading" };
  }
  const url = resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl);
  return url === null ? { _tag: "Failure" } : { _tag: "Success", url };
}

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const result = useAssetUrlState(environmentId, resource);
  return result._tag === "Success" ? result.url : null;
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
    if (result._tag === "Failure") {
      finish(null);
      return;
    }
    if (result._tag !== "Success") return;
    const connection = appAtomRegistry.get(connectionAtom);
    if (connection._tag === "None") return;
    finish(resolveAssetUrl(connection.value.httpBaseUrl, result.value.relativeUrl));
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

/** Explicit playback and sharing must reauthorize files that may have been replaced on disk. */
export function useRefreshAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  return useCallback(async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const result = await createUrl({ environmentId, input: { resource } });
    return result._tag === "Success"
      ? resolveAssetUrl(httpBaseUrl, result.value.relativeUrl)
      : null;
  }, [createUrl, environmentId, httpBaseUrl, resource]);
}
