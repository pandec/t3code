import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentConnectionPhase,
  presentConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  assetUrlStateFromResult,
  createAssetEnvironmentAtoms,
  EMPTY_ASSET_URL_ATOM,
} from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { type AssetUrlState, deriveAssetUrlState } from "./asset-url-state";
import { appAtomRegistry } from "./atom-registry";
import { environmentSession, usePreparedConnection } from "./session";
import { useAtomQueryRunner } from "./use-atom-query-runner";

export type { AssetUrlFailureReason, AssetUrlState } from "./asset-url-state";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_CONNECTION_STATE_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-asset-connection-state:empty"),
);

function useConnectionPhase(environmentId: EnvironmentId | null): EnvironmentConnectionPhase {
  const state = useAtomValue(
    environmentId === null
      ? EMPTY_CONNECTION_STATE_ATOM
      : environmentCatalog.stateAtom(environmentId),
  );
  const value = Option.getOrNull(AsyncResult.value(state));
  return value === null ? "available" : presentConnectionState(value).phase;
}

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const connectionPhase = useConnectionPhase(environmentId);
  const result = useAtomValue(
    environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  const shared = assetUrlStateFromResult(
    result,
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
  );
  return deriveAssetUrlState({
    connectionPhase,
    // A failure left over from an outage is re-queried as soon as the
    // connection returns. While that re-query is in flight it is not a verdict
    // on the file, so it reads as loading rather than a false "unavailable".
    shared: shared._tag === "Failure" && result.waiting ? { _tag: "Loading" } : shared,
  });
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
    const connection = appAtomRegistry.get(connectionAtom);
    const state = assetUrlStateFromResult(
      appAtomRegistry.get(urlAtom),
      connection._tag === "Some" ? connection.value.httpBaseUrl : null,
    );
    if (state._tag === "Failure") {
      finish(null);
      return;
    }
    if (state._tag === "Success") finish(state.url);
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
    const state = assetUrlStateFromResult(
      await createUrl({ environmentId, input: { resource } }),
      httpBaseUrl,
    );
    return state._tag === "Success" ? state.url : null;
  }, [createUrl, environmentId, httpBaseUrl, resource]);
}
