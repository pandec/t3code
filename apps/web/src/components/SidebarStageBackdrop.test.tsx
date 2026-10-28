import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarStageBackdropVariant } from "./SidebarStageBackdrop";

describe("resolveSidebarStageBackdropVariant", () => {
  it("shows Dev artwork only in development builds", () => {
    expect(resolveSidebarStageBackdropVariant("Dev", "artwork", true)).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Dev", "artwork", false)).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Nightly", "artwork", false)).toBe("nightly");
    expect(resolveSidebarStageBackdropVariant("Nightly", "none", false)).toBeNull();
  });
});
