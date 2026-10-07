import { describe, expect, it } from "vite-plus/test";

import { resolveComposerProviderUsageAccess } from "./providerUsagePill";

describe("resolveComposerProviderUsageAccess", () => {
  it("withholds usage reads and the account probe without diagnostics:read", () => {
    expect(
      resolveComposerProviderUsageAccess({ canReadDiagnostics: false, canOperate: true }),
    ).toEqual({
      canReadUsage: false,
      canProbeThreadAccount: false,
    });
  });

  it("reads usage but skips the account probe without orchestration:operate", () => {
    expect(
      resolveComposerProviderUsageAccess({ canReadDiagnostics: true, canOperate: false }),
    ).toEqual({
      canReadUsage: true,
      canProbeThreadAccount: false,
    });
  });

  it("allows both with both grants", () => {
    expect(
      resolveComposerProviderUsageAccess({ canReadDiagnostics: true, canOperate: true }),
    ).toEqual({
      canReadUsage: true,
      canProbeThreadAccount: true,
    });
  });
});
