import { describe, expect, it } from "vite-plus/test";

import { resolveCliProxyApiUsageProbeTarget } from "./cliProxyApiUsage.ts";

describe("resolveCliProxyApiUsageProbeTarget", () => {
  const environment = [
    { name: "ANTHROPIC_BASE_URL", value: "https://gateway.example.ts.net/v1", sensitive: false },
    { name: "ANTHROPIC_AUTH_TOKEN", value: "client-key", sensitive: true },
  ];

  it("derives the management origin from ANTHROPIC_BASE_URL when no URL is configured", () => {
    expect(
      resolveCliProxyApiUsageProbeTarget({
        environment,
        usageSource: { kind: "cliproxyapi", managementKey: "mgmt" },
      }),
    ).toEqual({
      managementUrl: "https://gateway.example.ts.net",
      managementKey: "mgmt",
    });
  });

  it("prefers an explicit management URL, reduced to its origin", () => {
    expect(
      resolveCliProxyApiUsageProbeTarget({
        environment,
        usageSource: {
          kind: "cliproxyapi",
          managementUrl: "https://mgmt.example.ts.net:8446/ignored/path",
          managementKey: "mgmt",
        },
      }),
    ).toEqual({
      managementUrl: "https://mgmt.example.ts.net:8446",
      managementKey: "mgmt",
    });
  });

  it("returns null without a key, without any URL, or for other source kinds", () => {
    expect(
      resolveCliProxyApiUsageProbeTarget({
        environment,
        usageSource: { kind: "cliproxyapi", managementKey: "" },
      }),
    ).toBeNull();
    expect(
      resolveCliProxyApiUsageProbeTarget({
        environment: [],
        usageSource: { kind: "cliproxyapi", managementKey: "mgmt" },
      }),
    ).toBeNull();
    expect(
      resolveCliProxyApiUsageProbeTarget({
        environment,
        usageSource: { kind: "some-future-gateway", managementKey: "mgmt" },
      }),
    ).toBeNull();
    expect(resolveCliProxyApiUsageProbeTarget({ environment })).toBeNull();
  });

  it("rejects an unparseable base URL rather than probing a garbage origin", () => {
    expect(
      resolveCliProxyApiUsageProbeTarget({
        environment: [{ name: "ANTHROPIC_BASE_URL", value: "not a url", sensitive: false }],
        usageSource: { kind: "cliproxyapi", managementKey: "mgmt" },
      }),
    ).toBeNull();
  });
});
