import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  StageBackdropArt,
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

  it.each(["nightly", "dev"] as const)(
    "uses unique SVG definition ids when %s artwork is rendered more than once",
    (variant) => {
      const markup = renderToStaticMarkup(
        <>
          <StageBackdropArt variant={variant} />
          <StageBackdropArt variant={variant} />
        </>,
      );
      const ids = Array.from(markup.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);

      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );
});
