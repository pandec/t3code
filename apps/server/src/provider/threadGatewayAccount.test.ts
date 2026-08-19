import { assert, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  makeCliProxyApiUsageProbe,
  parseCliProxyApiTraceAuthIndex,
  resetCliProxyApiAuthFailuresForTest,
} from "./cliProxyApiUsage.ts";
import type { ProviderRuntimeBindingWithMetadata } from "./Services/ProviderSessionDirectory.ts";
import {
  claudeSessionIdFromResumeCursor,
  makeThreadGatewayAccountReader,
} from "./threadGatewayAccount.ts";

const decodeJsonBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const SESSION_ID = "e9ee34da-ab4f-4a20-a9f2-856c855729ce";
const THREAD_ID = ThreadId.make("thread-1");
const INSTANCE_ID = ProviderInstanceId.make("claudeAgent_proxy");

// TestClock starts at 0, so a fixture stamped in the future reads as fresh.
const FRESH_LAST_SEEN_AT = "2026-08-19T00:00:00.000Z";

function binding(
  overrides: Partial<ProviderRuntimeBindingWithMetadata> = {},
): ProviderRuntimeBindingWithMetadata {
  return {
    threadId: THREAD_ID,
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: INSTANCE_ID,
    resumeCursor: { resume: SESSION_ID },
    lastSeenAt: FRESH_LAST_SEEN_AT,
    revision: 1,
    providerInstanceIdWasLegacyNull: false,
    ...overrides,
  };
}

const gatewayEnvelope: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("claudeAgent"),
  environment: [
    { name: "ANTHROPIC_BASE_URL", value: "https://gateway.example.test/v1", sensitive: false },
    { name: "ANTHROPIC_AUTH_TOKEN", value: "client-key", sensitive: true },
  ],
  usageSource: { kind: "cliproxyapi", managementKey: "mgmt" },
};

function traceResponse(request: HttpClientRequest.HttpClientRequest, traceId: string | null) {
  return HttpClientResponse.fromWeb(
    request,
    Response.json(
      { input_tokens: 1 },
      { headers: traceId === null ? {} : { "x-cpa-trace-id": traceId } },
    ),
  );
}

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

describe("claudeSessionIdFromResumeCursor", () => {
  it("reads `resume` first, then the legacy `sessionId` slot", () => {
    expect(claudeSessionIdFromResumeCursor({ resume: SESSION_ID })).toBe(SESSION_ID);
    expect(claudeSessionIdFromResumeCursor({ sessionId: SESSION_ID })).toBe(SESSION_ID);
    expect(claudeSessionIdFromResumeCursor({ resume: SESSION_ID, sessionId: "ignored" })).toBe(
      SESSION_ID,
    );
  });

  it("treats non-UUID and malformed cursors as absent", () => {
    expect(claudeSessionIdFromResumeCursor({ resume: "not-a-uuid" })).toBeNull();
    // The adapter's isUuid enforces the version and variant nibbles, so ids
    // the adapter would never resume are absent here too.
    expect(
      claudeSessionIdFromResumeCursor({ resume: "00000000-0000-0000-0000-000000000000" }),
    ).toBeNull();
    expect(claudeSessionIdFromResumeCursor({ threadId: "native-thread" })).toBeNull();
    expect(claudeSessionIdFromResumeCursor(null)).toBeNull();
    expect(claudeSessionIdFromResumeCursor("string")).toBeNull();
    expect(claudeSessionIdFromResumeCursor([SESSION_ID])).toBeNull();
  });
});

describe("makeThreadGatewayAccountReader", () => {
  beforeEach(() => {
    resetCliProxyApiAuthFailuresForTest();
  });

  function makeReader(options: {
    readonly bindingResult?: Option.Option<ProviderRuntimeBindingWithMetadata>;
    readonly envelope?: ProviderInstanceConfig | undefined;
    readonly respond?: (
      request: HttpClientRequest.HttpClientRequest,
    ) =>
      | HttpClientResponse.HttpClientResponse
      | Effect.Effect<HttpClientResponse.HttpClientResponse>;
    readonly requests?: Array<HttpClientRequest.HttpClientRequest>;
  }) {
    return makeThreadGatewayAccountReader({
      sessionDirectory: {
        getBinding: () => Effect.succeed(options.bindingResult ?? Option.some(binding())),
      },
      instanceRegistry: {
        getInstanceConfig: () =>
          Effect.succeed("envelope" in options ? options.envelope : gatewayEnvelope),
      },
      httpClient: HttpClient.make((request) =>
        Effect.suspend(() => {
          options.requests?.push(request);
          const response =
            options.respond?.(request) ??
            traceResponse(request, "20260819121326-af6a89f7d2dec068-d20519ff");
          return Effect.isEffect(response)
            ? (response as Effect.Effect<HttpClientResponse.HttpClientResponse>)
            : Effect.succeed(response);
        }),
      ),
    });
  }

  it.effect(
    "probes count_tokens with the session's affinity key and reports the auth index",
    () => {
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const read = makeReader({ requests });
      return Effect.gen(function* () {
        const result = yield* read({ threadId: THREAD_ID, model: "claude-opus-5" });
        expect(result).toEqual({ authIndex: "af6a89f7d2dec068" });

        expect(requests).toHaveLength(1);
        const request = requests[0]!;
        expect(request.url).toBe("https://gateway.example.test/v1/messages/count_tokens");
        expect(request.headers.authorization).toBe("Bearer client-key");
        assert.equal(request.body._tag, "Uint8Array");
        if (request.body._tag !== "Uint8Array") return;
        const body = decodeJsonBody(new TextDecoder().decode(request.body.body)) as Record<
          string,
          unknown
        >;
        expect(body.model).toBe("claude-opus-5");
        expect(body.metadata).toEqual({ user_id: `t3_session_${SESSION_ID}` });
      });
    },
  );

  it.effect("answers null without a binding, or for a non-Claude provider", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const unbound = makeReader({ bindingResult: Option.none(), requests });
      expect(yield* unbound({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });

      const codex = makeReader({
        bindingResult: Option.some(binding({ provider: ProviderDriverKind.make("codex") })),
        requests,
      });
      expect(yield* codex({ threadId: THREAD_ID, model: "gpt-5.6-sol" })).toEqual({
        authIndex: null,
      });
      expect(requests).toHaveLength(0);
    });
  });

  it.effect("answers null for a stopped or errored session without probing", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const stopped = makeReader({
        bindingResult: Option.some(binding({ status: "stopped" })),
        requests,
      });
      expect(yield* stopped({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });
      const errored = makeReader({
        bindingResult: Option.some(binding({ status: "error" })),
        requests,
      });
      expect(yield* errored({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });
      expect(requests).toHaveLength(0);
    });
  });

  it.effect("answers null for a long-idle or unparseable binding without probing", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      // Two hours past the epoch-stamped binding: the gateway's sliding
      // one-hour TTL has certainly lapsed, so probing would create a fresh
      // binding for a dead session rather than read anything.
      yield* TestClock.adjust("2 hours");
      const stale = makeReader({
        bindingResult: Option.some(binding({ lastSeenAt: "1970-01-01T00:00:00.000Z" })),
        requests,
      });
      expect(yield* stale({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });

      const unparseable = makeReader({
        bindingResult: Option.some(binding({ lastSeenAt: "not-a-date" as never })),
        requests,
      });
      expect(yield* unparseable({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });
      expect(requests).toHaveLength(0);
    });
  });

  it.effect("answers null when the cursor has no session UUID or the instance is unknown", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const noSession = makeReader({
        bindingResult: Option.some(binding({ resumeCursor: { threadId: "native" } })),
        requests,
      });
      expect(yield* noSession({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });

      const { providerInstanceId: _instanceless, ...withoutInstance } = binding();
      const noInstance = makeReader({
        bindingResult: Option.some(withoutInstance),
        requests,
      });
      expect(yield* noInstance({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });

      const noEnvelope = makeReader({ envelope: undefined, requests });
      expect(yield* noEnvelope({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });

      // A non-gateway instance resolves no probe target.
      const direct = makeReader({
        envelope: { driver: ProviderDriverKind.make("claudeAgent"), environment: [] },
        requests,
      });
      expect(yield* direct({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });
      expect(requests).toHaveLength(0);
    });
  });

  it.effect("answers null on probe failure and on a missing trace header", () => {
    return Effect.gen(function* () {
      const failing = makeReader({
        respond: (request) =>
          HttpClientResponse.fromWeb(request, new Response(null, { status: 500 })),
      });
      expect(yield* failing({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });

      const headerless = makeReader({ respond: (request) => traceResponse(request, null) });
      expect(yield* headerless({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });
    });
  });

  it.effect("answers null when the gateway never responds, after the probe timeout", () => {
    const read = makeReader({ respond: () => Effect.never });
    return Effect.gen(function* () {
      const fiber = yield* read({ threadId: THREAD_ID, model: "claude-opus-5" }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toEqual({ authIndex: null });
    });
  });

  it.effect("stops probing an origin whose client key was rejected", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const read = makeReader({
      requests,
      respond: (request) =>
        HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })),
    });
    return Effect.gen(function* () {
      expect(yield* read({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });
      expect(yield* read({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });
      // The second call short-circuits: one rejection suppresses the pairing.
      expect(requests).toHaveLength(1);
    });
  });

  it.effect("single-flights concurrent probes so one rejection spends one strike", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const firstRequestStarted = yield* Deferred.make<void>();
      const releaseFirstRequest = yield* Deferred.make<void>();
      const read = makeReader({
        requests,
        respond: (request) =>
          Deferred.succeed(firstRequestStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirstRequest)),
            Effect.map(() =>
              HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })),
            ),
          ),
      });
      const first = yield* read({ threadId: THREAD_ID, model: "claude-opus-5" }).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(firstRequestStarted);
      // The second probe must queue on the client-key lock rather than spend
      // another rejection strike while the first is still in flight.
      const second = yield* read({ threadId: THREAD_ID, model: "claude-fable-5" }).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseFirstRequest, undefined);
      expect(yield* Fiber.join(first)).toEqual({ authIndex: null });
      expect(yield* Fiber.join(second)).toEqual({ authIndex: null });
      expect(requests).toHaveLength(1);
    });
  });

  it.effect("does not latch on an upstream 401 that carries a trace id", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const read = makeReader({
      requests,
      // A trace id proves the gateway selected a credential: the rejection
      // came from the upstream provider, not from the client key.
      respond: (request) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            status: 401,
            headers: { "x-cpa-trace-id": "20260819121326-af6a89f7d2dec068-d20519ff" },
          }),
        ),
    });
    return Effect.gen(function* () {
      expect(yield* read({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });
      expect(yield* read({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });
      expect(requests).toHaveLength(2);
    });
  });

  it.effect("shares the client-key rejection latch with the model-catalog fetch", () => {
    let probeRequests = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.url.endsWith("/v1/models")) {
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 403 }));
        }
        if (request.url.endsWith("/v1/messages/count_tokens")) {
          probeRequests += 1;
          return traceResponse(request, "20260819121326-af6a89f7d2dec068-d20519ff");
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ files: [{ name: "unknown.json", provider: "unknown" }] }),
        );
      }),
    );
    const read = makeThreadGatewayAccountReader({
      sessionDirectory: { getBinding: () => Effect.succeed(Option.some(binding())) },
      instanceRegistry: { getInstanceConfig: () => Effect.succeed(gatewayEnvelope) },
      httpClient: client,
    });
    return Effect.gen(function* () {
      // The catalog fetch gets its client key rejected first...
      yield* makeCliProxyApiUsageProbe({
        managementUrl: "https://gateway.example.test",
        managementKey: "mgmt",
        clientUrl: "https://gateway.example.test",
        clientKey: "client-key",
      })().pipe(Effect.provideService(HttpClient.HttpClient, client));
      // ...which must silence the session probe for the same (origin, key).
      expect(yield* read({ threadId: THREAD_ID, model: "claude-opus-5" })).toEqual({
        authIndex: null,
      });
      expect(probeRequests).toBe(0);
    });
  });
});
