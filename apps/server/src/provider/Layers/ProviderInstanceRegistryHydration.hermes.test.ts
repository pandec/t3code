import { expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

it("hydrates the default Hermes instance from legacy provider settings", () => {
  const instances = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
  expect(instances[ProviderInstanceId.make("hermes")]).toEqual({
    driver: "hermes",
    config: {
      enabled: false,
      binaryPath: "hermes",
      requireGateway: true,
      customModels: [],
    },
  });
});
