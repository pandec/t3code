import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type ProviderCatalogInstance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";

export function providerImportHome(
  instance: ProviderInstance,
  path: Pick<Path.Path, "join">,
): string | undefined {
  const prefix =
    instance.driverKind === "claudeAgent"
      ? "claude:home:"
      : instance.driverKind === "codex"
        ? "codex:home:"
        : null;
  if (prefix === null) return undefined;
  const continuationKey = instance.continuationIdentity.continuationKey;
  if (!continuationKey.startsWith(prefix)) return undefined;
  const baseHome = continuationKey.slice(prefix.length).trim();
  if (baseHome.length === 0) return undefined;
  return instance.driverKind === "claudeAgent" ? path.join(baseHome, ".claude") : baseHome;
}

const buildProviderCatalog = Effect.fn("environment.providers.buildCatalog")(function* (input: {
  readonly registry: ProviderInstanceRegistry["Service"] | undefined;
  readonly path: Pick<Path.Path, "join">;
}) {
  const instances: Array<ProviderCatalogInstance> = [];
  const providerInstances = input.registry === undefined ? [] : yield* input.registry.listInstances;
  for (const instance of providerInstances) {
    const snapshot = yield* instance.snapshot.getSnapshot;
    const importCapable =
      instance.adapter.listImportableSessions !== undefined &&
      instance.adapter.readImportableSession !== undefined;
    const home = importCapable ? providerImportHome(instance, input.path) : undefined;
    instances.push({
      instanceId: instance.instanceId,
      driverKind: instance.driverKind,
      displayName: instance.displayName ?? snapshot.displayName ?? instance.driverKind,
      enabled: instance.enabled,
      importCapable,
      ...(home === undefined ? {} : { home }),
      models: snapshot.models.map((model) => ({
        slug: model.slug,
        name: model.name,
        optionDescriptors: model.capabilities?.optionDescriptors ?? [],
      })),
    });
  }
  return { instances };
});

export const getProviderCatalogHttp = Effect.fn("environment.providers.catalog")(function* () {
  yield* requireEnvironmentScope(AuthOrchestrationReadScope);
  const registry = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const path = yield* Path.Path;
  return yield* buildProviderCatalog({
    registry: Option.getOrUndefined(registry),
    path,
  });
});

export const providerCatalogHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "providers",
  Effect.fnUntraced(function* (handlers) {
    const registry = yield* Effect.serviceOption(ProviderInstanceRegistry);
    const path = yield* Path.Path;
    return handlers.handle(
      "catalog",
      Effect.fn("environment.providers.catalog")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* buildProviderCatalog({
          registry: Option.getOrUndefined(registry),
          path,
        });
      }),
    );
  }),
);
