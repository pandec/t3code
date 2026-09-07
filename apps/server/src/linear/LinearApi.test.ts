import { beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  LINEAR_API_KEY_SECRET_NAME,
  configureLinear,
  createLinearComment,
  readLinearComments,
  readLinearIssue,
  readLinearStatus,
  clearLinearCache,
} from "./LinearApi.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const decodeRequestBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      query: Schema.String,
      variables: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);

interface RecordedRequest {
  readonly authorization: string | undefined;
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

function makeClient(
  respond: (request: RecordedRequest) => {
    body: unknown;
    status?: number;
    headers?: Record<string, string>;
  },
) {
  const requests: RecordedRequest[] = [];
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.sync(() => {
      const raw = (request.body as { readonly body?: Uint8Array }).body;
      const parsed = decodeRequestBody(textDecoder.decode(raw));
      const recorded = {
        authorization: request.headers.authorization,
        query: parsed.query,
        variables: parsed.variables,
      };
      requests.push(recorded);
      const { body, status = 200, headers } = respond(recorded);
      return HttpClientResponse.fromWeb(
        request,
        Response.json(body, headers === undefined ? { status } : { status, headers }),
      );
    }),
  );
  return { client, requests };
}

function makeSecretStore(initial?: Record<string, string>) {
  const secrets = new Map<string, Uint8Array>(
    Object.entries(initial ?? {}).map(([name, value]) => [name, textEncoder.encode(value)]),
  );
  const store = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: (name) => Effect.sync(() => secrets.get(name) ?? new Uint8Array()),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });
  return { store, secrets };
}

function provide<A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | ServerSecretStore.ServerSecretStore>,
  client: HttpClient.HttpClient,
  store: ServerSecretStore.ServerSecretStore["Service"],
) {
  return effect.pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(ServerSecretStore.ServerSecretStore, store),
  );
}

const statusBody = {
  data: {
    viewer: { name: "Ada Lovelace", displayName: "ada" },
    organization: { name: "Acme", urlKey: "acme" },
    teams: { nodes: [{ key: "SP" }, { key: "OP" }] },
  },
};

const issueBody = {
  data: {
    issue: {
      id: "issue-uuid",
      identifier: "SP-123",
      url: "https://linear.app/acme/issue/SP-123/fix-login",
      title: "Fix login",
      description: "Users cannot log in.",
      priorityLabel: "High",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      dueDate: null,
      state: { name: "In Progress", type: "started", color: "#f2c94c" },
      team: { name: "SalesPros" },
      project: { name: "Auth" },
      assignee: { name: "Ada Lovelace", displayName: "ada", avatarUrl: null },
      creator: { name: "Grace Hopper", displayName: "grace", avatarUrl: "https://x/y.png" },
      labels: { nodes: [{ name: "bug", color: "#eb5757" }] },
    },
  },
};

const comment = (id: string, body: string) => ({
  id,
  body,
  createdAt: "2026-01-03T00:00:00.000Z",
  user: { name: "Ada Lovelace", displayName: "ada", avatarUrl: null },
  botActor: null,
});

describe("LinearApi", () => {
  beforeEach(() => {
    clearLinearCache();
  });

  it.effect("reports unconfigured without contacting Linear", () => {
    const { client, requests } = makeClient(() => ({ body: {} }));
    const { store } = makeSecretStore();
    return Effect.gen(function* () {
      const status = yield* provide(readLinearStatus, client, store);
      expect(status).toEqual({ configured: false, viewer: null, workspace: null, teamKeys: [] });
      expect(requests).toEqual([]);
      const issue = yield* provide(readLinearIssue({ identifier: "SP-1" }), client, store).pipe(
        Effect.flip,
      );
      expect(issue.reason).toBe("unconfigured");
    });
  });

  it.effect("configure rejects a bad key and stores a good one", () => {
    const { client } = makeClient(({ authorization }) =>
      authorization === "lin_api_good"
        ? { body: statusBody }
        : { body: { errors: [{ message: "Authentication required, not authenticated" }] } },
    );
    const { store, secrets } = makeSecretStore();
    return Effect.gen(function* () {
      const rejected = yield* provide(configureLinear("lin_api_bad"), client, store).pipe(
        Effect.flip,
      );
      expect(rejected.reason).toBe("unauthenticated");
      expect(secrets.has(LINEAR_API_KEY_SECRET_NAME)).toBe(false);

      const status = yield* provide(configureLinear(" lin_api_good "), client, store);
      expect(status).toEqual({
        configured: true,
        viewer: { name: "Ada Lovelace", displayName: "ada" },
        workspace: { name: "Acme", urlKey: "acme" },
        teamKeys: ["OP", "SP"],
      });
      expect(textDecoder.decode(secrets.get(LINEAR_API_KEY_SECRET_NAME))).toBe("lin_api_good");

      const cleared = yield* provide(configureLinear(""), client, store);
      expect(cleared.configured).toBe(false);
      expect(secrets.has(LINEAR_API_KEY_SECRET_NAME)).toBe(false);
    });
  });

  it.effect("decodes an issue, sends a bare Authorization header, and caches by identifier", () => {
    const { client, requests } = makeClient(() => ({ body: issueBody }));
    const { store } = makeSecretStore({ [LINEAR_API_KEY_SECRET_NAME]: "lin_api_test" });
    return Effect.gen(function* () {
      const issue = yield* provide(readLinearIssue({ identifier: "sp-123" }), client, store);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.authorization).toBe("lin_api_test");
      expect(requests[0]?.variables).toEqual({ id: "SP-123" });
      expect(issue).toMatchObject({
        id: "issue-uuid",
        identifier: "SP-123",
        title: "Fix login",
        priorityLabel: "High",
        state: { name: "In Progress", type: "started", color: "#f2c94c" },
        team: { name: "SalesPros" },
        project: { name: "Auth" },
        assignee: { displayName: "ada", avatarUrl: null },
        labels: [{ name: "bug", color: "#eb5757" }],
      });

      yield* provide(readLinearIssue({ identifier: "SP-123" }), client, store);
      expect(requests).toHaveLength(1);
      yield* provide(readLinearIssue({ identifier: "SP-123", refresh: true }), client, store);
      expect(requests).toHaveLength(2);
    });
  });

  it.effect("maps not-found, auth, and rate-limit responses onto reasons", () => {
    let mode: "missing" | "auth" | "rate" = "missing";
    const { client } = makeClient(() => {
      switch (mode) {
        case "missing":
          return { body: { data: { issue: null } } };
        case "auth":
          return { body: { errors: [{ message: "Invalid API key" }] }, status: 200 };
        case "rate":
          return { body: {}, status: 429, headers: { "retry-after": "30" } };
      }
    });
    const { store } = makeSecretStore({ [LINEAR_API_KEY_SECRET_NAME]: "lin_api_test" });
    return Effect.gen(function* () {
      const missing = yield* provide(readLinearIssue({ identifier: "SP-9" }), client, store).pipe(
        Effect.flip,
      );
      expect(missing.reason).toBe("not-found");
      mode = "auth";
      const auth = yield* provide(readLinearIssue({ identifier: "SP-10" }), client, store).pipe(
        Effect.flip,
      );
      expect(auth.reason).toBe("unauthenticated");
      mode = "rate";
      const rate = yield* provide(readLinearIssue({ identifier: "SP-11" }), client, store).pipe(
        Effect.flip,
      );
      expect(rate.reason).toBe("rate-limited");
      expect(rate.detail).toContain("30");
    });
  });

  it.effect("creating a comment invalidates only that issue's cached comment list", () => {
    let posted = false;
    const { client, requests } = makeClient(({ query, variables }) => {
      if (query.startsWith("query T3LinearIssue(")) return { body: issueBody };
      if (query.startsWith("mutation")) {
        posted = true;
        expect(variables).toEqual({ input: { issueId: "issue-uuid", body: "Looks good" } });
        return {
          body: {
            data: { commentCreate: { success: true, comment: comment("c2", "Looks good") } },
          },
        };
      }
      return {
        body: {
          data: {
            issue: {
              comments: {
                nodes: posted
                  ? [comment("c1", "First"), comment("c2", "Looks good")]
                  : [comment("c1", "First")],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      };
    });
    const { store } = makeSecretStore({ [LINEAR_API_KEY_SECRET_NAME]: "lin_api_test" });
    return Effect.gen(function* () {
      // The issue read is what maps the mutation's issue id back to an identifier.
      yield* provide(readLinearIssue({ identifier: "SP-123" }), client, store);
      const before = yield* provide(readLinearComments({ identifier: "SP-123" }), client, store);
      expect(before).toEqual({
        comments: [expect.objectContaining({ id: "c1" })],
        truncated: false,
      });
      yield* provide(readLinearComments({ identifier: "SP-999" }), client, store);
      yield* provide(readLinearComments({ identifier: "SP-123" }), client, store);
      expect(requests).toHaveLength(3);

      const created = yield* provide(
        createLinearComment({ issueId: "issue-uuid", body: "Looks good" }),
        client,
        store,
      );
      expect(created.id).toBe("c2");

      const after = yield* provide(readLinearComments({ identifier: "SP-123" }), client, store);
      expect(after.comments.map((entry) => entry.id)).toEqual(["c1", "c2"]);
      // SP-999 was not the issue commented on, so its list is still served from cache.
      yield* provide(readLinearComments({ identifier: "SP-999" }), client, store);
      expect(requests).toHaveLength(5);
    });
  });
});
