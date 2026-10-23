import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { type CommandId, ProjectId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  clampAccentTintIntensityPercent,
  clampProviderUsageAlertPercent,
  clampSteerGraceWindowMs,
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  idleCompactionPatch,
  requiredScopesForProjectMutation,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  withIdleCompaction,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "any-local-files",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      // Fork: the default local-file policy is any-local-files.
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "any-local-files" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "any-local-files" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });
});

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("resolveIdleCompaction", () => {
  it("lets a Claude instance override the global default", () => {
    const settings = decodeServerSettings({
      idleCompaction: "off",
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: { idleCompaction: "onReturn" } },
        claude_personal: { driver: "claudeAgent" },
      },
    });
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_work"))).toBe(
      "onReturn",
    );
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_personal"))).toBe("off");
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claudeAgent"))).toBe("off");
  });

  it("reads the mode from the legacy switch, in either form servers saved it", () => {
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: true }))).toBe(
      "beforeCacheExpires",
    );
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: "off" }))).toBe("off");
    expect(globalIdleCompaction(decodeServerSettings({}))).toBe("onReturn");
  });

  it("keeps the legacy switch a boolean, as shipped clients decode it", () => {
    const encode = Schema.encodeSync(Schema.toCodecJson(ServerSettings));
    for (const mode of ["onReturn", "beforeCacheExpires", "off"] as const) {
      const encoded = encode(withIdleCompaction(DEFAULT_SERVER_SETTINGS, mode)) as {
        readonly compactIdleThreads: unknown;
        readonly idleCompaction: unknown;
      };
      expect(encoded.compactIdleThreads).toBe(mode === "beforeCacheExpires");
      expect(encoded.idleCompaction).toBe(mode);
    }
  });

  it("patches the field the server reads", () => {
    expect(
      idleCompactionPatch({ compactIdleThreads: false, idleCompaction: "onReturn" }, "off"),
    ).toEqual({
      idleCompaction: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: "onReturn" }, "off")).toEqual({
      compactIdleThreads: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: false }, "beforeCacheExpires")).toEqual({
      compactIdleThreads: true,
    });
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });
});

describe("ClientSettings sidebar", () => {
  it("accepts opting into the project-row new-thread button", () => {
    expect(
      decodeClientSettingsPatch({
        sidebarV2NewThreadButtonInProjectRow: true,
      }).sidebarV2NewThreadButtonInProjectRow,
    ).toBe(true);
  });

  it("discards retired Older section settings without changing other preferences", () => {
    const preferences = { sidebarV2CompactCards: true, sidebarThreadPreviewCount: 12 };
    const stored = {
      ...preferences,
      sidebarOlderSectionEnabled: true,
      sidebarOlderSectionAfterDays: 14,
      sidebarOlderSectionCollapsedByDefault: false,
    };
    expect(decodeClientSettings(stored)).toEqual(decodeClientSettings(preferences));
    expect(decodeClientSettingsPatch(stored)).toEqual(preferences);
  });
});

describe("ClientSettings archived section", () => {
  it("defaults to ten visible threads", () => {
    expect(decodeClientSettings({}).archivedSectionVisibleCount).toBe(10);
  });

  it.each([0, 51, 1.5])("rejects invalid visible count %s", (value) => {
    expect(() => decodeClientSettings({ archivedSectionVisibleCount: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ archivedSectionVisibleCount: value })).toThrow();
  });

  it.each([1, 10, 50])("accepts visible count %s", (value) => {
    expect(
      decodeClientSettings({ archivedSectionVisibleCount: value }).archivedSectionVisibleCount,
    ).toBe(value);
    expect(
      decodeClientSettingsPatch({ archivedSectionVisibleCount: value }).archivedSectionVisibleCount,
    ).toBe(value);
  });
});

describe("ClientSettings sidebar project accents", () => {
  it("defaults to no project accents", () => {
    expect(decodeClientSettings({}).sidebarProjectAccentColors).toEqual({});
  });

  it("accepts arbitrary six-digit hex colors in settings and patches", () => {
    const accents = {
      "environment-local:/work/project-a": "#12AbEf",
      "environment-remote:/work/project-b": "#00ff00",
    };

    expect(
      decodeClientSettings({ sidebarProjectAccentColors: accents }).sidebarProjectAccentColors,
    ).toEqual(accents);
    expect(
      decodeClientSettingsPatch({ sidebarProjectAccentColors: accents }).sidebarProjectAccentColors,
    ).toEqual(accents);
  });

  it.each(["red", "#12345", "#12345g", "#12345678"])(
    "rejects an invalid project accent: %s",
    (color) => {
      const accents = { "environment-local:/work/project": color };
      expect(() => decodeClientSettings({ sidebarProjectAccentColors: accents })).toThrow();
      expect(() => decodeClientSettingsPatch({ sidebarProjectAccentColors: accents })).toThrow();
    },
  );
});

describe("ServerSettings project accents", () => {
  it("decodes an absent map to empty, so older servers stay readable", () => {
    expect(decodeServerSettings({}).projectAccentColors).toEqual({});
    expect(DEFAULT_SERVER_SETTINGS.projectAccentColors).toEqual({});
  });

  it("accepts machine-independent keys in settings and replacement or fill patches", () => {
    const accents = {
      "github.com/t3tools/t3code": "#12AbEf",
      "/work/not-a-repo": "#00ff00",
    };

    expect(decodeServerSettings({ projectAccentColors: accents }).projectAccentColors).toEqual(
      accents,
    );
    expect(decodeServerSettingsPatch({ projectAccentColors: accents }).projectAccentColors).toEqual(
      accents,
    );
    expect(
      decodeServerSettingsPatch({ projectAccentColorsFill: accents }).projectAccentColorsFill,
    ).toEqual(accents);
    expect(
      decodeServerSettingsPatch({
        projectAccentColors: {},
        projectAccentColorsFill: accents,
      }),
    ).toEqual({
      projectAccentColors: {},
      projectAccentColorsFill: accents,
    });
  });

  it.each(["red", "#12345", "#12345g", "#12345678"])(
    "rejects an invalid project accent: %s",
    (color) => {
      const accents = { "github.com/t3tools/t3code": color };
      expect(() => decodeServerSettings({ projectAccentColors: accents })).toThrow();
      expect(() => decodeServerSettingsPatch({ projectAccentColors: accents })).toThrow();
      expect(() => decodeServerSettingsPatch({ projectAccentColorsFill: accents })).toThrow();
    },
  );
});

describe("ClientSettings sidebar provider icon visibility", () => {
  it("preserves the existing hover-only behavior by default", () => {
    expect(decodeClientSettings({}).sidebarThreadProviderIconVisibility).toBe("hover");
  });

  it.each(["hover", "always", "never"] as const)("accepts %s visibility in patches", (value) => {
    expect(
      decodeClientSettingsPatch({
        sidebarThreadProviderIconVisibility: value,
      }).sidebarThreadProviderIconVisibility,
    ).toBe(value);
  });

  it("rejects unsupported visibility values", () => {
    expect(() =>
      decodeClientSettingsPatch({
        sidebarThreadProviderIconVisibility: "sometimes",
      }),
    ).toThrow();
  });
});

describe("ClientSettings pull request merge methods", () => {
  it("defaults to no project overrides and accepts supported methods", () => {
    expect(decodeClientSettings({}).pullRequestMergeMethodOverrides).toEqual({});
    expect(
      decodeClientSettingsPatch({
        pullRequestMergeMethodOverrides: { project: "squash" },
      }).pullRequestMergeMethodOverrides,
    ).toEqual({ project: "squash" });
  });

  it("rejects unsupported project merge methods", () => {
    expect(() =>
      decodeClientSettingsPatch({
        pullRequestMergeMethodOverrides: { project: "fast-forward" },
      }),
    ).toThrow();
  });
});

describe("ClientSettings extras", () => {
  it("keeps prior behaviour by default", () => {
    const settings = decodeClientSettings({});
    expect(settings.steerGraceWindowMs).toBe(5_000);
    expect(settings.providerUsageWarningPercent).toBe(80);
    expect(settings.providerUsageCriticalPercent).toBe(95);
    expect(settings.maskProviderUsageEmails).toBe(false);
    expect(settings.openRouterCreditsBudgetUsd).toBeNull();
    expect(settings.accentTintsEnabled).toBe(true);
    expect(settings.accentTintIntensityPercent).toBe(12);
  });

  it("drops the removed Attention filter key from stored settings", () => {
    const settings = decodeClientSettings({ sidebarAlwaysShowPinnedInAttention: true });
    expect(settings).not.toHaveProperty("sidebarAlwaysShowPinnedInAttention");
  });

  it("accepts in-range values in patches", () => {
    expect(
      decodeClientSettingsPatch({
        steerGraceWindowMs: 0,
        providerUsageWarningPercent: 1,
        providerUsageCriticalPercent: 100,
        maskProviderUsageEmails: true,
        openRouterCreditsBudgetUsd: 50,
        accentTintsEnabled: false,
        accentTintIntensityPercent: 30,
      }),
    ).toEqual({
      steerGraceWindowMs: 0,
      providerUsageWarningPercent: 1,
      providerUsageCriticalPercent: 100,
      maskProviderUsageEmails: true,
      openRouterCreditsBudgetUsd: 50,
      accentTintsEnabled: false,
      accentTintIntensityPercent: 30,
    });
  });

  it("clears and round-trips the OpenRouter budget", () => {
    expect(decodeClientSettingsPatch({ openRouterCreditsBudgetUsd: null })).toEqual({
      openRouterCreditsBudgetUsd: null,
    });
    for (const budget of [12.5, null]) {
      const encoded = encodeClientSettings(
        decodeClientSettings({ openRouterCreditsBudgetUsd: budget }),
      );
      expect(decodeClientSettings(encoded).openRouterCreditsBudgetUsd).toBe(budget);
    }
  });

  it.each([
    { steerGraceWindowMs: 15_001 },
    { steerGraceWindowMs: -1 },
    { providerUsageWarningPercent: 0 },
    { providerUsageCriticalPercent: 101 },
    { openRouterCreditsBudgetUsd: 0 },
    { openRouterCreditsBudgetUsd: -5 },
    { openRouterCreditsBudgetUsd: 1_000_001 },
    { accentTintIntensityPercent: 3 },
    { accentTintIntensityPercent: 31 },
  ])("rejects out-of-range %o", (patch) => {
    expect(() => decodeClientSettingsPatch(patch)).toThrow();
  });

  it("clamps hand-edited values on read", () => {
    expect(clampSteerGraceWindowMs(99_999)).toBe(15_000);
    expect(clampSteerGraceWindowMs(Number.NaN)).toBe(5_000);
    expect(clampProviderUsageAlertPercent(0, 80)).toBe(1);
    expect(clampProviderUsageAlertPercent(Number.NaN, 80)).toBe(80);
    expect(clampAccentTintIntensityPercent(1)).toBe(4);
    expect(clampAccentTintIntensityPercent(99)).toBe(30);
  });
});

describe("ServerSettings.voice", () => {
  const unsetProfile = { provider: "openrouter", modelId: "", voiceId: "", instructions: "" };

  it("defaults to an unset OpenRouter profile, so the server keeps its env/default resolution", () => {
    expect(DEFAULT_SERVER_SETTINGS.voice).toEqual({
      tts: unsetProfile,
      agentReplyTts: null,
      enableAgentVoiceReplies: true,
    });
    expect(decodeServerSettings({}).voice).toEqual({
      tts: unsetProfile,
      agentReplyTts: null,
      enableAgentVoiceReplies: true,
    });
  });

  it("fills a partial profile and trims values in both the settings and the patch", () => {
    expect(
      decodeServerSettings({
        voice: { tts: { provider: "elevenlabs", modelId: "  eleven_v3  " } },
      }).voice,
    ).toEqual({
      tts: { ...unsetProfile, provider: "elevenlabs", modelId: "eleven_v3" },
      agentReplyTts: null,
      enableAgentVoiceReplies: true,
    });
    expect(
      decodeServerSettings({ voice: { agentReplyTts: { voiceId: " Puck " } } }).voice.agentReplyTts,
    ).toEqual({ ...unsetProfile, voiceId: "Puck" });
    expect(decodeServerSettingsPatch({ voice: { tts: { voiceId: "  abc  " } } })).toEqual({
      voice: { tts: { voiceId: "abc" } },
    });
    expect(decodeServerSettingsPatch({ voice: { agentReplyTts: null } })).toEqual({
      voice: { agentReplyTts: null },
    });
  });

  it("ignores the pre-OpenRouter model and voice keys", () => {
    // The server folds these into the ElevenLabs profile on load; the schema
    // itself must not reject a file that still carries them.
    expect(
      decodeServerSettings({ voice: { ttsModelId: "eleven_v3", ttsVoiceId: "abc" } }).voice.tts,
    ).toEqual(unsetProfile);
  });

  it("round-trips the agent voice replies toggle through the patch", () => {
    expect(
      decodeServerSettings({ voice: { enableAgentVoiceReplies: false } }).voice
        .enableAgentVoiceReplies,
    ).toBe(false);
    expect(decodeServerSettingsPatch({ voice: { enableAgentVoiceReplies: false } })).toEqual({
      voice: { enableAgentVoiceReplies: false },
    });
  });
});

describe("provider enabled defaults", () => {
  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ServerSettings environment icon", () => {
  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});
