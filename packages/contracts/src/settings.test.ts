import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  clampAccentTintIntensityPercent,
  clampProviderUsageAlertPercent,
  clampSteerGraceWindowMs,
  clampTurnCompletionMinDurationSeconds,
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  defaultEnabledForDriver,
  HermesSettings,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeHermesSettings = Schema.decodeUnknownSync(HermesSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("ClaudeSettings auto-compaction", () => {
  it("uses Claude's default threshold when no override is configured", () => {
    expect(decodeClaudeSettings({}).autoCompactWindow).toBe("");
  });

  it.each(["100000", "300000", "1000000"])(
    "accepts a supported auto-compaction threshold: %s",
    (value) => {
      expect(decodeClaudeSettings({ autoCompactWindow: value }).autoCompactWindow).toBe(value);
    },
  );

  it.each(["99999", "1000001", "300k", "invalid"])(
    "rejects an unsupported auto-compaction threshold: %s",
    (value) => {
      expect(() => decodeClaudeSettings({ autoCompactWindow: value })).toThrow();
    },
  );

  it("rejects an unsupported threshold at the settings patch boundary", () => {
    expect(() =>
      decodeServerSettingsPatch({ providers: { claudeAgent: { autoCompactWindow: "300k" } } }),
    ).toThrow();
    expect(
      decodeServerSettingsPatch({ providers: { claudeAgent: { autoCompactWindow: "300000" } } }),
    ).toBeDefined();
  });
});

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("ClientSettings turn completion notifications", () => {
  it("defaults both independent notification settings off", () => {
    const settings = decodeClientSettings({});
    expect(settings.enableTurnCompletionToasts).toBe(false);
    expect(settings.enableTurnCompletionSystemNotifications).toBe(false);
  });

  it("accepts each notification setting independently in patches", () => {
    expect(
      decodeClientSettingsPatch({
        enableTurnCompletionToasts: true,
        enableTurnCompletionSystemNotifications: false,
      }),
    ).toEqual({
      enableTurnCompletionToasts: true,
      enableTurnCompletionSystemNotifications: false,
    });
  });
});

describe("ClientSettings proactive panels", () => {
  it("is opt-in and accepts client-local updates", () => {
    expect(decodeClientSettings({}).proactivePanelsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({ proactivePanelsEnabled: true }).proactivePanelsEnabled).toBe(
      true,
    );
  });
});

describe("ClientSettings quit confirmation", () => {
  it("defaults to hold", () => {
    expect(decodeClientSettings({}).confirmQuit).toBe("hold");
  });

  it.each(["direct", "hold", "double-click"] as const)("accepts the %s mode", (mode) => {
    expect(decodeClientSettings({ confirmQuit: mode }).confirmQuit).toBe(mode);
    expect(decodeClientSettingsPatch({ confirmQuit: mode }).confirmQuit).toBe(mode);
  });

  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });

  it("rejects legacy booleans at the patch boundary", () => {
    expect(() => decodeClientSettingsPatch({ confirmQuit: true })).toThrow();
  });
});

describe("ClientSettings browser recording frame rate", () => {
  it("defaults to 30 fps", () => {
    expect(decodeClientSettings({}).browserRecordingFrameRate).toBe(30);
  });

  it.each([30, 60])("accepts a supported frame rate: %s", (frameRate) => {
    expect(
      decodeClientSettings({ browserRecordingFrameRate: frameRate }).browserRecordingFrameRate,
    ).toBe(frameRate);
    expect(
      decodeClientSettingsPatch({ browserRecordingFrameRate: frameRate }).browserRecordingFrameRate,
    ).toBe(frameRate);
  });

  it.each([24, 59, 120])("rejects an unsupported frame rate: %s", (frameRate) => {
    expect(() => decodeClientSettings({ browserRecordingFrameRate: frameRate })).toThrow();
    expect(() => decodeClientSettingsPatch({ browserRecordingFrameRate: frameRate })).toThrow();
  });
});

describe("ClientSettings glass opacity", () => {
  it("defaults to a readable translucent surface", () => {
    expect(decodeClientSettings({}).glassOpacity).toBe(80);
  });

  it.each([39, 101, 72.5])("rejects an invalid glass opacity: %s", (value) => {
    expect(() => decodeClientSettings({ glassOpacity: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ glassOpacity: value })).toThrow();
  });

  it.each([40, 75, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings appearance contrast", () => {
  it("defaults to the theme's original contrast", () => {
    expect(decodeClientSettings({}).appearanceContrast).toBe(100);
  });

  it.each([49, 201, 92.5])("rejects an invalid appearance contrast: %s", (value) => {
    expect(() => decodeClientSettings({ appearanceContrast: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ appearanceContrast: value })).toThrow();
  });

  it.each([50, 100, 150, 200])("accepts an appearance contrast in range: %s", (value) => {
    expect(decodeClientSettings({ appearanceContrast: value }).appearanceContrast).toBe(value);
    expect(decodeClientSettingsPatch({ appearanceContrast: value }).appearanceContrast).toBe(value);
  });
});

describe("ClientSettings panel animations", () => {
  it("defaults to instant changes", () => {
    expect(decodeClientSettings({}).panelAnimationDurationMs).toBe(0);
  });

  it.each([0, 400])("accepts a panel animation duration: %s", (value) => {
    expect(decodeClientSettingsPatch({ panelAnimationDurationMs: value })).toEqual({
      panelAnimationDurationMs: value,
    });
  });

  it.each([-1, 401, 150.5])("rejects an invalid panel animation duration: %s", (value) => {
    expect(() => decodeClientSettingsPatch({ panelAnimationDurationMs: value })).toThrow();
  });
});

describe("ClientSettings environment identification", () => {
  it("defaults to artwork and accepts each presentation mode", () => {
    expect(decodeClientSettings({}).environmentIdentificationMode).toBe("artwork");

    for (const mode of ["artwork", "pill", "none"] as const) {
      expect(
        decodeClientSettingsPatch({ environmentIdentificationMode: mode })
          .environmentIdentificationMode,
      ).toBe(mode);
    }
  });

  it("rejects unsupported presentation modes", () => {
    expect(() => decodeClientSettings({ environmentIdentificationMode: "badge" })).toThrow();
    expect(() => decodeClientSettingsPatch({ environmentIdentificationMode: "badge" })).toThrow();
  });
});

describe("ClientSettings sidebar", () => {
  it("defaults to the current sidebar", () => {
    const settings = decodeClientSettings({});
    expect(settings.legacySidebarEnabled).toBe(false);
    expect(settings.sidebarV2CompactCards).toBe(false);
    expect(settings.sidebarV2SortActiveByLatestUserMessage).toBe(false);
    expect(settings.sidebarV2NewThreadButtonInProjectRow).toBe(false);
  });

  it("accepts opting into the project-row new-thread button", () => {
    expect(
      decodeClientSettingsPatch({
        sidebarV2NewThreadButtonInProjectRow: true,
      }).sidebarV2NewThreadButtonInProjectRow,
    ).toBe(true);
  });

  it("accepts opting into latest-user-message ordering", () => {
    expect(
      decodeClientSettingsPatch({
        sidebarV2SortActiveByLatestUserMessage: true,
      }).sidebarV2SortActiveByLatestUserMessage,
    ).toBe(true);
  });

  it("drops the retired sidebar v2 beta keys, resetting everyone to the default", () => {
    const decoded = decodeClientSettings({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(decoded.legacySidebarEnabled).toBe(false);
    expect(decoded).not.toHaveProperty("sidebarV2Enabled");
    expect(decoded).not.toHaveProperty("sidebarV2ConfiguredByUser");
  });

  it("preserves an explicit legacy sidebar opt-in", () => {
    expect(decodeClientSettings({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(true);
    expect(decodeClientSettingsPatch({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(
      true,
    );
  });

  it("keeps unpin confirmation opt-in and patchable", () => {
    expect(decodeClientSettings({}).confirmThreadUnpin).toBe(false);
    expect(decodeClientSettingsPatch({ confirmThreadUnpin: true }).confirmThreadUnpin).toBe(true);
    expect(() => decodeClientSettingsPatch({ confirmThreadUnpin: "yes" })).toThrow();
  });
});

describe("ClientSettings context window meter", () => {
  it("defaults off and preserves an explicit legacy opt-in", () => {
    expect(decodeClientSettings({}).contextWindowMeterEnabled).toBe(false);
    expect(
      decodeClientSettings({ contextWindowMeterEnabled: true }).contextWindowMeterEnabled,
    ).toBe(true);
    expect(
      decodeClientSettingsPatch({ contextWindowMeterEnabled: true }).contextWindowMeterEnabled,
    ).toBe(true);
  });
});

describe("ClientSettings composer collapse", () => {
  it("collapses on blur and scroll by default and accepts opting out of each", () => {
    const defaults = decodeClientSettings({});
    expect(defaults.composerCollapseOnBlur).toBe(true);
    expect(defaults.composerCollapseOnScroll).toBe(true);

    const blurOff = decodeClientSettings({ composerCollapseOnBlur: false });
    expect(blurOff.composerCollapseOnBlur).toBe(false);
    expect(blurOff.composerCollapseOnScroll).toBe(true);

    expect(
      decodeClientSettingsPatch({ composerCollapseOnScroll: false }).composerCollapseOnScroll,
    ).toBe(false);
  });
});

describe("ServerSettings thread settlement", () => {
  it("defaults merge settlement on and inactivity settlement to three days", () => {
    const settings = decodeServerSettings({});
    expect(settings.threadAutoSettleEnabled).toBe(true);
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
    expect(settings.sidebarAutoSettleOnMerge).toBe(true);
  });

  it("accepts turning the master auto-settle gate off", () => {
    expect(decodeServerSettings({ threadAutoSettleEnabled: false }).threadAutoSettleEnabled).toBe(
      false,
    );
    expect(
      decodeServerSettingsPatch({ threadAutoSettleEnabled: false }).threadAutoSettleEnabled,
    ).toBe(false);
  });

  it("allows both automatic rules to be disabled", () => {
    expect(
      decodeServerSettings({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
      }),
    ).toMatchObject({ sidebarAutoSettleAfterDays: null, sidebarAutoSettleOnMerge: false });
    expect(
      decodeServerSettingsPatch({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
      }),
    ).toMatchObject({ sidebarAutoSettleAfterDays: null, sidebarAutoSettleOnMerge: false });
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeServerSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeServerSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
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

describe("ClientSettings extras", () => {
  it("keeps prior behaviour by default", () => {
    const settings = decodeClientSettings({});
    expect(settings.steerGraceWindowMs).toBe(5_000);
    expect(settings.providerUsageWarningPercent).toBe(80);
    expect(settings.providerUsageCriticalPercent).toBe(95);
    expect(settings.maskProviderUsageEmails).toBe(false);
    expect(settings.accentTintsEnabled).toBe(true);
    expect(settings.accentTintIntensityPercent).toBe(12);
    expect(settings.sidebarAlwaysShowPinnedInAttention).toBe(false);
    expect(settings.turnCompletionMinDurationSeconds).toBe(0);
  });

  it("accepts in-range values in patches", () => {
    expect(
      decodeClientSettingsPatch({
        steerGraceWindowMs: 0,
        providerUsageWarningPercent: 1,
        providerUsageCriticalPercent: 100,
        maskProviderUsageEmails: true,
        accentTintsEnabled: false,
        accentTintIntensityPercent: 30,
        sidebarAlwaysShowPinnedInAttention: true,
        turnCompletionMinDurationSeconds: 3_600,
      }),
    ).toEqual({
      steerGraceWindowMs: 0,
      providerUsageWarningPercent: 1,
      providerUsageCriticalPercent: 100,
      maskProviderUsageEmails: true,
      accentTintsEnabled: false,
      accentTintIntensityPercent: 30,
      sidebarAlwaysShowPinnedInAttention: true,
      turnCompletionMinDurationSeconds: 3_600,
    });
  });

  it.each([
    { steerGraceWindowMs: 15_001 },
    { steerGraceWindowMs: -1 },
    { providerUsageWarningPercent: 0 },
    { providerUsageCriticalPercent: 101 },
    { accentTintIntensityPercent: 3 },
    { accentTintIntensityPercent: 31 },
    { turnCompletionMinDurationSeconds: -1 },
    { turnCompletionMinDurationSeconds: 3_601 },
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
    expect(clampTurnCompletionMinDurationSeconds(-5)).toBe(0);
    expect(clampTurnCompletionMinDurationSeconds(10_000)).toBe(3_600);
  });
});

describe("ServerSettings.voice", () => {
  it("defaults to unset, so the server keeps its env/default resolution", () => {
    expect(DEFAULT_SERVER_SETTINGS.voice).toEqual({
      ttsModelId: "",
      ttsVoiceId: "",
      enableAgentVoiceReplies: true,
    });
    expect(decodeServerSettings({}).voice).toEqual({
      ttsModelId: "",
      ttsVoiceId: "",
      enableAgentVoiceReplies: true,
    });
  });

  it("trims values in both the settings and the patch", () => {
    expect(decodeServerSettings({ voice: { ttsModelId: "  eleven_v3  " } }).voice).toEqual({
      ttsModelId: "eleven_v3",
      ttsVoiceId: "",
      enableAgentVoiceReplies: true,
    });
    expect(decodeServerSettingsPatch({ voice: { ttsVoiceId: "  abc  " } })).toEqual({
      voice: { ttsVoiceId: "abc" },
    });
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

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults text generation to Luna at low reasoning effort", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });

  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("HermesSettings", () => {
  it("defaults to a disabled machine-local Hermes ACP configuration", () => {
    expect(decodeHermesSettings({})).toEqual({
      enabled: false,
      binaryPath: "hermes",
      requireGateway: false,
      customModels: [],
    });
    expect(decodeServerSettings({}).providers.hermes).toEqual(decodeHermesSettings({}));
  });

  it("round-trips Hermes provider patches", () => {
    expect(
      decodeServerSettingsPatch({
        providers: {
          hermes: {
            enabled: true,
            binaryPath: "  /opt/homebrew/bin/hermes  ",
            authMethodId: "  openai-codex  ",
            requireGateway: false,
            customModels: ["openai-codex:gpt-5.6-sol"],
          },
        },
      }).providers?.hermes,
    ).toEqual({
      enabled: true,
      binaryPath: "/opt/homebrew/bin/hermes",
      authMethodId: "openai-codex",
      requireGateway: false,
      customModels: ["openai-codex:gpt-5.6-sol"],
    });
  });
});

describe("provider enabled defaults", () => {
  it("enables only the stable bindings by default", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providers.codex.enabled).toBe(true);
    expect(decoded.providers.claudeAgent.enabled).toBe(true);
    expect(decoded.providers.cursor.enabled).toBe(false);
    expect(decoded.providers.grok.enabled).toBe(false);
    expect(decoded.providers.opencode.enabled).toBe(false);
  });

  it("derives per-driver defaults from the settings schemas", () => {
    expect(defaultEnabledForDriver(ProviderDriverKind.make("codex"))).toBe(true);
    expect(defaultEnabledForDriver(ProviderDriverKind.make("cursor"))).toBe(false);
    expect(defaultEnabledForDriver(ProviderDriverKind.make("grok"))).toBe(false);
    // Unknown fork drivers stay enabled; their own build decides otherwise.
    expect(defaultEnabledForDriver(ProviderDriverKind.make("ollama"))).toBe(true);
    // Hermes is a fork driver the settings schema DOES know, so it takes its
    // own disabled-by-default value rather than the unknown-driver fallback.
    expect(defaultEnabledForDriver(ProviderDriverKind.make("hermes"))).toBe(false);
  });

  it("keeps Cursor enabled when an existing user explicitly opted in", () => {
    const cursor = ProviderDriverKind.make("cursor");
    const cursorId = ProviderInstanceId.make("cursor");
    const decoded = decodeServerSettings({
      providers: { cursor: { enabled: true } },
      providerInstances: {
        [cursorId]: { driver: cursor, enabled: true, config: {} },
      },
    });

    expect(decoded.providers.cursor.enabled).toBe(true);
    expect(resolveProviderInstanceEnabled(decoded.providerInstances[cursorId]!)).toBe(true);
  });

  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    // No flags anywhere: driver default applies.
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    // Envelope flag wins over the driver default.
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    // Legacy in-config flag fills in when the envelope is silent.
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    // Conflicting flags: the explicit false wins, whichever side it is on.
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin on for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it("defaults all style settings for legacy configs", () => {
    const settings = decodeServerSettings({});

    expect(settings.sourceControlWritingStyle).toEqual({
      mode: "repo_conventions",
      customInstructions: "",
      followChangeRequestTemplates: true,
    });
    expect(settings.sourceControlWriterModelSelection).toBeNull();
  });

  it("trims partial style updates", () => {
    const patch = decodeServerSettingsPatch({
      sourceControlWritingStyle: {
        mode: "custom",
        customInstructions: "  Prefer concise wording.  ",
      },
    });

    expect(patch.sourceControlWritingStyle).toEqual({
      mode: "custom",
      customInstructions: "Prefer concise wording.",
    });
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ServerSettingsPatch string normalization", () => {
  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
          launchArgs: "  --strict-config --enable foo  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providers?.codex?.launchArgs).toBe("--strict-config --enable foo");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
          launchArgs: "  --strict-config  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(encoded.providers?.codex?.launchArgs).toBe("--strict-config");
  });
});

describe("ServerSettings environment icon", () => {
  it("defaults to null", () => {
    expect(decodeServerSettings({}).environmentIcon).toBeNull();
  });

  it("keeps a kind this build knows", () => {
    expect(decodeServerSettings({ environmentIcon: "mac-mini" }).environmentIcon).toBe("mac-mini");
  });

  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });

  it("round-trips through encode", () => {
    const settings = decodeServerSettings({ environmentIcon: "laptop" });
    expect(encodeServerSettings(settings).environmentIcon).toBe("laptop");
  });
});
