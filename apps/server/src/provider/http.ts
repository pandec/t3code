import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type ProviderCatalogInstance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";

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
  const baseHome = continuationKey.slice(prefix.length).trim();
  if (baseHome.length === 0) return undefined;
  return baseHome;
}

const buildProviderCatalog = Effect.fn("environment.providers.buildCatalog")(function* (input: {
  readonly registry: ProviderInstanceRegistry["Service"] | undefined;
}) {
  const instances: Array<ProviderCatalogInstance> = [];
  const providerInstances = input.registry === undefined ? [] : yield* input.registry.listInstances;
  for (const instance of providerInstances) {
    const snapshot = yield* instance.snapshot.getSnapshot;
    const hasImportAdapter =
      instance.adapter.listImportableSessions !== undefined &&
      instance.adapter.readImportableSession !== undefined;
    const home = hasImportAdapter ? providerImportHome(instance) : undefined;
    // File placement requires one static provider home. Relative environment
    // homes remain valid for runtime use, but resolve per workspace cwd and
    // therefore cannot satisfy the locked catalog contract safely.
    const importCapable = hasImportAdapter && home !== undefined;
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
  return yield* buildProviderCatalog({
    registry: Option.getOrUndefined(registry),
  });
});

export const providerCatalogHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "providers",
  Effect.fnUntraced(function* (handlers) {
    const registry = yield* Effect.serviceOption(ProviderInstanceRegistry);
    return handlers.handle(
      "catalog",
      Effect.fn("environment.providers.catalog")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* buildProviderCatalog({
          registry: Option.getOrUndefined(registry),
        });
      }),
    );
  }),
);
