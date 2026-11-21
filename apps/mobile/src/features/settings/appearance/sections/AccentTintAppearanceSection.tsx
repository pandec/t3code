import {
  MAX_ACCENT_TINT_INTENSITY_PERCENT,
  MIN_ACCENT_TINT_INTENSITY_PERCENT,
} from "@t3tools/contracts/settings";
import { View } from "react-native";

import { AppText as Text } from "../../../../components/ui/AppText";
import { saveMobilePreferences } from "../../../../state/preferences";
import { useAtomCommand } from "../../../../state/use-atom-command";
import {
  useAccentTintSettings,
  useMobilePreferencesHydrated,
} from "../../../../state/use-mobile-preferences";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSliderRow } from "../../components/SettingsSliderRow";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import {
  ACCENT_TINT_INTENSITY_STEP_PERCENT,
  formatAccentTintIntensityPercent,
  toStoredAccentTintIntensityPercent,
} from "../../lib/extras-settings";

/**
 * The device's project-accent tinting, mirroring web's Settings → Extras →
 * Accent tints. Mobile cannot pick the colors — they are server settings — so
 * the footer says where they come from instead of offering a picker.
 */
export function AccentTintAppearanceSection() {
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const hydrated = useMobilePreferencesHydrated();
  const { enabled, intensityPercent } = useAccentTintSettings();

  return (
    <View className="gap-3">
      <SettingsSection title="Accent tints">
        <SettingsSwitchRow
          disabled={!hydrated}
          icon="paintbrush"
          label="Project accent tints"
          onValueChange={(value) => {
            void savePreferences({ accentTintsEnabled: value });
          }}
          value={enabled}
        />
        <SettingsSliderRow
          disabled={!hydrated || !enabled}
          icon="slider.horizontal.3"
          label="Tint intensity"
          max={MAX_ACCENT_TINT_INTENSITY_PERCENT}
          min={MIN_ACCENT_TINT_INTENSITY_PERCENT}
          onChange={(value) => {
            void savePreferences({
              accentTintIntensityPercent: toStoredAccentTintIntensityPercent(value),
            });
          }}
          step={ACCENT_TINT_INTENSITY_STEP_PERCENT}
          value={intensityPercent}
          valueLabel={formatAccentTintIntensityPercent(intensityPercent)}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Washes a project's accent color over its thread rows. Off keeps the color as a dot on the
        project header. The colors themselves are set per project from the desktop app.
      </Text>
    </View>
  );
}
