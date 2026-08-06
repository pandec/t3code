import {
  AuthSessionId,
  EnvironmentAuthenticatedPrincipal,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { getThreadMessagesHttp } from "./http.ts";

const threadId = ThreadId.make("thread-http-messages");

const messagePage = {
  threadId,
  messages: [],
  hasMoreOlder: false,
  snapshotSequence: 1,
};

const principalLayer = (scopes: ReadonlyArray<"orchestration:read">) =>
  Layer.succeed(EnvironmentAuthenticatedPrincipal, {
    sessionId: AuthSessionId.make("session-orchestration-http"),
    subject: "cli-test",
    method: "bearer-access-token",
    scopes: new Set(scopes),
  });

const projectionSnapshotQueryLayer = (
  getThreadMessagePage: ProjectionSnapshotQuery["Service"]["getThreadMessagePage"],
) => Layer.mock(ProjectionSnapshotQuery)({ getThreadMessagePage });

it.effect("getThreadMessagesHttp requires the orchestration read scope", () =>
  Effect.gen(function* () {
    const forbidden = yield* getThreadMessagesHttp({ threadId }, {}).pipe(
      Effect.provide(
        Layer.merge(
          projectionSnapshotQueryLayer(() => Effect.succeed(Option.some(messagePage))),
          principalLayer([]),
        ),
      ),
      Effect.flip,
    );

    expect(forbidden).toMatchObject({
      _tag: "EnvironmentScopeRequiredError",
      requiredScope: "orchestration:read",
    });
  }),
);

it.effect("getThreadMessagesHttp returns thread_not_found for a missing or deleted thread", () =>
  Effect.gen(function* () {
    const notFound = yield* getThreadMessagesHttp({ threadId }, {}).pipe(
      Effect.provide(
        Layer.merge(
          projectionSnapshotQueryLayer(() => Effect.succeed(Option.none())),
          principalLayer(["orchestration:read"]),
        ),
      ),
      Effect.flip,
    );

    expect(notFound).toMatchObject({
      _tag: "EnvironmentResourceNotFoundError",
      reason: "thread_not_found",
    });
  }),
);

it.effect("getThreadMessagesHttp returns the bounded page from ProjectionSnapshotQuery", () =>
  Effect.gen(function* () {
    const calls: Array<{
      readonly threadId: ThreadId;
      readonly before: MessageId | undefined;
      readonly limit: number | undefined;
    }> = [];

    const page = yield* getThreadMessagesHttp(
      { threadId },
      { before: MessageId.make("message-cursor"), limit: 10 },
    ).pipe(
      Effect.provide(
        Layer.merge(
          projectionSnapshotQueryLayer((requestedThreadId, options) => {
            calls.push({
              threadId: requestedThreadId,
              before: options.before,
              limit: options.limit,
            });
            return Effect.succeed(Option.some(messagePage));
          }),
          principalLayer(["orchestration:read"]),
        ),
      ),
    );

    expect(page).toEqual(messagePage);
    expect(calls).toEqual([{ threadId, before: MessageId.make("message-cursor"), limit: 10 }]);
  }),
);
