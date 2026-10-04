import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  parseCliProxyApiTraceAuthIndex,
  resolveCliProxyApiUsageProbeTarget,
} from "./cliProxyApiUsage.ts";

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
      clientUrl: "https://gateway.example.ts.net",
      clientKey: "client-key",
    });
  });

  it("derives Codex gateway targets from OpenAI-compatible variables", () => {
    expect(
      resolveCliProxyApiUsageProbeTarget({
        environment: [
          {
            name: "OPENAI_BASE_URL",
            value: "https://codex-gateway.example.ts.net/v1",
            sensitive: false,
          },
          { name: "OPENAI_API_KEY", value: "codex-client-key", sensitive: true },
        ],
        usageSource: { kind: "cliproxyapi", managementKey: "mgmt" },
      }),
    ).toEqual({
      managementUrl: "https://codex-gateway.example.ts.net",
      managementKey: "mgmt",
      clientUrl: "https://codex-gateway.example.ts.net",
      clientKey: "codex-client-key",
    });
  });

  it("keeps the derived management and client targets on the same env family", () => {
    expect(
      resolveCliProxyApiUsageProbeTarget({
        environment: [
          { name: "ANTHROPIC_BASE_URL", value: "https://unused.example/v1", sensitive: false },
          {
            name: "OPENAI_BASE_URL",
            value: "https://codex-gateway.example/v1",
            sensitive: false,
          },
          { name: "OPENAI_API_KEY", value: "codex-client-key", sensitive: true },
        ],
        usageSource: { kind: "cliproxyapi", managementKey: "mgmt" },
      }),
    ).toEqual({
      managementUrl: "https://codex-gateway.example",
      managementKey: "mgmt",
      clientUrl: "https://codex-gateway.example",
      clientKey: "codex-client-key",
    });
  });

  it("prefers OpenAI-compatible variables for a Codex driver when both families exist", () => {
    expect(
      resolveCliProxyApiUsageProbeTarget(
        {
          environment: [
            {
              name: "ANTHROPIC_BASE_URL",
              value: "https://claude-gateway.example/v1",
              sensitive: false,
            },
            { name: "ANTHROPIC_AUTH_TOKEN", value: "claude-client-key", sensitive: true },
            {
              name: "OPENAI_BASE_URL",
              value: "https://codex-gateway.example/v1",
              sensitive: false,
            },
            { name: "OPENAI_API_KEY", value: "codex-client-key", sensitive: true },
          ],
          usageSource: { kind: "cliproxyapi", managementKey: "mgmt" },
        },
        ProviderDriverKind.make("codex"),
      ),
    ).toEqual({
      managementUrl: "https://codex-gateway.example",
      managementKey: "mgmt",
      clientUrl: "https://codex-gateway.example",
      clientKey: "codex-client-key",
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
      clientUrl: "https://gateway.example.ts.net",
      clientKey: "client-key",
    });
  });

  it("returns null without a key, without a usable URL, or for other source kinds", () => {
    expect(
      resolveCliProxyApiUsageProbeTarget({
        environment,
        usageSource: { kind: "cliproxyapi", managementKey: "" },
      }),
    ).toBeNull();
    expect(
      resolveCliProxyApiUsageProbeTarget({
        environment: [{ name: "ANTHROPIC_BASE_URL", value: "not a url", sensitive: false }],
        usageSource: { kind: "cliproxyapi", managementKey: "mgmt" },
      }),
    ).toBeNull();
    expect(
      resolveCliProxyApiUsageProbeTarget({
        environment,
        usageSource: {
          kind: "cliproxyapi",
          managementUrl: "not a url",
          managementKey: "mgmt",
        },
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
});

describe("parseCliProxyApiTraceAuthIndex", () => {
  it("extracts the middle segment of a well-formed trace id", () => {
    expect(parseCliProxyApiTraceAuthIndex("20260819121326-af6a89f7d2dec068-d20519ff")).toBe(
      "af6a89f7d2dec068",
    );
  });

  it("keeps a hyphenated auth index intact", () => {
    expect(parseCliProxyApiTraceAuthIndex("20260819121326-auth-with-hyphens-d20519ff")).toBe(
      "auth-with-hyphens",
    );
  });

  it("rejects malformed values", () => {
    expect(parseCliProxyApiTraceAuthIndex("")).toBeNull();
    expect(parseCliProxyApiTraceAuthIndex("not-a-trace")).toBeNull();
    expect(parseCliProxyApiTraceAuthIndex("20260819121326-onlyonesegment")).toBeNull();
  });
});
