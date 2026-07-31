import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  clampAccentTintIntensityPercent,
  clampProviderUsageAlertPercent,
  clampSteerGraceWindowMs,
  clampTurnCompletionMinDurationSeconds,
  ClientSettingsSchema,
  ClientSettingsPatch,
  DEFAULT_SERVER_SETTINGS,
  HermesSettings,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeHermesSettings = Schema.decodeUnknownSync(HermesSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

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

describe("ClientSettings sidebar v2", () => {
  it("defaults the beta off with a three-day auto-settle threshold", () => {
    const settings = decodeClientSettings({});
    expect(settings.sidebarV2Enabled).toBe(false);
    expect(settings.sidebarV2CompactCards).toBe(false);
    expect(settings.sidebarV2NewThreadButtonInProjectRow).toBe(false);
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
  });

  it("accepts opting into the project-row new-thread button", () => {
    expect(
      decodeClientSettingsPatch({
        sidebarV2NewThreadButtonInProjectRow: true,
      }).sidebarV2NewThreadButtonInProjectRow,
    ).toBe(true);
  });

  it("treats settings written before the beta had a per-channel default as unconfigured", () => {
    // The stored blob always carries `sidebarV2Enabled`, so only the companion
    // flag can distinguish "user opted out" from "never touched it".
    expect(decodeClientSettings({ sidebarV2Enabled: false }).sidebarV2ConfiguredByUser).toBe(false);
    expect(decodeClientSettings({ sidebarV2Enabled: true }).sidebarV2ConfiguredByUser).toBe(false);
  });

  it("preserves an explicit beta choice", () => {
    const settings = decodeClientSettings({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(settings.sidebarV2Enabled).toBe(false);
    expect(settings.sidebarV2ConfiguredByUser).toBe(true);
  });

  it("carries an explicit beta opt-out through the patch the beta toggle writes", () => {
    const patch = decodeClientSettingsPatch({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(patch.sidebarV2Enabled).toBe(false);
    expect(patch.sidebarV2ConfiguredByUser).toBe(true);
  });

  it("allows auto-settle by inactivity to be disabled", () => {
    expect(
      decodeClientSettings({ sidebarAutoSettleAfterDays: null }).sidebarAutoSettleAfterDays,
    ).toBeNull();
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeClientSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
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
        turnCompletionMinDurationSeconds: 3_600,
      }),
    ).toEqual({
      steerGraceWindowMs: 0,
      providerUsageWarningPercent: 1,
      providerUsageCriticalPercent: 100,
      maskProviderUsageEmails: true,
      accentTintsEnabled: false,
      accentTintIntensityPercent: 30,
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
    expect(DEFAULT_SERVER_SETTINGS.voice).toEqual({ ttsModelId: "", ttsVoiceId: "" });
    expect(decodeServerSettings({}).voice).toEqual({ ttsModelId: "", ttsVoiceId: "" });
  });

  it("trims values in both the settings and the patch", () => {
    expect(decodeServerSettings({ voice: { ttsModelId: "  eleven_v3  " } }).voice).toEqual({
      ttsModelId: "eleven_v3",
      ttsVoiceId: "",
    });
    expect(decodeServerSettingsPatch({ voice: { ttsVoiceId: "  abc  " } })).toEqual({
      voice: { ttsVoiceId: "abc" },
    });
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
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
