import { beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  OPENROUTER_API_KEY_SECRET_NAME,
  configureOpenRouterCredits,
  readOpenRouterCredits,
  resetOpenRouterCreditsCacheForTest,
} from "./openRouterCredits.ts";

const textEncoder = new TextEncoder();

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
}

function makeSecretStore(initial?: Record<string, string>) {
  const secrets = new Map<string, Uint8Array>(
    Object.entries(initial ?? {}).map(([name, value]) => [name, textEncoder.encode(value)]),
  );
  const store = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        secrets.set(name, value);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        secrets.set(name, value);
      }),
    getOrCreateRandom: (name) => Effect.sync(() => secrets.get(name) ?? new Uint8Array()),
    remove: (name) =>
      Effect.sync(() => {
        secrets.delete(name);
      }),
  });
  return { store, secrets };
}

function provideServices<A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | ServerSecretStore.ServerSecretStore>,
  client: HttpClient.HttpClient,
  store: ServerSecretStore.ServerSecretStore["Service"],
) {
  return effect.pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(ServerSecretStore.ServerSecretStore, store),
  );
}

describe("openRouterCredits", () => {
  beforeEach(() => {
    resetOpenRouterCreditsCacheForTest();
  });

  it.effect("reports unconfigured without contacting OpenRouter", () => {
    const requests: string[] = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url);
        return jsonResponse(request, {});
      }),
    );
    const { store } = makeSecretStore();
    return Effect.gen(function* () {
      const result = yield* provideServices(readOpenRouterCredits, client, store);
      expect(result).toEqual({ configured: false, snapshot: null });
      expect(requests).toEqual([]);
    });
  });

  it.effect("reads the balance with the stored key and caches it", () => {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({ url: request.url, authorization: request.headers.authorization });
        return jsonResponse(request, { data: { total_credits: 25, total_usage: 10.5 } });
      }),
    );
    const { store } = makeSecretStore({ [OPENROUTER_API_KEY_SECRET_NAME]: "sk-or-v1-test" });
    return Effect.gen(function* () {
      const first = yield* provideServices(readOpenRouterCredits, client, store);
      expect(requests).toEqual([
        {
          url: "https://openrouter.ai/api/v1/credits",
          authorization: "Bearer sk-or-v1-test",
        },
      ]);
      expect(first.configured).toBe(true);
      expect(first.snapshot).toMatchObject({ totalCreditsUsd: 25, totalUsageUsd: 10.5 });

      const second = yield* provideServices(readOpenRouterCredits, client, store);
      expect(requests).toHaveLength(1);
      expect(second.snapshot).toEqual(first.snapshot);
    });
  });

  it.effect("re-reads once the cache is older than a minute", () => {
    let requestCount = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requestCount += 1;
        return jsonResponse(request, {
          data: { total_credits: 25, total_usage: 10 + requestCount },
        });
      }),
    );
    const { store } = makeSecretStore({ [OPENROUTER_API_KEY_SECRET_NAME]: "sk-or-v1-test" });
    return Effect.gen(function* () {
      yield* provideServices(readOpenRouterCredits, client, store);
      yield* TestClock.adjust("2 minutes");
      const refreshed = yield* provideServices(readOpenRouterCredits, client, store);
      expect(requestCount).toBe(2);
      expect(refreshed.snapshot?.totalUsageUsd).toBe(12);
    });
  });

  it.effect("keeps the stale snapshot when a later read fails", () => {
    let requestCount = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requestCount += 1;
        return requestCount === 1
          ? jsonResponse(request, { data: { total_credits: 25, total_usage: 10 } })
          : jsonResponse(request, {}, 500);
      }),
    );
    const { store } = makeSecretStore({ [OPENROUTER_API_KEY_SECRET_NAME]: "sk-or-v1-test" });
    return Effect.gen(function* () {
      const first = yield* provideServices(readOpenRouterCredits, client, store);
      yield* TestClock.adjust("2 minutes");
      const second = yield* provideServices(readOpenRouterCredits, client, store);
      expect(second.configured).toBe(true);
      expect(second.snapshot).toEqual(first.snapshot);
      expect(second.error).toBe("OpenRouter answered with status 500.");
    });
  });

  it.effect("times out a response that hangs after its headers", () => {
    // The single-flight gate is held for the duration of a fetch, so a body
    // that never arrives must hit the timeout instead of wedging every later
    // read in the process.
    const client = HttpClient.make((request) =>
      Effect.sync(() =>
        HttpClientResponse.fromWeb(request, new Response(new ReadableStream(), { status: 200 })),
      ),
    );
    const { store } = makeSecretStore({ [OPENROUTER_API_KEY_SECRET_NAME]: "sk-or-v1-test" });
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(provideServices(readOpenRouterCredits, client, store));
      yield* TestClock.adjust("11 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result).toEqual({
        configured: true,
        snapshot: null,
        error: "The OpenRouter request timed out.",
      });
    });
  });

  it.effect("reports a rejected key without a snapshot", () => {
    const client = HttpClient.make((request) => Effect.sync(() => jsonResponse(request, {}, 401)));
    const { store } = makeSecretStore({ [OPENROUTER_API_KEY_SECRET_NAME]: "sk-or-v1-wrong" });
    return Effect.gen(function* () {
      const result = yield* provideServices(readOpenRouterCredits, client, store);
      expect(result).toEqual({
        configured: true,
        snapshot: null,
        error: "OpenRouter rejected the API key.",
      });
    });
  });

  it.effect("reports an unexpected payload without a snapshot", () => {
    const client = HttpClient.make((request) =>
      Effect.sync(() => jsonResponse(request, { unexpected: true })),
    );
    const { store } = makeSecretStore({ [OPENROUTER_API_KEY_SECRET_NAME]: "sk-or-v1-test" });
    return Effect.gen(function* () {
      const result = yield* provideServices(readOpenRouterCredits, client, store);
      expect(result).toEqual({
        configured: true,
        snapshot: null,
        error: "OpenRouter answered with an unexpected payload.",
      });
    });
  });

  it.effect("stores, replaces, and clears the key, dropping the cache", () => {
    const seenKeys: Array<string | undefined> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        seenKeys.push(request.headers.authorization);
        return jsonResponse(request, { data: { total_credits: 5, total_usage: 1 } });
      }),
    );
    const { store, secrets } = makeSecretStore();
    return Effect.gen(function* () {
      const configured = yield* provideServices(
        configureOpenRouterCredits(" sk-or-v1-first "),
        client,
        store,
      );
      expect(configured).toEqual({ configured: true });
      yield* provideServices(readOpenRouterCredits, client, store);

      // Replacing the key drops the cache, so the next read uses the new key
      // immediately instead of serving the old key's cached balance.
      yield* provideServices(configureOpenRouterCredits("sk-or-v1-second"), client, store);
      yield* provideServices(readOpenRouterCredits, client, store);
      expect(seenKeys).toEqual(["Bearer sk-or-v1-first", "Bearer sk-or-v1-second"]);

      const cleared = yield* provideServices(configureOpenRouterCredits("  "), client, store);
      expect(cleared).toEqual({ configured: false });
      expect(secrets.has(OPENROUTER_API_KEY_SECRET_NAME)).toBe(false);
      const result = yield* provideServices(readOpenRouterCredits, client, store);
      expect(result).toEqual({ configured: false, snapshot: null });
    });
  });
});
