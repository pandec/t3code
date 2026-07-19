import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarStageBackdropVariant } from "./SidebarStageBackdrop";

describe("resolveSidebarStageBackdropVariant", () => {
  it("shows Dev artwork only for a development web bundle", () => {
    expect(resolveSidebarStageBackdropVariant("Dev", true)).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Dev", false)).toBeNull();
  });

  it("keeps Nightly artwork in packaged builds", () => {
    expect(resolveSidebarStageBackdropVariant("Nightly", false)).toBe("nightly");
  });
});
