import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import {
  archivedThreadMatchesSearch,
  backgroundActivitySharedPolicySettings,
  buildCodexSetupModeInstance,
  getChangedBrowserSettingLabels,
  getChangedTypographySettingLabels,
  hasChangedBackgroundActivitySettings,
} from "./SettingsPanels.logic";

describe("archivedThreadMatchesSearch", () => {
  const candidate = {
    environmentLabel: "Grey Mac",
    modelName: "gpt-5.4",
    projectName: "T3 Code",
    projectCwd: "/Users/example/repos/t3code",
    threadTitle: "Add archived thread search",
  };

  it("matches case-insensitive terms across thread and project metadata", () => {
    expect(archivedThreadMatchesSearch(candidate, "ARCHIVED t3")).toBe(true);
    expect(archivedThreadMatchesSearch(candidate, "example search")).toBe(true);
    expect(archivedThreadMatchesSearch(candidate, "grey 5.4")).toBe(true);
  });

  it("requires every search term to match", () => {
    expect(archivedThreadMatchesSearch(candidate, "archived missing")).toBe(false);
  });

  it("treats blank queries as unfiltered", () => {
    expect(archivedThreadMatchesSearch(candidate, "   ")).toBe(true);
  });
});

describe("typography settings restore", () => {
  it("detects family and size changes by font row", () => {
    expect(getChangedTypographySettingLabels(DEFAULT_UNIFIED_SETTINGS)).toEqual([]);
    expect(
      getChangedTypographySettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        fontSizeInterface: 18,
        fontFamilyCode: "Fira Code",
      }),
    ).toEqual(["Interface font", "Code font"]);
    expect(
      getChangedTypographySettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        fontSizeMessage: 16,
      }),
    ).toEqual(["Message font"]);
  });
});

describe("background activity settings restore", () => {
  it("detects legacy interval values even when the structured setting is at its default", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      }),
    ).toBe(true);
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe(true);
    expect(hasChangedBackgroundActivitySettings(DEFAULT_UNIFIED_SETTINGS)).toBe(false);
  });

  it("preserves advanced overrides when the shared policy changes", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          backgroundActivity: {
            schemaVersion: 1,
            profile: "custom",
            baseProfile: "balanced",
            overrides: {
              automaticGitFetchInterval,
              pauseWhenOnBattery: true,
            },
          },
        },
        "performance",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval,
        pauseWhenOnBattery: true,
      },
    });
  });

  it("materializes legacy advanced overrides before changing the shared policy", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          automaticGitFetchInterval,
        },
        "battery-saver",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval,
      },
    });
  });
});

describe("buildCodexSetupModeInstance", () => {
  it("builds the mode switch on the pending instance so an unacknowledged write survives", () => {
    const instanceId = ProviderInstanceId.make("codex");
    // The row still shows the acknowledged instance; the overlay holds a
    // binary path written moments ago that the server has not echoed yet.
    const acknowledged = {
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
      config: { setupMode: "existing" },
    } satisfies ProviderInstanceConfig;
    const pending = new Map<ProviderInstanceId, ProviderInstanceConfig>([
      [
        instanceId,
        {
          ...acknowledged,
          config: { ...acknowledged.config, binaryPath: "/opt/t3/codex" },
        },
      ],
    ]);

    const next = buildCodexSetupModeInstance(pending.get(instanceId) ?? acknowledged, "managed");

    expect(next).toEqual({
      driver: "codex",
      enabled: true,
      config: { setupMode: "managed", binaryPath: "/opt/t3/codex", enabled: true },
    });
  });

  it("starts from an empty config when the instance has none", () => {
    const next = buildCodexSetupModeInstance(
      { driver: ProviderDriverKind.make("codex"), enabled: true, config: null },
      "existing",
    );

    expect(next.config).toEqual({ enabled: true, setupMode: "existing" });
  });
});

describe("getChangedBrowserSettingLabels", () => {
  it("counts a retained custom search URL so restore clears it", () => {
    expect(
      getChangedBrowserSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        browserCustomSearchUrl: "https://search.example/?q=%s",
      }),
    ).toEqual(["Search engine"]);
  });
});
