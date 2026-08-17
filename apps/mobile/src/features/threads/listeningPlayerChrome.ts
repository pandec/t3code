import { themeColorWithAlpha } from "../../lib/mobileTheme";

/**
 * Neutral chrome for the listening player — scrubber track, speed-pill
 * outline, and press fills.
 *
 * These are derived from `--color-foreground` rather than taken from the
 * surface ramp because the card they sit on is itself `--color-subtle`. The
 * ramp's neighbouring tier lands within 1.03 of that card on several built-in
 * palettes, which leaves the track and the press feedback invisible. The text
 * colour is the one value every theme guarantees to contrast against its own
 * surfaces.
 *
 * Press states use the `active:bg-foreground/10` class instead of a value from
 * here: uniwind merges a `style` prop alongside `className` as
 * `[classNameStyles, style]`, so a function-form `style` would end up inside a
 * style array where React Native never calls it.
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
