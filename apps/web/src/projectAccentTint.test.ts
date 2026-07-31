import {
  DEFAULT_ACCENT_TINT_INTENSITY_PERCENT,
  SidebarProjectAccentColor,
} from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { projectAccentTintStyle } from "./projectAccentTint";

describe("projectAccentTintStyle", () => {
  it("overlays the configured project color at the configured intensity", () => {
    expect(
      projectAccentTintStyle(
        SidebarProjectAccentColor.make("#0055aa"),
        DEFAULT_ACCENT_TINT_INTENSITY_PERCENT,
      ),
    ).toEqual({
      backgroundImage:
        "linear-gradient(color-mix(in srgb, #0055aa 12%, transparent), color-mix(in srgb, #0055aa 12%, transparent))",
    });
  });

  it("leaves surfaces without a project accent unchanged", () => {
    expect(projectAccentTintStyle(null, DEFAULT_ACCENT_TINT_INTENSITY_PERCENT)).toBeUndefined();
  });
});
