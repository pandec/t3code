import { describe, expect, it } from "vite-plus/test";

import { MOBILE_THEME_IDS } from "../../lib/mobileTheme";
import { getMobileThemeRuntimeVariables } from "../../lib/mobileThemeVariables";
import { listeningPlayerChrome } from "./listeningPlayerChrome";

/**
 * The listening player's chrome is derived from `--color-foreground` rather
 * than taken from the surface ramp, because the card it sits on is itself
 * `--color-subtle`. The ramp's neighbouring tier (`--color-subtle-strong`)
 * collapses to 1.02 against that card on several built-in palettes, which
 * renders the track and the press feedback invisible.
 *
 * These floors run against the real `listeningPlayerChrome` output, so they
 * fail both when a palette regresses and when the derivation itself is retuned
 * past the point of visibility.
 */

type RGB = readonly [number, number, number];

function parseColor(color: string): { readonly rgb: RGB; readonly alpha: number } | null {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  if (hex) {
    return {
      rgb: [
        Number.parseInt(hex[1]!, 16),
        Number.parseInt(hex[2]!, 16),
        Number.parseInt(hex[3]!, 16),
      ],
      alpha: 1,
    };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
    color,
  );
  return rgba
    ? {
        rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
        alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
      }
    : null;
}

/** Flatten `overlay` onto an already-opaque `base`. */
function compositeOver(overlay: string, base: RGB): RGB {
  const parsed = parseColor(overlay);
  if (parsed === null) throw new Error(`unparseable colour: ${overlay}`);
  return [0, 1, 2].map((channel) =>
    Math.round(parsed.rgb[channel]! * parsed.alpha + base[channel]! * (1 - parsed.alpha)),
  ) as unknown as RGB;
}

function relativeLuminance(color: RGB): number {
  const [red, green, blue] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(first: RGB, second: RGB): number {
  const [a, b] = [relativeLuminance(first), relativeLuminance(second)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const APPEARANCES = ["light", "dark"] as const;

/** The listening card: `bg-subtle` laid over the screen. */
function cardColor(variables: Record<string, string>): RGB {
  const screen = parseColor(variables["--color-screen"]!);
  if (screen === null) throw new Error("screen colour is unparseable");
  return compositeOver(variables["--color-subtle"]!, screen.rgb);
}

describe("listening player chrome contrast", () => {
  // Measured floors sit just under the worst real pair, so a palette that
  // regresses toward the ramp trips them while normal retuning does not.
  for (const [label, part, floor] of [
    ["scrubber track", "trackColor", 1.3],
    ["speed pill outline", "outlineColor", 1.4],
  ] as const) {
    it(`keeps the ${label} visible on its card in every theme`, () => {
      for (const themeId of MOBILE_THEME_IDS) {
        for (const appearance of APPEARANCES) {
          const variables = getMobileThemeRuntimeVariables(themeId, appearance) as Record<
            string,
            string
          >;
          const card = cardColor(variables);
          const chrome = listeningPlayerChrome(variables["--color-foreground"]!)[part];
          expect(
            contrastRatio(compositeOver(chrome, card), card),
            `${label} on ${themeId}/${appearance}`,
          ).toBeGreaterThan(floor);
        }
      }
    });
  }

  it("beats the surface-ramp tier it replaced on every theme", () => {
    for (const themeId of MOBILE_THEME_IDS) {
      for (const appearance of APPEARANCES) {
        const variables = getMobileThemeRuntimeVariables(themeId, appearance) as Record<
          string,
          string
        >;
        const card = cardColor(variables);
        const ramp = contrastRatio(compositeOver(variables["--color-subtle-strong"]!, card), card);
        const derived = contrastRatio(
          compositeOver(listeningPlayerChrome(variables["--color-foreground"]!).trackColor, card),
          card,
        );
        expect(derived, `${themeId}/${appearance}`).toBeGreaterThan(ramp);
      }
    }
  });
});
