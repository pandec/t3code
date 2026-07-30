import {
  BASE_FONT_SIZE_STEP,
  MAX_BASE_FONT_SIZE,
  MIN_BASE_FONT_SIZE,
} from "../../../../lib/appearancePreferences";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSliderRow } from "../../components/SettingsSliderRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import {
  AppearancePreviewSeparator,
  TextAppearancePreview,
} from "../components/AppearancePreviews";

export function TextAppearanceSection() {
  const { isReady, appearance, setBaseFontSize } = useAppearancePreferences();

  return (
    <SettingsSection card title="Text">
      <TextAppearancePreview fontSize={appearance.baseFontSize} />
      <AppearancePreviewSeparator />
      <SettingsSliderRow
        disabled={!isReady}
        icon="textformat.size"
        label="Text size"
        max={MAX_BASE_FONT_SIZE}
        maxIcon="textformat.size.larger"
        min={MIN_BASE_FONT_SIZE}
        minIcon="textformat.size.smaller"
        onChange={setBaseFontSize}
        step={BASE_FONT_SIZE_STEP}
        value={appearance.baseFontSize}
        valueLabel={`${appearance.baseFontSize} pt`}
      />
    </SettingsSection>
  );
}
