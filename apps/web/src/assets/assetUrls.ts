import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState as RuntimeAssetUrlState,
  assetUrlStateFromResult,
  blockedAssetUrlState,
  EMPTY_ASSET_URL_ATOM,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { assetEnvironment } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { environmentSession, usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export type AssetUrlState = RuntimeAssetUrlState & { readonly waiting?: boolean };

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const blocked = blockedAssetUrlState(resource, useFilesystemReadAccess(environmentId));
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    blocked !== null || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  if (blocked !== null) return blocked;
  return {
    ...assetUrlStateFromResult(
      result,
      preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
    ),
    ...(result.waiting ? { waiting: true } : {}),
  };
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
): () => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const result = await refresh({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  };
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const allowedResources = canReadFiles
    ? resources
    : resources.filter((resource) => !isFileResource(resource));
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources: allowedResources,
    }),
  );
  if (preparedConnection._tag === "None") return resources.map(() => null);
  const urls: Array<string | null> = [];
  let resultIndex = 0;
  for (const resource of resources) {
    if (!canReadFiles && isFileResource(resource)) {
      urls.push(null);
      continue;
    }
    const result = results[resultIndex];
    resultIndex += 1;
    urls.push(
      result && AsyncResult.isSuccess(result)
        ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
        : null,
    );
  }
  return urls;
}

function isFileResource(resource: AssetResource): boolean {
  return (
    resource._tag === "workspace-file" ||
    resource._tag === "media-file" ||
    resource._tag === "draft-workspace-file"
  );
}
