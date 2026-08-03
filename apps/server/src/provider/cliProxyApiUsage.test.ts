import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  makeCliProxyApiUsageProbe,
  resolveCliProxyApiUsageProbeTarget,
  type CliProxyApiUsagePayload,
} from "./cliProxyApiUsage.ts";

const decodeJsonBody = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeJsonBody = Schema.encodeSync(Schema.UnknownFromJsonString);

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
}

function requestBody(request: HttpClientRequest.HttpClientRequest): Record<string, unknown> {
  assert.equal(request.body._tag, "Uint8Array");
  if (request.body._tag !== "Uint8Array") return {};
  return decodeJsonBody(new TextDecoder().decode(request.body.body)) as Record<string, unknown>;
}

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

describe("makeCliProxyApiUsageProbe", () => {
  const target = {
    managementUrl: "https://gateway.example.test",
    managementKey: "management-key",
  };

  it.effect("translates mixed upstream accounts and degrades account failures to rows", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request);
        if (request.url.endsWith("/auth-files")) {
          return jsonResponse(request, {
            files: [
              {
                auth_index: "claude-auth",
                name: "claude.json",
                provider: "claude",
                email: "claude@example.com",
                priority: 100,
              },
              {
                auth_index: "codex-auth",
                name: "codex.json",
                provider: "codex",
                email: "codex@example.com",
                priority: 75,
              },
              {
                auth_index: "broken-auth",
                name: "broken.json",
                provider: "codex",
                priority: 50,
              },
              { name: "missing-index.json", provider: "claude", priority: 25 },
            ],
          });
        }
        const body = requestBody(request);
        switch (body.auth_index) {
          case "claude-auth":
            return jsonResponse(request, {
              status_code: 200,
              body: encodeJsonBody({
                limits: [
                  {
                    kind: "session",
                    percent: 12,
                    resets_at: "2026-08-03T12:00:00.000Z",
                  },
                ],
              }),
            });
          case "codex-auth":
            return jsonResponse(request, {
              status_code: 200,
              body: encodeJsonBody({
                plan_type: "pro",
                rate_limit: {
                  primary_window: {
                    used_percent: 33,
                    limit_window_seconds: 604_800,
                    reset_at: 1_785_475_320,
                  },
                },
              }),
            });
          default:
            return jsonResponse(request, { status_code: 200, body: encodeJsonBody({}) });
        }
      }),
    );

    return Effect.gen(function* () {
      const payload = (yield* makeCliProxyApiUsageProbe(target)().pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      )) as CliProxyApiUsagePayload;

      expect(payload.source).toBe("cliproxyapi.management");
      expect(payload.accounts).toHaveLength(4);
      expect(payload.accounts[0]?.usage).toMatchObject({ source: "claude.usage-api" });
      expect(payload.accounts[1]).toMatchObject({
        planType: "pro",
        usage: {
          primary: {
            usedPercent: 33,
            windowDurationMins: 10_080,
            resetsAt: 1_785_475_320,
          },
        },
      });
      expect(payload.accounts[2]).toMatchObject({
        usage: null,
        error: "Upstream usage body had no rate-limit windows.",
      });
      expect(payload.accounts[3]).toMatchObject({
        usage: null,
        error: "Gateway account has no auth index.",
      });
      expect(requests).toHaveLength(4);
    });
  });

  it.effect("aborts on management auth rejection and suppresses probes for ten minutes", () => {
    let requestCount = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requestCount += 1;
        if (request.url.endsWith("/auth-files")) {
          return jsonResponse(request, {
            files: [{ auth_index: "claude-auth", name: "claude.json", provider: "claude" }],
          });
        }
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 403 }));
      }),
    );
    const probe = makeCliProxyApiUsageProbe(target);
    const runProbe = probe().pipe(Effect.provideService(HttpClient.HttpClient, client));

    return Effect.gen(function* () {
      expect((yield* Effect.exit(runProbe))._tag).toBe("Failure");
      expect(requestCount).toBe(2);
      expect(yield* runProbe).toBeUndefined();
      expect(requestCount).toBe(2);

      yield* TestClock.adjust("10 minutes");
      expect((yield* Effect.exit(runProbe))._tag).toBe("Failure");
      expect(requestCount).toBe(4);
    });
  });
});
