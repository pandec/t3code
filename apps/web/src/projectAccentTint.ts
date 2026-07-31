import type {
  AccentTintIntensityPercent,
  SidebarProjectAccentColor,
} from "@t3tools/contracts/settings";
import type { CSSProperties } from "react";

/**
 * Washes a project accent over an existing surface without replacing its
 * hover, active, or selected background color.
 */
export function projectAccentTintStyle(
  color: SidebarProjectAccentColor | null | undefined,
  intensityPercent: AccentTintIntensityPercent,
): CSSProperties | undefined {
  if (color == null) return undefined;

  return {
    backgroundImage: `linear-gradient(color-mix(in srgb, ${color} ${intensityPercent}%, transparent), color-mix(in srgb, ${color} ${intensityPercent}%, transparent))`,
  };
}
