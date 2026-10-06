import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type ProviderCatalogInstance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

/**
 * The one static home an instance's sessions live in, read from its
 * continuation key. Relative environment homes resolve per workspace, so they
 * have none and transcripts can't be placed for them.
 */
export function providerImportHome(instance: ProviderInstance): string | undefined {
  const prefix =
    instance.driverKind === "claudeAgent"
      ? "claude:home:"
      : instance.driverKind === "codex"
        ? "codex:home:"
        : null;
  if (prefix === null) return undefined;
  const continuationKey = instance.continuationIdentity.continuationKey;
  if (!continuationKey.startsWith(prefix)) return undefined;
  const home = continuationKey.slice(prefix.length).trim();
  return home.length === 0 ? undefined : home;
}

/** Provider instances with their models and import home; carries no secrets. */
export const buildProviderCatalog = Effect.fn("environment.providers.buildCatalog")(function* (
  instances: ReadonlyArray<ProviderInstance>,
) {
  const catalog: Array<ProviderCatalogInstance> = [];
  for (const instance of instances) {
    const snapshot = yield* instance.snapshot.getSnapshot;
    const home = instance.sessionImport === undefined ? undefined : providerImportHome(instance);
    catalog.push({
      instanceId: instance.instanceId,
      driverKind: instance.driverKind,
      displayName: instance.displayName ?? snapshot.displayName ?? instance.driverKind,
      enabled: instance.enabled,
      importCapable: home !== undefined,
      ...(home === undefined ? {} : { home }),
      models: snapshot.models.map((model) => ({
        slug: model.slug,
        name: model.name,
        optionDescriptors: model.capabilities?.optionDescriptors ?? [],
      })),
    });
  }
  return { instances: catalog };
});

export const providerCatalogHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "providers",
  Effect.fnUntraced(function* (handlers) {
    const registry = yield* ProviderInstanceRegistry;
    return handlers.handle(
      "catalog",
      Effect.fn("environment.providers.catalog")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* buildProviderCatalog(yield* registry.listInstances);
      }),
    );
  }),
);
