import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import type { ModelManifestData } from "./ModelManifest.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  formatClaudeVersionUpgradeMessage,
  getClaudeCatalogModelCapabilities,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeModelCatalog,
  resolveClaudeModelsForVersion,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "./ClaudeModelCatalog.ts";

/**
 * Test policy: adding or changing a real Claude model in model-manifest.json
 * must not add or update tests here. These synthetic fixtures cover resolver
 * behavior once. Add a test only when Claude adapter semantics change, such
 * as introducing a new compatibility rule or dispatch mapping type.
 */

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
                options: [{ id: "large", label: "Large", isDefault: true }],
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

describe("Claude model catalog", () => {
  it("filters models at runtime-version boundaries and derives the upgrade message", () => {
    const catalog = resolveClaudeModelCatalog(manifest());
    assert.deepStrictEqual(resolveClaudeModelsForVersion(catalog, "3.1.9"), []);
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next"],
    );
    assert.strictEqual(
      formatClaudeVersionUpgradeMessage(catalog, "3.1.9"),
      "Claude Code v3.1.9 is too old for Claude Synthetic Next. Upgrade to v3.2.0 or newer to access it.",
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
    const catalog = resolveClaudeModelCatalog(input);
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

  it("rejects malformed adapter mappings", () => {
    const base = manifest();
    const malformed: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          profiles: {
            ...base.providers!.claudeAgent!.profiles,
            synthetic: {
              ...base.providers!.claudeAgent!.profiles.synthetic!,
              adapter: { claudeCode: { effortMap: { extreme: 123 } } },
            },
          },
        },
      },
    };
    assert.isFalse(hasValidClaudeManifestAdapters(malformed));
  });

  // The fork's custom (gateway-served) models consume effort through a
  // parenthesized model-name suffix instead of Claude-native effort. These
  // rules must survive manifest changes: the remote manifest owns built-ins,
  // never the fork's configured custom models.
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

    it("leaves a custom slug bare when no effort is selected and no default applies", () => {
      const id = resolveClaudeCatalogApiModelId(catalog, {
        instanceId: claude,
        model: "gpt-5.6-luna",
      });
      assert.match(id, /^gpt-5\.6-luna(\([a-z]+\))?$/);
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
  });
});
