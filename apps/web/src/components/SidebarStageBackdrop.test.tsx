import { describe, expect, it } from "vite-plus/test";

import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it("resolves stage artwork only when enabled and eligible for the build", () => {
    expect(
      resolveSidebarStageBackdropVariant("Dev", {
        enabled: true,
        isDevelopmentBuild: true,
      }),
    ).toBe("dev");
    expect(
      resolveSidebarStageBackdropVariant("Dev", {
        enabled: true,
        isDevelopmentBuild: false,
      }),
    ).toBeNull();
    expect(
      resolveSidebarStageBackdropVariant("Nightly", {
        enabled: true,
        isDevelopmentBuild: false,
      }),
    ).toBe("nightly");
    expect(
      resolveSidebarStageBackdropVariant("Dev", {
        enabled: false,
        isDevelopmentBuild: true,
      }),
    ).toBeNull();
    expect(
      resolveSidebarStageBackdropVariant("Nightly", {
        enabled: false,
        isDevelopmentBuild: false,
      }),
    ).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Alpha")).toBeNull();
  });

  it("resolves supported environment pill labels", () => {
    expect(resolveEnvironmentIdentificationPillLabel("Dev")).toBe("Dev");
    expect(resolveEnvironmentIdentificationPillLabel("nightly")).toBe("Nightly");
    expect(resolveEnvironmentIdentificationPillLabel("Latest")).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel("Alpha")).toBeNull();
  });
});
