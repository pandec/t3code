import { expandHomePath } from "../pathExpansion.ts";

/** Expand a provider Binary path in its in-memory runtime config without rewriting persisted settings. */
export function withExpandedProviderBinaryPath<Config extends { readonly binaryPath: string }>(
  config: Config,
) {
  return {
    ...config,
    binaryPath: expandHomePath(config.binaryPath),
  };
}
