import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import { deriveProviderModelsForDisplay } from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });

  it("parses labeled entries so rows match live custom models by slug", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        isCustom: true,
        capabilities: null,
      },
    ];

    const models = deriveProviderModelsForDisplay({
      liveModels,
      customModels: ["gpt-5.6-sol=GPT-5.6-Sol"],
    });
    expect(models).toEqual([liveModels[0]]);
  });

  it("labels entries the live snapshot does not know yet", () => {
    const models = deriveProviderModelsForDisplay({
      liveModels: [],
      customModels: ["gpt-5.6-sol=GPT-5.6-Sol"],
    });
    expect(models).toEqual([
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        isCustom: true,
        capabilities: null,
      },
    ]);
  });
});
