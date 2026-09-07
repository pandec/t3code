/**
 * Linear issue reader and comment writer.
 *
 * One personal API key per environment, stored in the server's secret store,
 * used against Linear's GraphQL endpoint. Personal keys go in the
 * `Authorization` header bare (no `Bearer`). The browser never sees the key.
 *
 * Caches are process-wide like `openRouterCredits.ts`: the WS handler layer is
 * built per connection, so a per-layer cache would re-read for every client.
 * Concurrent misses on one key are not coalesced; the minute-long entries make
 * that a rare double read, not a rate-limit risk.
 */
import type {
  LinearComment,
  LinearCommentsInput,
  LinearCommentsResult,
  LinearCreateCommentInput,
  LinearIssue,
  LinearIssueInput,
  LinearStatus,
} from "@t3tools/contracts";
import { LinearRpcError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const LINEAR_API_KEY_SECRET_NAME = "linear-api-key";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT = "15 seconds";
const COMMENTS_PAGE_SIZE = 100;

const USER_FIELDS = "name displayName avatarUrl";
// Only what the panel renders. Every field here is decoded strictly, so an unused one is a way
// for a Linear schema change to reject the whole issue for nothing.
const ISSUE_FIELDS = `
  id identifier url title description priorityLabel createdAt updatedAt dueDate
  state { name type color }
  team { name }
  project { name }
  assignee { ${USER_FIELDS} }
  creator { ${USER_FIELDS} }
  labels { nodes { name color } }
`;
const COMMENT_FIELDS = `id body createdAt user { ${USER_FIELDS} } botActor { name avatarUrl }`;

const STATUS_QUERY = `query T3LinearStatus {
  viewer { name displayName }
  organization { name urlKey }
  teams(first: 250) { nodes { key } }
}`;
const ISSUE_QUERY = `query T3LinearIssue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`;
const COMMENTS_QUERY = `query T3LinearIssueComments($id: String!, $first: Int!) {
  issue(id: $id) {
    comments(first: $first, orderBy: createdAt) {
      nodes { ${COMMENT_FIELDS} }
      pageInfo { hasNextPage }
    }
  }
}`;
const COMMENT_CREATE_MUTATION = `mutation T3LinearCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { ${COMMENT_FIELDS} } }
}`;

const User = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});
const IssueBody = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  url: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  priorityLabel: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  dueDate: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.Struct({ name: Schema.String, type: Schema.String, color: Schema.String }),
  team: Schema.Struct({ name: Schema.String }),
  project: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
  assignee: Schema.optional(Schema.NullOr(User)),
  creator: Schema.optional(Schema.NullOr(User)),
  labels: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.String })),
  }),
});
const CommentBody = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  user: Schema.optional(Schema.NullOr(User)),
  botActor: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.String,
        avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const GraphqlErrors = {
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
};
const StatusEnvelope = Schema.Struct({
  ...GraphqlErrors,
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        viewer: Schema.Struct({ name: Schema.String, displayName: Schema.String }),
        organization: Schema.Struct({ name: Schema.String, urlKey: Schema.String }),
        teams: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ key: Schema.String })) }),
      }),
    ),
  ),
});
const IssueEnvelope = Schema.Struct({
  ...GraphqlErrors,
  data: Schema.optional(Schema.NullOr(Schema.Struct({ issue: Schema.NullOr(IssueBody) }))),
});
const CommentsEnvelope = Schema.Struct({
  ...GraphqlErrors,
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        issue: Schema.NullOr(
          Schema.Struct({
            comments: Schema.Struct({
              nodes: Schema.Array(CommentBody),
              pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
            }),
          }),
        ),
      }),
    ),
  ),
});
const CommentCreateEnvelope = Schema.Struct({
  ...GraphqlErrors,
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        commentCreate: Schema.Struct({
          success: Schema.Boolean,
          comment: Schema.optional(Schema.NullOr(CommentBody)),
        }),
      }),
    ),
  ),
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface CacheEntry<T> {
  readonly apiKey: string;
  readonly value: T;
  readonly atMs: number;
}

let statusCache: CacheEntry<LinearStatus> | null = null;
const issueCache = new Map<string, CacheEntry<LinearIssue>>();
const commentsCache = new Map<string, CacheEntry<LinearCommentsResult>>();
const requestGate = Semaphore.makeUnsafe(4);

/** Drop every cached read. Called when the API key changes, and by tests between cases. */
export function clearLinearCache(): void {
  statusCache = null;
  issueCache.clear();
  commentsCache.clear();
}

/**
 * Drop entries past their TTL so the maps stay bounded by what was read in the last minute
 * rather than by everything ever hovered over the server's lifetime.
 */
function evictExpired(now: number): void {
  for (const cache of [issueCache, commentsCache]) {
    for (const [key, entry] of cache) {
      if (now - entry.atMs >= CACHE_TTL_MS) cache.delete(key);
    }
  }
}

type Services = HttpClient.HttpClient | ServerSecretStore.ServerSecretStore;

const fail = (reason: LinearRpcError["reason"], detail: string) =>
  Effect.fail(new LinearRpcError({ reason, detail }));

const isLinearRpcError = Schema.is(LinearRpcError);
const isAuthMessage = (message: string) => /auth|api key|access token/i.test(message);
const isNotFoundMessage = (message: string) => /not found|could not find/i.test(message);

const graphql = <S extends Schema.Codec<unknown, unknown, never, never>>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  schema: S,
): Effect.Effect<S["Type"], LinearRpcError, HttpClient.HttpClient> =>
  requestGate.withPermits(1)(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(LINEAR_GRAPHQL_URL).pipe(
          HttpClientRequest.setHeader("Authorization", apiKey),
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe({ query, variables }),
        ),
      );
      if (response.status === 401 || response.status === 403) {
        return yield* fail("unauthenticated", "Linear rejected the API key.");
      }
      if (response.status === 429) {
        const retryAfter = response.headers["retry-after"];
        return yield* fail(
          "rate-limited",
          retryAfter === undefined
            ? "Linear rate limit reached. Try again shortly."
            : `Linear rate limit reached. Retry after ${retryAfter}s.`,
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* fail("failed", `Linear answered with status ${response.status}.`);
      }
      const envelope = yield* response.text.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
        Effect.mapError(
          () =>
            new LinearRpcError({
              reason: "failed",
              detail: "Linear answered with an unexpected payload.",
            }),
        ),
      );
      const message = (envelope as { errors?: ReadonlyArray<{ message: string }> }).errors?.[0]
        ?.message;
      if (message !== undefined) {
        return yield* fail(
          isAuthMessage(message)
            ? "unauthenticated"
            : isNotFoundMessage(message)
              ? "not-found"
              : "failed",
          message,
        );
      }
      return envelope;
    }).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchCause((cause) => {
        const squashed = Cause.squash(cause);
        if (isLinearRpcError(squashed)) return Effect.fail(squashed);
        return fail(
          "failed",
          Cause.isTimeoutError(squashed)
            ? "The Linear request timed out."
            : "Could not reach Linear.",
        );
      }),
    ),
  );

const toUser = (user: typeof User.Type | null | undefined) =>
  user === null || user === undefined
    ? null
    : { name: user.name, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null };

const toIssue = (issue: typeof IssueBody.Type): LinearIssue => ({
  id: issue.id,
  identifier: issue.identifier,
  url: issue.url,
  title: issue.title,
  description: issue.description ?? null,
  priorityLabel: issue.priorityLabel,
  state: issue.state,
  team: issue.team,
  project: issue.project ?? null,
  assignee: toUser(issue.assignee),
  creator: toUser(issue.creator),
  labels: issue.labels.nodes,
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  dueDate: issue.dueDate ?? null,
});

const toComment = (comment: typeof CommentBody.Type): LinearComment => ({
  id: comment.id,
  body: comment.body,
  createdAt: comment.createdAt,
  user: toUser(comment.user),
  botActor:
    comment.botActor === null || comment.botActor === undefined
      ? null
      : { name: comment.botActor.name, avatarUrl: comment.botActor.avatarUrl ?? null },
});

const probeStatus = (
  apiKey: string,
): Effect.Effect<LinearStatus, LinearRpcError, HttpClient.HttpClient> =>
  graphql(apiKey, STATUS_QUERY, {}, StatusEnvelope).pipe(
    Effect.flatMap((envelope) => {
      const data = envelope.data;
      if (data === null || data === undefined) {
        return fail("failed", "Linear answered with an unexpected payload.");
      }
      return Effect.succeed<LinearStatus>({
        configured: true,
        viewer: { name: data.viewer.name, displayName: data.viewer.displayName },
        workspace: { name: data.organization.name, urlKey: data.organization.urlKey },
        teamKeys: data.teams.nodes.map((team) => team.key).sort(),
      });
    }),
  );

/** The stored key, or `none` when unconfigured. Store failures surface as `failed`. */
const readApiKey: Effect.Effect<
  Option.Option<string>,
  LinearRpcError,
  ServerSecretStore.ServerSecretStore
> = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const stored = yield* secretStore.get(LINEAR_API_KEY_SECRET_NAME).pipe(
    Effect.mapError(
      () =>
        new LinearRpcError({
          reason: "failed",
          detail: "Could not read the stored Linear API key.",
        }),
    ),
  );
  if (Option.isNone(stored)) return Option.none();
  const apiKey = textDecoder.decode(stored.value).trim();
  return apiKey.length === 0 ? Option.none() : Option.some(apiKey);
});

const requireApiKey = readApiKey.pipe(
  Effect.flatMap((key) =>
    Option.isSome(key)
      ? Effect.succeed(key.value)
      : fail("unconfigured", "No Linear API key is configured."),
  ),
);

const isFresh = (entry: CacheEntry<unknown> | undefined, apiKey: string, now: number) =>
  entry !== undefined &&
  entry.apiKey === apiKey &&
  now - entry.atMs >= 0 &&
  now - entry.atMs < CACHE_TTL_MS;

/**
 * Connection status. Never fails: a missing key, a rejected key, or an
 * unreachable endpoint all land in the result for the settings panel.
 */
export const readLinearStatus: Effect.Effect<LinearStatus, never, Services> = Effect.gen(
  function* () {
    const key = yield* readApiKey;
    if (Option.isNone(key))
      return { configured: false, viewer: null, workspace: null, teamKeys: [] };
    const apiKey = key.value;
    const now = yield* Clock.currentTimeMillis;
    if (statusCache !== null && isFresh(statusCache, apiKey, now)) return statusCache.value;
    const status = yield* probeStatus(apiKey);
    statusCache = { apiKey, value: status, atMs: now };
    return status;
  },
).pipe(
  Effect.catch((error: LinearRpcError) =>
    Effect.succeed<LinearStatus>({
      configured: error.reason !== "unconfigured",
      viewer: null,
      workspace: null,
      teamKeys: [],
      error: error.detail,
    }),
  ),
);

/**
 * Store or clear the environment's Linear API key. An empty key removes the
 * stored secret. A non-empty key is probed first and only stored when Linear
 * accepts it, so a typo never replaces a working key.
 */
export const configureLinear = (
  apiKey: string,
): Effect.Effect<LinearStatus, LinearRpcError, Services> =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const trimmed = apiKey.trim();
    const storeFailure = (detail: string) => () => new LinearRpcError({ reason: "failed", detail });
    if (trimmed.length === 0) {
      yield* secretStore
        .remove(LINEAR_API_KEY_SECRET_NAME)
        .pipe(Effect.mapError(storeFailure("Could not remove the stored Linear API key.")));
      clearLinearCache();
      return { configured: false, viewer: null, workspace: null, teamKeys: [] };
    }
    const status = yield* probeStatus(trimmed);
    yield* secretStore
      .set(LINEAR_API_KEY_SECRET_NAME, textEncoder.encode(trimmed))
      .pipe(Effect.mapError(storeFailure("Could not store the Linear API key.")));
    clearLinearCache();
    statusCache = { apiKey: trimmed, value: status, atMs: yield* Clock.currentTimeMillis };
    return status;
  });

const normalizeIdentifier = (identifier: string) => identifier.trim().toUpperCase();

export const readLinearIssue = (
  input: LinearIssueInput,
): Effect.Effect<LinearIssue, LinearRpcError, Services> =>
  Effect.gen(function* () {
    const apiKey = yield* requireApiKey;
    const identifier = normalizeIdentifier(input.identifier);
    const now = yield* Clock.currentTimeMillis;
    const cached = issueCache.get(identifier);
    if (input.refresh !== true && isFresh(cached, apiKey, now)) return cached!.value;
    evictExpired(now);
    const envelope = yield* graphql(apiKey, ISSUE_QUERY, { id: identifier }, IssueEnvelope);
    const issue = envelope.data?.issue ?? null;
    if (issue === null)
      return yield* fail("not-found", `Linear issue ${identifier} was not found.`);
    const value = toIssue(issue);
    issueCache.set(identifier, { apiKey, value, atMs: now });
    return value;
  });

export const readLinearComments = (
  input: LinearCommentsInput,
): Effect.Effect<LinearCommentsResult, LinearRpcError, Services> =>
  Effect.gen(function* () {
    const apiKey = yield* requireApiKey;
    const identifier = normalizeIdentifier(input.identifier);
    const now = yield* Clock.currentTimeMillis;
    const cached = commentsCache.get(identifier);
    if (input.refresh !== true && isFresh(cached, apiKey, now)) return cached!.value;
    evictExpired(now);
    const envelope = yield* graphql(
      apiKey,
      COMMENTS_QUERY,
      { id: identifier, first: COMMENTS_PAGE_SIZE },
      CommentsEnvelope,
    );
    const issue = envelope.data?.issue ?? null;
    if (issue === null)
      return yield* fail("not-found", `Linear issue ${identifier} was not found.`);
    const value: LinearCommentsResult = {
      comments: issue.comments.nodes.map(toComment),
      truncated: issue.comments.pageInfo.hasNextPage,
    };
    commentsCache.set(identifier, { apiKey, value, atMs: now });
    return value;
  });

/**
 * Post a comment. Drops the cached comment list of the issue it landed on so the caller's
 * re-read sees it; the mutation names the issue by id, so the cached issue reads map it back to
 * an identifier, and when none does there is nothing stale to drop.
 */
export const createLinearComment = (
  input: LinearCreateCommentInput,
): Effect.Effect<LinearComment, LinearRpcError, Services> =>
  Effect.gen(function* () {
    const apiKey = yield* requireApiKey;
    const envelope = yield* graphql(
      apiKey,
      COMMENT_CREATE_MUTATION,
      { input: { issueId: input.issueId, body: input.body } },
      CommentCreateEnvelope,
    );
    const result = envelope.data?.commentCreate;
    const comment = result?.comment ?? null;
    if (result === undefined || !result.success || comment === null) {
      return yield* fail("failed", "Linear did not create the comment.");
    }
    for (const [identifier, entry] of issueCache) {
      if (entry.value.id === input.issueId) commentsCache.delete(identifier);
    }
    return toComment(comment);
  });
