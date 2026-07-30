/**
 * Project accent tints for native rows.
 *
 * Web overlays the accent on a sidebar row as a flat ~12% tint over whatever
 * background the row already has (`color-mix` in CSS). React Native has no
 * color-mix, so the same effect is an absolutely-positioned overlay filled
 * with the accent at the equivalent alpha — the row keeps its own opaque
 * background, pressed/selected states still read, and the tint composites on
 * top exactly as it does on web.
 */
import {
  clampAccentTintIntensityPercent,
  DEFAULT_ACCENT_TINT_INTENSITY_PERCENT,
} from "@t3tools/contracts/settings";

export interface AccentTintAlphas {
  /** Tint of an active row. */
  readonly alpha: number;
  /** Settled rows recede, so their tint is halved rather than dropped. */
  readonly recededAlpha: number;
}

/**
 * The device's tint intensity as row alphas. The percentage is the same knob
 * web exposes in Settings → Extras, clamped here because the stored preference
 * is rehydrated by JSON parsing rather than by decoding a schema.
 */
export function resolveAccentTintAlphas(intensityPercent: number | undefined): AccentTintAlphas {
  const alpha =
    clampAccentTintIntensityPercent(intensityPercent ?? DEFAULT_ACCENT_TINT_INTENSITY_PERCENT) /
    100;
  return { alpha, recededAlpha: alpha / 2 };
}

/** Matches web's default 12% row tint. */
export const DEFAULT_ACCENT_TINT_ALPHAS = resolveAccentTintAlphas(undefined);

/**
 * The alpha a row paints its accent wash at, or null when it paints none.
 *
 * The tint opt-out is gated here, at the wash, rather than at accent
 * resolution: switching tints off must not un-color the group-header dot, which
 * is the only thing still naming the project. Web draws the same line — its
 * per-row tint map is what empties, while the dot resolves the accent
 * unconditionally.
 */
export function resolveRowAccentTintAlpha(input: {
  readonly enabled: boolean;
  readonly alphas: AccentTintAlphas;
  readonly receded: boolean;
}): number | null {
  if (!input.enabled) return null;
  return input.receded ? input.alphas.recededAlpha : input.alphas.alpha;
}

/** `#rrggbb`, the only shape the settings schema validates accent colors as. */
export function isAccentColor(color: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(color);
}

/**
 * `#rrggbb` plus an alpha channel. Anything that is not six-digit hex is
 * passed through untouched so a value from a newer server can never blank a
 * row.
 */
export function withAccentAlpha(color: string, alpha: number): string {
  if (!isAccentColor(color)) return color;
  const alphaByte = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${color}${alphaByte}`;
}
