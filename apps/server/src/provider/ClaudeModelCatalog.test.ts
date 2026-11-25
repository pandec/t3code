import { assert, describe, it } from "@effect/vitest";
import { type ModelSelection, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { resolveProviderCatalog, type ModelManifestData } from "./ModelManifest.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  capClaudeCatalogEffort,
  type ClaudeModelCatalog,
  formatClaudeVersionUpgradeMessage,
  getClaudeCatalogModelCapabilities,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeCatalogEffort,
  resolveClaudeModelCatalog,
  resolveClaudeModelsForVersion,
  resolveClaudeModelSlug,
  resolveClaudeUpdateRequiredModels,
  scopeClaudeModelCatalog,
  scopeClaudeUpgradeMessageToChannel,
  withClaudeCodeModelRoutes,
} from "./ClaudeModelCatalog.ts";

const manifest = (): ModelManifestData => ({
  version: 1,
  currentModels: {},
  providers: {
    claudeAgent: {
      profiles: {
        synthetic: {
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "extreme", label: "Extreme", isDefault: true }],
              },
              {
                id: "contextWindow",
                label: "Context Window",
                type: "select",
                options: [
                  { id: "large", label: "Large", isDefault: true },
                  { id: "small", label: "Small" },
                ],
              },
            ],
          },
          adapter: {
            claudeCode: {
              effortMap: { extreme: "high" },
              modelSuffixes: { contextWindow: { large: "[large]" } },
            },
          },
        },
      },
      models: [
        {
          slug: "claude-synthetic-next",
          name: "Claude Synthetic Next",
          aliases: ["synthetic"],
          status: "current",
          profile: "synthetic",
          adapter: { claudeCode: { minVersion: "3.2.0" } },
        },
      ],
    },
  },
});

const CLAUDE = ProviderDriverKind.make("claudeAgent");

const catalogFromManifest = (data: ModelManifestData) =>
  resolveClaudeModelCatalog(resolveProviderCatalog(data, CLAUDE) ?? undefined);

describe("Claude model catalog", () => {
  it("resolves capacity from selected options and fixed catalog windows without guessing custom models", () => {
    const source = manifest();
    const profile = source.providers!.claudeAgent!.profiles.synthetic!;
    const catalog = catalogFromManifest({
      ...source,
      providers: {
        claudeAgent: {
          ...source.providers!.claudeAgent!,
          profiles: {
            fixed: {
              capabilities: { optionDescriptors: [] },
              adapter: { claudeCode: { fixedContextWindowTokens: 64_000 } },
            },
            synthetic: {
              ...profile,
              adapter: { claudeCode: { contextWindowTokens: { large: 1_000_000, small: 32_000 } } },
            },
          },
          models: [
            ...source.providers!.claudeAgent!.models,
            {
              slug: "fixed",
              name: "Fixed",
              status: "current",
              profile: "fixed",
            },
          ],
        },
      },
    });
    const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "synthetic" };
    assert.equal(resolveClaudeCatalogContextWindowTokens(catalog, selection), 1_000_000);
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, {
        ...selection,
        options: [{ id: "contextWindow", value: "small" }],
      }),
      32_000,
    );
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "fixed" }),
      64_000,
    );
    assert.isUndefined(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "custom" }),
    );
  });

  it("filters models at runtime-version boundaries and derives the upgrade message", () => {
    const catalog = catalogFromManifest(manifest());
    assert.deepStrictEqual(resolveClaudeModelsForVersion(catalog, "3.1.9"), []);
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next"],
    );
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.1.9"), [
      { slug: "claude-synthetic-next", name: "Claude Synthetic Next", minVersion: "3.2.0" },
    ]);
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.2.0"), []);
    assert.strictEqual(
      formatClaudeVersionUpgradeMessage(catalog, "3.1.9"),
      "Claude Code v3.1.9 is too old for Claude Synthetic Next. Upgrade to v3.2.0 or newer to access it.",
    );
    // A Homebrew cask that still ships 3.1.9 cannot deliver the upgrade the check asked for.
    const probed = {
      version: "3.1.9",
      message: formatClaudeVersionUpgradeMessage(catalog, "3.1.9"),
      versionAdvisory: { latestVersion: "3.1.9", updateCommand: "brew upgrade --cask claude-code" },
    };
    assert.strictEqual(
      scopeClaudeUpgradeMessageToChannel(catalog, probed).message,
      "Claude Code v3.1.9 is too old for Claude Synthetic Next, which needs v3.2.0 or newer, but the claude-code Homebrew cask only has v3.1.9. Switch to the claude-code@latest cask: brew uninstall --cask claude-code && brew install --cask claude-code@latest",
    );
    assert.strictEqual(
      scopeClaudeUpgradeMessageToChannel(catalog, {
        ...probed,
        versionAdvisory: { latestVersion: "3.1.9", updateCommand: null },
      }).message,
      "Claude Code v3.1.9 is too old for Claude Synthetic Next, which needs v3.2.0 or newer, but the newest version this install can update to is v3.1.9. Install Claude Code another way or wait for a newer release.",
    );
    assert.strictEqual(
      scopeClaudeUpgradeMessageToChannel(catalog, {
        ...probed,
        versionAdvisory: { ...probed.versionAdvisory, latestVersion: "3.2.0" },
      }).message,
      probed.message,
    );
    // Claude Code before 2.1.321 does not know claude-fable-5-2 and runs it with a 200K window.
    assert.notInclude(
      resolveClaudeModelsForVersion(BUNDLED_CLAUDE_MODEL_CATALOG, "2.1.320").map(
        (model) => model.slug,
      ),
      "claude-fable-5-2",
    );
  });

  it("resolves aliases and declarative adapter mappings", () => {
    const base = manifest();
    const input: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          models: [
            {
              slug: "claude-synthetic-collision",
              name: "Claude Synthetic Collision",
              aliases: ["claude-synthetic-next"],
              status: "current",
            },
            ...base.providers!.claudeAgent!.models,
          ],
        },
      },
    };
    const catalog = catalogFromManifest(input);
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "claude-synthetic-next");
    assert.strictEqual(
      resolveClaudeModelSlug(catalog, "claude-synthetic-next"),
      "claude-synthetic-next",
    );
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "extreme", "synthetic"), "high");
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "synthetic",
      }),
      "claude-synthetic-next[large]",
    );
  });

  // Gateway-served custom models encode effort in the model id instead of
  // using Claude's native effort option. The remote manifest owns built-ins,
  // never these instance-scoped rules.
  describe("custom gateway models", () => {
    const claude = ProviderInstanceId.make("claudeAgent");
    const catalog = scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, [
      "gpt-5.6-sol=GPT-5.6-Sol",
      "gpt-5.6-luna",
    ]);

    it("appends the selected effort as a model-name suffix", () => {
      assert.strictEqual(
        resolveClaudeCatalogApiModelId(catalog, {
          instanceId: claude,
          model: "gpt-5.6-sol",
          options: [{ id: "effort", value: "xhigh" }],
        }),
        "gpt-5.6-sol(xhigh)",
      );
    });

    it("passes an already-suffixed custom slug through verbatim", () => {
      assert.strictEqual(
        resolveClaudeCatalogApiModelId(catalog, {
          instanceId: claude,
          model: "gpt-5.6-sol(high)",
        }),
        "gpt-5.6-sol(high)",
      );
    });

    it("uses the standard default when no effort is selected", () => {
      assert.strictEqual(
        resolveClaudeCatalogApiModelId(catalog, {
          instanceId: claude,
          model: "gpt-5.6-luna",
        }),
        "gpt-5.6-luna(high)",
      );
    });

    it("never passes Claude-native effort for a custom model", () => {
      assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "high", "gpt-5.6-sol"), undefined);
      assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "xhigh", "gpt-5.6-luna"), undefined);
    });

    it("gives custom models the full effort ladder", () => {
      const caps = getClaudeCatalogModelCapabilities(catalog, "gpt-5.6-sol");
      const effortDescriptor = caps.optionDescriptors?.find(
        (descriptor) => descriptor.id === "effort",
      );
      assert.isDefined(effortDescriptor);
      if (effortDescriptor?.type === "select") {
        assert.deepStrictEqual(
          effortDescriptor.options.map((option) => option.id),
          ["low", "medium", "high", "xhigh"],
        );
      } else {
        assert.fail("custom-model effort descriptor is not a select");
      }
    });

    it("keeps a renamed built-in native instead of on the gateway ladder", () => {
      const scoped = scopeClaudeModelCatalog(catalogFromManifest(manifest()), [
        "claude-synthetic-next=Renamed",
      ]);
      const selection = {
        instanceId: claude,
        model: "claude-synthetic-next",
        options: [{ id: "effort", value: "extreme" }],
      };
      assert.notStrictEqual(
        resolveClaudeCatalogApiModelId(scoped, selection),
        "claude-synthetic-next(high)",
      );
      assert.strictEqual(
        resolveClaudeCatalogApiModelId(scoped, selection),
        resolveClaudeCatalogApiModelId(catalogFromManifest(manifest()), selection),
      );
    });

    it("keeps structured names and supported non-effort descriptors", () => {
      const scoped = scopeClaudeModelCatalog(catalogFromManifest(manifest()), [
        "synthetic",
        {
          slug: "claude-custom-tuned",
          name: "Tuned",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "gentle", label: "Gentle", isDefault: true },
                  { id: "brutal", label: "Brutal" },
                ],
              },
              {
                id: "fastMode",
                label: "Fast mode",
                type: "boolean",
                currentValue: true,
              },
              {
                id: "thinking",
                label: "Thinking",
                type: "boolean",
              },
              {
                id: "temperature",
                label: "Temperature",
                type: "select",
                options: [{ id: "hot", label: "Hot", isDefault: true }],
              },
            ],
          },
        },
      ]);

      // A bare custom slug shadows the built-in alias and remains custom even
      // without authored capabilities.
      assert.strictEqual(resolveClaudeModelSlug(scoped, "synthetic"), "synthetic");
      assert.strictEqual(resolveClaudeCatalogEffort(scoped, "synthetic", "extreme"), "high");

      // Authored effort choices cannot replace the gateway's standard ladder.
      assert.strictEqual(
        resolveClaudeCatalogEffort(scoped, "claude-custom-tuned", "brutal"),
        "high",
      );
      assert.strictEqual(
        normalizeClaudeCatalogEffort(scoped, "brutal", "claude-custom-tuned"),
        undefined,
      );
      assert.strictEqual(
        resolveClaudeCatalogApiModelId(scoped, {
          instanceId: claude,
          model: "claude-custom-tuned",
          options: [{ id: "effort", value: "brutal" }],
        }),
        "claude-custom-tuned(high)",
      );

      const customModel = resolveClaudeModelsForVersion(scoped, "3.2.0").find(
        (model) => model.slug === "claude-custom-tuned",
      );
      assert.strictEqual(customModel?.name, "Tuned");
      assert.deepStrictEqual(
        customModel?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id),
        ["effort", "fastMode", "thinking"],
      );
    });
  });

  // Rows Claude Code 2.1.310 reports from initialization for each configuration.
  it("sends the model id Claude Code reports when it serves a catalog model under another id", () => {
    const apiModel = (
      catalog: ClaudeModelCatalog,
      model: string,
      options?: ModelSelection["options"],
    ) =>
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model,
        ...(options ? { options } : {}),
      });

    // Bedrock with ANTHROPIC_DEFAULT_*_MODEL and an availableModels allowlist of their ids.
    const configuredBedrock = withClaudeCodeModelRoutes(BUNDLED_CLAUDE_MODEL_CATALOG, [
      { value: "default", resolvedModel: "global.anthropic.claude-opus-5-5" },
      { value: "sonnet", resolvedModel: "global.anthropic.claude-sonnet-5-5[1m]" },
      { value: "opus", resolvedModel: "global.anthropic.claude-opus-5-5" },
      { value: "haiku", resolvedModel: "global.anthropic.claude-haiku-5-5" },
    ]);
    assert.strictEqual(apiModel(configuredBedrock, "claude-haiku-5-5"), "haiku");
    assert.strictEqual(apiModel(configuredBedrock, "haiku-5.5"), "haiku");
    assert.strictEqual(apiModel(configuredBedrock, "claude-sonnet-5-5"), "sonnet");
    assert.strictEqual(apiModel(configuredBedrock, "claude-opus-5-5"), "opus");
    assert.strictEqual(apiModel(configuredBedrock, "claude-opus-5"), "claude-opus-5");

    // Fork: routing keeps the scoped catalog's gateway models on their effort ladder.
    const gatewayBedrock = withClaudeCodeModelRoutes(
      scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, ["gateway-sol"]),
      [{ value: "haiku", resolvedModel: "global.anthropic.claude-haiku-5-5" }],
    );
    assert.strictEqual(apiModel(gatewayBedrock, "claude-haiku-5-5"), "haiku");
    assert.strictEqual(apiModel(gatewayBedrock, "gateway-sol"), "gateway-sol(high)");

    // Bedrock with no model settings: Claude Code's `haiku` is Haiku 4.5 there.
    const defaultBedrock = withClaudeCodeModelRoutes(BUNDLED_CLAUDE_MODEL_CATALOG, [
      {
        value: "us.anthropic.claude-opus-4-6-v1",
        resolvedModel: "us.anthropic.claude-opus-4-6-v1",
      },
      {
        value: "us.anthropic.claude-opus-4-6-v1[1m]",
        resolvedModel: "us.anthropic.claude-opus-4-6-v1[1m]",
      },
      { value: "haiku", resolvedModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
    ]);
    assert.strictEqual(
      apiModel(defaultBedrock, "claude-opus-4-6", [{ id: "contextWindow", value: "1m" }]),
      "us.anthropic.claude-opus-4-6-v1[1m]",
    );
    assert.strictEqual(
      apiModel(defaultBedrock, "claude-opus-4-6", [{ id: "contextWindow", value: "200k" }]),
      "us.anthropic.claude-opus-4-6-v1",
    );
    assert.strictEqual(apiModel(defaultBedrock, "claude-haiku-4-5"), "haiku");
    assert.strictEqual(apiModel(defaultBedrock, "claude-haiku-5-5"), "claude-haiku-5-5");

    // First-party ids already are what Claude Code runs, even when an alias points elsewhere.
    const firstParty = withClaudeCodeModelRoutes(BUNDLED_CLAUDE_MODEL_CATALOG, [
      { value: "default", resolvedModel: "claude-opus-5-5" },
      { value: "opus", resolvedModel: "claude-opus-5-5" },
      { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1[1m]" },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
    ]);
    assert.strictEqual(firstParty, BUNDLED_CLAUDE_MODEL_CATALOG);
  });

  it("marks effort options that would run above the cap without changing ids or defaults", () => {
    const effortModel = (slug: string) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
              { id: "max", label: "Max" },
              { id: "ultracode", label: "Ultracode" },
              { id: "ultrathink", label: "Ultrathink" },
            ],
          },
        ],
      },
    });
    const models = [effortModel("claude-plain"), effortModel("claude-remapped")];
    const catalog: ClaudeModelCatalog = {
      models: [
        {
          model: models[0]!,
          runtime: { effortMap: { ultracode: "xhigh", ultrathink: null } },
          compatibility: {},
        },
        {
          model: models[1]!,
          runtime: { effortMap: { max: "high", xhigh: "max", ultrathink: null } },
          compatibility: {},
        },
      ],
    };
    const options = (cap: "high" | "xhigh") =>
      capClaudeCatalogEffort(catalog, models, [{ maxEffortLevel: cap }]).map((model) => {
        const effort = model.capabilities?.optionDescriptors?.[0];
        return effort?.type === "select" ? effort.options : undefined;
      });

    assert.deepStrictEqual(options("high"), [
      [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "xhigh", label: "Extra High (capped to High)" },
        { id: "max", label: "Max (capped to High)" },
        { id: "ultracode", label: "Ultracode (capped to High)" },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "xhigh", label: "Extra High (capped to High)" },
        { id: "max", label: "Max" },
        { id: "ultracode", label: "Ultracode" },
        { id: "ultrathink", label: "Ultrathink" },
      ],
    ]);
    // An effortMap that sends Extra High as max stays unmarked under an xhigh cap: the CLI runs
    // it at xhigh, which is what the label says.
    assert.deepStrictEqual(
      options("xhigh").map((model) => model?.map((option) => option.label)),
      [
        ["Medium", "High", "Extra High", "Max (capped to Extra High)", "Ultracode", "Ultrathink"],
        ["Medium", "High", "Extra High", "Max", "Ultracode", "Ultrathink"],
      ],
    );

    // A per-model cap applies without a top-level one and leaves other models uncapped.
    assert.deepStrictEqual(
      capClaudeCatalogEffort(catalog, models, [
        { modelMaxEffortLevels: new Map([["claude-plain", "high"]]) },
      ]).map((model) => {
        const effort = model.capabilities?.optionDescriptors?.[0];
        return effort?.type === "select" ? effort.options.map((option) => option.label) : [];
      }),
      [
        [
          "Medium",
          "High",
          "Extra High (capped to High)",
          "Max (capped to High)",
          "Ultracode (capped to High)",
          "Ultrathink",
        ],
        ["Medium", "High", "Extra High", "Max", "Ultracode", "Ultrathink"],
      ],
    );

    // Without an Extra High option (Opus 4.6), the CLI clamps an xhigh cap down to High.
    const noXhigh = {
      slug: "claude-no-xhigh",
      name: "claude-no-xhigh",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
            ],
          },
        ],
      },
    };
    const [capped] = capClaudeCatalogEffort(
      { models: [] },
      [noXhigh],
      [{ maxEffortLevel: "xhigh" }],
    );
    const cappedEffort = capped?.capabilities?.optionDescriptors?.[0];
    assert.deepStrictEqual(
      cappedEffort?.type === "select" ? cappedEffort.options.map((option) => option.label) : [],
      ["Low", "Medium", "High", "Max (capped to High)"],
    );
  });

  it("leaves custom model effort labels alone under a cap", () => {
    const custom = {
      slug: "claude-custom-copy",
      name: "Copy",
      isCustom: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max (capped to High)" },
            ],
          },
        ],
      },
    };

    assert.deepStrictEqual(
      capClaudeCatalogEffort({ models: [] }, [custom], [{ maxEffortLevel: "high" }]),
      [custom],
    );
  });

  it("resolves maxEffortLevel per settings source and per model key like Claude Code", () => {
    const opus = {
      slug: "claude-opus-5-5",
      name: "Opus 5.5",
      isCustom: false,
      aliases: ["opus", "opus-5.5", "claude-opus-5.5"],
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
            ],
          },
        ],
      },
    };
    const catalog: ClaudeModelCatalog = {
      models: [
        { model: opus, runtime: {}, compatibility: {} },
        {
          model: {
            slug: "claude-opus-5",
            name: "Opus 5",
            isCustom: false,
            capabilities: { optionDescriptors: [] },
          },
          runtime: {},
          compatibility: {},
        },
      ],
    };
    const maxLabel = (sources: Parameters<typeof capClaudeCatalogEffort>[2]) => {
      const effort = capClaudeCatalogEffort(catalog, [opus], sources)[0]?.capabilities
        ?.optionDescriptors?.[0];
      return effort?.type === "select" ? effort.options.at(-1)?.label : undefined;
    };
    const perModel = (entries: Record<string, "low" | "medium" | "high" | "max">) => ({
      modelMaxEffortLevels: new Map(Object.entries(entries)),
    });

    // Claude Code matches family aliases and [1m] spellings case-insensitively.
    assert.strictEqual(maxLabel([perModel({ Opus: "medium" })]), "Max (capped to Medium)");
    assert.strictEqual(
      maxLabel([perModel({ "claude-opus-5-5[1M]": "medium" })]),
      "Max (capped to Medium)",
    );
    assert.strictEqual(maxLabel([perModel({ " OPUS[1m] ": "medium" })]), "Max (capped to Medium)");
    // Other keys name the most specific model id they contain, so dated and provider-prefixed ids
    // match while the catalog's dotted aliases and a less specific model id do not.
    for (const key of [
      "claude-opus-5-5-20260101",
      "CLAUDE-OPUS-5-5-20260101[1m]",
      "us.anthropic.claude-opus-5-5-v1:0",
      "claude-opus-5-5-latest",
    ]) {
      assert.strictEqual(maxLabel([perModel({ [key]: "medium" })]), "Max (capped to Medium)", key);
    }
    for (const key of ["claude-opus-5.5", "opus-5.5", "opus-5-5", "opus [1m]", "claude-opus-5"]) {
      assert.strictEqual(maxLabel([perModel({ [key]: "medium" })]), "Max", key);
    }
    // Keys naming the same model keep the lowest cap, and a `max` key does not exempt it.
    assert.strictEqual(
      maxLabel([perModel({ opus: "max", "claude-opus-5-5": "low" })]),
      "Max (capped to Low)",
    );
    // A per-model `max` only exempts the model from its own source's top-level cap.
    assert.strictEqual(
      maxLabel([{ maxEffortLevel: "medium", ...perModel({ opus: "max" }) }]),
      "Max",
    );
    assert.strictEqual(
      maxLabel([perModel({ opus: "max" }), { maxEffortLevel: "high" }]),
      "Max (capped to High)",
    );
    assert.strictEqual(
      maxLabel([{ maxEffortLevel: "medium" }, perModel({ opus: "high" })]),
      "Max (capped to Medium)",
    );
  });
});
