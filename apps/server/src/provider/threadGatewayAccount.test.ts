import { assert, beforeEach, describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
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

function binding(
  overrides: Partial<ProviderRuntimeBindingWithMetadata> = {},
): ProviderRuntimeBindingWithMetadata {
  return {
    threadId: THREAD_ID,
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: INSTANCE_ID,
    resumeCursor: { resume: SESSION_ID },
    lastSeenAt: "2026-08-19T00:00:00.000Z",
    revision: 1,
    providerInstanceIdWasLegacyNull: false,
    ...overrides,
  };
}

const gatewayEnvelope = {
  environment: [
    { name: "ANTHROPIC_BASE_URL", value: "https://gateway.example.test/v1", sensitive: false },
    { name: "ANTHROPIC_AUTH_TOKEN", value: "client-key", sensitive: true },
  ],
  usageSource: { kind: "cliproxyapi", managementKey: "mgmt" },
  // The reader only touches `environment` and `usageSource`; the rest of the
  // instance-config envelope is irrelevant to it.
} as never;

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
    readonly envelope?: unknown;
    readonly respond?: (
      request: HttpClientRequest.HttpClientRequest,
    ) => HttpClientResponse.HttpClientResponse;
    readonly requests?: Array<HttpClientRequest.HttpClientRequest>;
  }) {
    return makeThreadGatewayAccountReader({
      sessionDirectory: {
        getBinding: () => Effect.succeed(options.bindingResult ?? Option.some(binding())),
      },
      instanceRegistry: {
        getInstanceConfig: () =>
          Effect.succeed(("envelope" in options ? options.envelope : gatewayEnvelope) as never),
      },
      httpClient: HttpClient.make((request) =>
        Effect.sync(() => {
          options.requests?.push(request);
          return (
            options.respond?.(request) ??
            traceResponse(request, "20260819121326-af6a89f7d2dec068-d20519ff")
          );
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
      const direct = makeReader({ envelope: { environment: [] }, requests });
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
});
