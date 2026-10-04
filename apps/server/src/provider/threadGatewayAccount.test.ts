import { assert, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import {
  makeCliProxyApiUsageProbe,
  resetCliProxyApiAuthFailuresForTest,
} from "./cliProxyApiUsage.ts";
import {
  liveClaudeSessionId,
  makeThreadGatewayAccountReader,
  type ThreadGatewayAccountProjections,
} from "./threadGatewayAccount.ts";

const decodeJsonBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const SESSION_ID = "e9ee34da-ab4f-4a20-a9f2-856c855729ce";
const THREAD_ID = ThreadId.make("thread-1");
const INSTANCE_ID = ProviderInstanceId.make("claudeAgent_proxy");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const PROVIDER_THREAD_ID = ProviderThreadId.make("provider-thread-1");
const PROVIDER_SESSION_ID = ProviderSessionId.make("provider-session-1");
const LAST_ACTIVITY = DateTime.makeUnsafe("2026-08-19T00:00:00.000Z");
const LAST_ACTIVITY_MS = DateTime.toEpochMillis(LAST_ACTIVITY);

function providerThread(
  overrides: Partial<OrchestrationV2ProviderThread> = {},
): OrchestrationV2ProviderThread {
  return {
    id: PROVIDER_THREAD_ID,
    driver: CLAUDE,
    providerInstanceId: INSTANCE_ID,
    providerSessionId: PROVIDER_SESSION_ID,
    appThreadId: THREAD_ID,
    ownerNodeId: null,
    nativeThreadRef: { driver: CLAUDE, nativeId: SESSION_ID, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    createdAt: LAST_ACTIVITY,
    updatedAt: LAST_ACTIVITY,
    ...overrides,
  };
}

function providerSession(
  overrides: Partial<OrchestrationV2ProviderSession> = {},
): OrchestrationV2ProviderSession {
  return {
    id: PROVIDER_SESSION_ID,
    driver: CLAUDE,
    providerInstanceId: INSTANCE_ID,
    status: "ready",
    cwd: "/repo",
    model: "claude-opus-5",
    capabilities: ClaudeProviderCapabilitiesV2,
    createdAt: LAST_ACTIVITY,
    updatedAt: LAST_ACTIVITY,
    lastError: null,
    ...overrides,
  };
}

interface ProjectionFixture {
  readonly activeProviderThreadId?: ProviderThreadId | null;
  readonly providerThreads?: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly providerSessions?: ReadonlyArray<OrchestrationV2ProviderSession>;
  readonly missingThread?: boolean;
}

function projections(fixture: ProjectionFixture = {}): ThreadGatewayAccountProjections {
  return {
    getThread: (threadId) =>
      fixture.missingThread === true
        ? Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId }))
        : Effect.succeed({
            activeProviderThreadId:
              fixture.activeProviderThreadId === undefined
                ? PROVIDER_THREAD_ID
                : fixture.activeProviderThreadId,
            providerInstanceId: INSTANCE_ID,
          }),
    getThreadProviderContext: () =>
      Effect.succeed({
        providerThreads: fixture.providerThreads ?? [providerThread()],
        providerSessions: fixture.providerSessions ?? [providerSession()],
      }),
  };
}

const gatewayEnvelope: ProviderInstanceConfig = {
  driver: CLAUDE,
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

describe("liveClaudeSessionId", () => {
  const live = (input: {
    readonly thread?: OrchestrationV2ProviderThread | undefined;
    readonly session?: OrchestrationV2ProviderSession | undefined;
    readonly nowMs?: number;
  }) =>
    liveClaudeSessionId({
      providerThread: "thread" in input ? input.thread : providerThread(),
      providerSession: "session" in input ? input.session : providerSession(),
      nowMs: input.nowMs ?? LAST_ACTIVITY_MS,
    });

  it("reads the native session UUID of a live root Claude provider thread", () => {
    expect(live({})).toBe(SESSION_ID);
    // Still inside the gateway's one-hour sliding affinity window.
    expect(live({ nowMs: LAST_ACTIVITY_MS + 59 * 60_000 })).toBe(SESSION_ID);
  });

  it("treats missing, foreign, child, and non-Claude records as absent", () => {
    expect(live({ thread: undefined })).toBeNull();
    expect(live({ session: undefined })).toBeNull();
    expect(live({ thread: providerThread({ driver: ProviderDriverKind.make("codex") }) })).toBe(
      null,
    );
    expect(
      live({ session: providerSession({ id: ProviderSessionId.make("other-session") }) }),
    ).toBeNull();
    expect(
      live({ thread: providerThread({ ownerNodeId: NodeId.make("node-subagent") }) }),
    ).toBeNull();
  });

  it("treats stopped, errored, and long-idle sessions as absent", () => {
    expect(live({ session: providerSession({ status: "stopped" }) })).toBeNull();
    expect(live({ session: providerSession({ status: "error" }) })).toBeNull();
    expect(live({ nowMs: LAST_ACTIVITY_MS + 2 * 60 * 60_000 })).toBeNull();
  });

  it("refuses native ids that are not Claude session UUIDs", () => {
    const withNativeId = (nativeId: string | null) =>
      providerThread({ nativeThreadRef: { driver: CLAUDE, nativeId, strength: "strong" } });
    expect(live({ thread: withNativeId("not-a-uuid") })).toBeNull();
    expect(live({ thread: withNativeId("00000000-0000-0000-0000-000000000000") })).toBeNull();
    expect(live({ thread: withNativeId(null) })).toBeNull();
    expect(live({ thread: providerThread({ nativeThreadRef: null }) })).toBeNull();
  });
});

describe("makeThreadGatewayAccountReader", () => {
  beforeEach(() => {
    resetCliProxyApiAuthFailuresForTest();
  });

  function makeReader(options: {
    readonly fixture?: ProjectionFixture;
    readonly envelope?: ProviderInstanceConfig | undefined;
    readonly respond?: (
      request: HttpClientRequest.HttpClientRequest,
    ) =>
      | HttpClientResponse.HttpClientResponse
      | Effect.Effect<HttpClientResponse.HttpClientResponse>;
    readonly requests?: Array<HttpClientRequest.HttpClientRequest>;
  }) {
    return makeThreadGatewayAccountReader({
      projections: projections(options.fixture),
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
          return Effect.isEffect(response) ? response : Effect.succeed(response);
        }),
      ),
    });
  }

  const input = { threadId: THREAD_ID, model: "claude-opus-5" };

  it.effect(
    "probes count_tokens with the session's affinity key and reports the auth index",
    () => {
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const read = makeReader({ requests });
      return Effect.gen(function* () {
        yield* TestClock.setTime(LAST_ACTIVITY_MS);
        expect(yield* read(input)).toEqual({ authIndex: "af6a89f7d2dec068" });

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

  it.effect("answers null without probing when the thread has no live Claude session", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(LAST_ACTIVITY_MS);
      const cases: ReadonlyArray<ProjectionFixture> = [
        { missingThread: true },
        { activeProviderThreadId: null },
        // The active provider thread is not among the projection's records.
        { providerThreads: [] },
        { providerSessions: [] },
        { providerSessions: [providerSession({ status: "stopped" })] },
        { providerThreads: [providerThread({ driver: ProviderDriverKind.make("codex") })] },
      ];
      for (const fixture of cases) {
        expect(yield* makeReader({ fixture, requests })(input)).toEqual({ authIndex: null });
      }
      expect(requests).toHaveLength(0);
    });
  });

  it.effect("answers null without probing once the session idled past the affinity TTL", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const read = makeReader({ requests });
    return Effect.gen(function* () {
      yield* TestClock.setTime(LAST_ACTIVITY_MS + 2 * 60 * 60_000);
      expect(yield* read(input)).toEqual({ authIndex: null });
      expect(requests).toHaveLength(0);
    });
  });

  it.effect("answers null for an unknown or non-gateway instance", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(LAST_ACTIVITY_MS);
      const noEnvelope = makeReader({ envelope: undefined, requests });
      expect(yield* noEnvelope(input)).toEqual({ authIndex: null });
      const direct = makeReader({ envelope: { driver: CLAUDE, environment: [] }, requests });
      expect(yield* direct(input)).toEqual({ authIndex: null });
      expect(requests).toHaveLength(0);
    });
  });

  it.effect("answers null on probe failure, a missing trace header, or a stalled gateway", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(LAST_ACTIVITY_MS);
      const failing = makeReader({
        respond: (request) =>
          HttpClientResponse.fromWeb(request, new Response(null, { status: 500 })),
      });
      expect(yield* failing(input)).toEqual({ authIndex: null });

      const headerless = makeReader({ respond: (request) => traceResponse(request, null) });
      expect(yield* headerless(input)).toEqual({ authIndex: null });

      const stalled = yield* makeReader({ respond: () => Effect.never })(input).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(stalled)).toEqual({ authIndex: null });
    }),
  );

  it.effect("stops probing an origin whose client key was rejected", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const read = makeReader({
      requests,
      respond: (request) =>
        HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(LAST_ACTIVITY_MS);
      expect(yield* read(input)).toEqual({ authIndex: null });
      expect(yield* read(input)).toEqual({ authIndex: null });
      // The second call short-circuits: one rejection suppresses the pairing.
      expect(requests).toHaveLength(1);
    });
  });

  it.effect("single-flights concurrent probes so one rejection spends one strike", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(LAST_ACTIVITY_MS);
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
      const first = yield* read(input).pipe(Effect.forkChild);
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
      yield* TestClock.setTime(LAST_ACTIVITY_MS);
      expect(yield* read(input)).toEqual({ authIndex: null });
      expect(yield* read(input)).toEqual({ authIndex: null });
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
      projections: projections(),
      instanceRegistry: { getInstanceConfig: () => Effect.succeed(gatewayEnvelope) },
      httpClient: client,
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(LAST_ACTIVITY_MS);
      // The catalog fetch gets its client key rejected first...
      yield* makeCliProxyApiUsageProbe({
        managementUrl: "https://gateway.example.test",
        managementKey: "mgmt",
        clientUrl: "https://gateway.example.test",
        clientKey: "client-key",
      })().pipe(Effect.provideService(HttpClient.HttpClient, client));
      // ...which must silence the session probe for the same (origin, key).
      expect(yield* read(input)).toEqual({ authIndex: null });
      expect(probeRequests).toBe(0);
    });
  });
});
