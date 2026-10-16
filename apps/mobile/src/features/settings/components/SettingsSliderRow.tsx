import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { SliderRow, type SliderRowProps } from "../../../components/ui/SliderRow";

/** The shared slider row plus an optional caption for a value that needs explaining. */
export function SettingsSliderRow({
  description,
  ...props
}: SliderRowProps & { readonly description?: string }) {
  if (description === undefined) return <SliderRow {...props} />;
  return (
    <View>
      <SliderRow {...props} />
      {/* Pulled up into the row's bottom padding so it reads as part of the row. */}
      <Text
        className={
          props.disabled
            ? "-mt-3 px-4 pb-4 text-sm text-foreground-muted opacity-[0.45]"
            : "-mt-3 px-4 pb-4 text-sm text-foreground-muted"
        }
      >
        {description}
      </Text>
    </View>
  );
}
