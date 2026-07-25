import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionDescriptor } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderCatalogModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  optionDescriptors: Schema.Array(ProviderOptionDescriptor),
});
export type ProviderCatalogModel = typeof ProviderCatalogModel.Type;

export const ProviderCatalogInstance = Schema.Struct({
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  importCapable: Schema.Boolean,
  home: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ProviderCatalogModel),
});
export type ProviderCatalogInstance = typeof ProviderCatalogInstance.Type;

export const ProviderCatalogResult = Schema.Struct({
  instances: Schema.Array(ProviderCatalogInstance),
});
export type ProviderCatalogResult = typeof ProviderCatalogResult.Type;
