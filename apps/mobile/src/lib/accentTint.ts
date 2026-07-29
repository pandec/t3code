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

/** Matches web's 12% row tint. */
export const ACCENT_TINT_ALPHA = 0.12;
/** Settled rows recede, so their tint is halved rather than dropped. */
export const ACCENT_TINT_ALPHA_RECEDED = 0.06;

/**
 * `#rrggbb` plus an alpha channel. Accent colors are validated as six-digit
 * hex by the settings schema; anything else is passed through untouched so a
 * value from a newer server can never blank a row.
 */
export function withAccentAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const alphaByte = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${color}${alphaByte}`;
}
