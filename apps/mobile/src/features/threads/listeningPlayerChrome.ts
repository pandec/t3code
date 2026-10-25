import { themeColorWithAlpha } from "../../lib/mobileTheme";

/**
 * Derived from `--color-foreground`, not the surface ramp: the card is `--color-subtle`, and the
 * ramp's neighbouring tier is near-invisible against it on several palettes. Press states use
 * `active:bg-foreground/10` because uniwind merges `style` into an array, where React Native
 * never calls a function-form style.
 */
export const LISTENING_CHROME_ALPHA = {
  track: 0.18,
  outline: 0.22,
} as const;

export function listeningPlayerChrome(foregroundColor: string) {
  return {
    trackColor: themeColorWithAlpha(foregroundColor, LISTENING_CHROME_ALPHA.track),
    outlineColor: themeColorWithAlpha(foregroundColor, LISTENING_CHROME_ALPHA.outline),
  };
}
