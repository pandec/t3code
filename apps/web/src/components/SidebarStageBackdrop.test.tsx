import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarStageBackdropVariant } from "./SidebarStageBackdrop";

describe("resolveSidebarStageBackdropVariant", () => {
  it("shows Dev artwork only in development builds", () => {
    expect(
      resolveSidebarStageBackdropVariant("Dev", { enabled: true, isDevelopmentBuild: true }),
    ).toBe("dev");
    expect(
      resolveSidebarStageBackdropVariant("Dev", { enabled: true, isDevelopmentBuild: false }),
    ).toBeNull();
    expect(
      resolveSidebarStageBackdropVariant("Nightly", { enabled: true, isDevelopmentBuild: false }),
    ).toBe("nightly");
    expect(
      resolveSidebarStageBackdropVariant("Nightly", { enabled: false, isDevelopmentBuild: false }),
    ).toBeNull();
  });
});
