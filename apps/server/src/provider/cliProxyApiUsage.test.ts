import { assert, beforeEach, describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  makeCliProxyApiUsageProbe,
  resetCliProxyApiAuthFailuresForTest,
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

describe("makeCliProxyApiUsageProbe", () => {
  const target = {
    managementUrl: "https://gateway.example.test",
    managementKey: "management-key",
  };

  // Auth-failure strikes are tracked per gateway origin, process-wide, so
  // cases would otherwise inherit each other's ledger.
  beforeEach(() => {
    resetCliProxyApiAuthFailuresForTest();
  });

  it.effect("emits the model-to-upstream mapping from the client models endpoint", () => {
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.url.endsWith("/v1/models")) {
          expect(request.url).toBe("https://client.example.test/v1/models");
          expect(request.headers.authorization).toBe("Bearer client-key");
          return jsonResponse(request, {
            data: [
              { id: "claude-opus-5", owned_by: "anthropic" },
              { id: "gpt-5.6-sol", owned_by: "openai" },
              { id: "future-model", owned_by: "other" },
              { owned_by: "openai" },
            ],
          });
        }
        return jsonResponse(request, {
          files: [{ name: "unknown.json", provider: "unknown" }],
        });
      }),
    );

    return Effect.gen(function* () {
      const payload = (yield* makeCliProxyApiUsageProbe({
        ...target,
        clientUrl: "https://client.example.test",
        clientKey: "client-key",
      })().pipe(Effect.provideService(HttpClient.HttpClient, client))) as CliProxyApiUsagePayload;

      expect(payload.modelProviders).toEqual({
        "claude-opus-5": "claude",
        "gpt-5.6-sol": "codex",
      });
    });
  });

  it.effect("skips the models endpoint when the client key is absent", () => {
    const requests: string[] = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url);
        return jsonResponse(request, {
          files: [{ name: "unknown.json", provider: "unknown" }],
        });
      }),
    );

    return Effect.gen(function* () {
      const payload = (yield* makeCliProxyApiUsageProbe(target)().pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      )) as CliProxyApiUsagePayload;

      expect(payload.modelProviders).toBeUndefined();
      expect(requests).toEqual([`${target.managementUrl}/v0/management/auth-files`]);
    });
  });

  it.effect(
    "suppresses catalog fetches after a rejected client key, without management strikes",
    () => {
      let authFilesRequests = 0;
      let modelsRequests = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.url.endsWith("/v1/models")) {
            modelsRequests += 1;
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 403 }));
          }
          authFilesRequests += 1;
          return jsonResponse(request, {
            files: [{ name: "unknown.json", provider: "unknown" }],
          });
        }),
      );
      const runProbe = makeCliProxyApiUsageProbe({
        ...target,
        clientUrl: target.managementUrl,
        clientKey: "wrong-client-key",
      })().pipe(Effect.provideService(HttpClient.HttpClient, client));

      return Effect.gen(function* () {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const payload = (yield* runProbe) as CliProxyApiUsagePayload;
          expect(payload.modelProviders).toBeUndefined();
        }
        expect(authFilesRequests).toBe(4);
        // One rejection suppresses the catalog fetch — the gateway's per-IP
        // rejection budget may not be endpoint-scoped, and live agent traffic
        // rides the same IP.
        expect(modelsRequests).toBe(1);

        // A corrected key probes again immediately.
        const retried = (yield* makeCliProxyApiUsageProbe({
          ...target,
          clientUrl: target.managementUrl,
          clientKey: "corrected-client-key",
        })().pipe(Effect.provideService(HttpClient.HttpClient, client))) as CliProxyApiUsagePayload;
        expect(retried.modelProviders).toBeUndefined();
        expect(modelsRequests).toBe(2);
      });
    },
  );

  it.effect("single-flights rejected client keys across instances sharing an origin", () =>
    Effect.gen(function* () {
      const firstModelsRequestStarted = yield* Deferred.make<void>();
      const releaseFirstModelsRequest = yield* Deferred.make<void>();
      let modelsRequests = 0;
      const client = HttpClient.make((request) => {
        if (request.url.endsWith("/v1/models")) {
          modelsRequests += 1;
          return Deferred.succeed(firstModelsRequestStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirstModelsRequest)),
            Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 403 }))),
          );
        }
        return Effect.succeed(
          jsonResponse(request, { files: [{ name: "unknown.json", provider: "unknown" }] }),
        );
      });
      const run = (managementUrl: string) =>
        makeCliProxyApiUsageProbe({
          managementUrl,
          managementKey: "management-key",
          clientUrl: "https://shared-client.example.test",
          clientKey: "rejected-client-key",
        })().pipe(Effect.provideService(HttpClient.HttpClient, client));

      const first = yield* run("https://management-a.example.test").pipe(Effect.forkChild);
      yield* Deferred.await(firstModelsRequestStarted);
      const second = yield* run("https://management-b.example.test").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(modelsRequests).toBe(1);

      yield* Deferred.succeed(releaseFirstModelsRequest, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(modelsRequests).toBe(1);
    }),
  );

  it.effect("does not hold account probes behind a stalled models request", () =>
    Effect.gen(function* () {
      const modelsStarted = yield* Deferred.make<void>();
      const accountStarted = yield* Deferred.make<void>();
      const client = HttpClient.make((request) => {
        if (request.url.endsWith("/v1/models")) {
          return Deferred.succeed(modelsStarted, undefined).pipe(Effect.andThen(Effect.never));
        }
        if (request.url.endsWith("/auth-files")) {
          return Effect.succeed(
            jsonResponse(request, {
              files: [{ auth_index: "claude-auth", name: "claude.json", provider: "claude" }],
            }),
          );
        }
        return Deferred.succeed(accountStarted, undefined).pipe(
          Effect.as(jsonResponse(request, { status_code: 500, body: "" })),
        );
      });
      const probe = yield* makeCliProxyApiUsageProbe({
        ...target,
        clientUrl: target.managementUrl,
        clientKey: "client-key",
      })().pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);

      yield* Deferred.await(modelsStarted);
      yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(accountStarted)).toBe(true);

      yield* TestClock.adjust("5 seconds");
      const payload = (yield* Fiber.join(probe)) as CliProxyApiUsagePayload;
      expect(payload.modelProviders).toBeUndefined();
      expect(payload.accounts).toHaveLength(1);
    }),
  );

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
      // The cooled-down probe fails locally — naming the pause, not touching
      // the gateway.
      const cooled = yield* Effect.exit(runProbe);
      assert(cooled._tag === "Failure");
      expect(String(Cause.squash(cooled.cause))).toContain("paused");
      expect(requestCount).toBe(2);

      yield* TestClock.adjust("10 minutes");
      expect((yield* Effect.exit(runProbe))._tag).toBe("Failure");
      expect(requestCount).toBe(4);
    });
  });

  it.effect("spends a per-gateway strike budget that re-typing the key cannot reset", () => {
    let requestCount = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requestCount += 1;
        if (request.url.endsWith("/auth-files")) {
          return jsonResponse(request, {
            files: [{ auth_index: "claude-auth", name: "claude.json", provider: "claude" }],
          });
        }
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 401 }));
      }),
    );
    // Each attempt is a *fresh probe with a different key* — what a user does
    // when the meter stays empty. The gateway bans this IP after five refused
    // keys, so the budget has to survive the rebuild.
    const attempt = (key: string) =>
      makeCliProxyApiUsageProbe({ ...target, managementKey: key })().pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

    return Effect.gen(function* () {
      expect((yield* Effect.exit(attempt("wrong-1")))._tag).toBe("Failure");
      expect((yield* Effect.exit(attempt("wrong-2")))._tag).toBe("Failure");
      expect((yield* Effect.exit(attempt("wrong-3")))._tag).toBe("Failure");
      const spentRequests = requestCount;

      // Budget spent: further keys are refused locally, without touching the
      // gateway, until the 30-minute window elapses.
      expect((yield* Effect.exit(attempt("wrong-4")))._tag).toBe("Failure");
      expect((yield* Effect.exit(attempt("wrong-5")))._tag).toBe("Failure");
      expect(requestCount).toBe(spentRequests);

      yield* TestClock.adjust("30 minutes");
      expect((yield* Effect.exit(attempt("wrong-6")))._tag).toBe("Failure");
      expect(requestCount).toBeGreaterThan(spentRequests);
    });
  });

  it.effect("serializes same-origin probes before admitting another management strike", () =>
    Effect.gen(function* () {
      const thirdRequestStarted = yield* Deferred.make<void>();
      const releaseThirdRequest = yield* Deferred.make<void>();
      let requestCount = 0;
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          requestCount += 1;
          if (requestCount === 3) {
            yield* Deferred.succeed(thirdRequestStarted, undefined);
            yield* Deferred.await(releaseThirdRequest);
          }
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 401 }));
        }),
      );
      const attempt = (key: string) =>
        makeCliProxyApiUsageProbe({ ...target, managementKey: key })().pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.exit,
        );

      yield* attempt("wrong-1");
      yield* attempt("wrong-2");
      const third = yield* attempt("wrong-3").pipe(Effect.forkChild);
      yield* Deferred.await(thirdRequestStarted);
      const fourth = yield* attempt("wrong-4").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(requestCount).toBe(3);

      yield* Deferred.succeed(releaseThirdRequest, undefined);
      yield* Fiber.join(third);
      yield* Fiber.join(fourth);
      expect(requestCount).toBe(3);
    }),
  );
});
