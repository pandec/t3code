import type { MessageId, OrchestrationThreadMessagePage, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { type RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const DEFAULT_THREAD_MESSAGES_TIMEOUT_MS = 6_000;

export const fetchEnvironmentThreadMessagePage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadMessagePage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly before?: MessageId;
  readonly limit: number;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  const query = new URLSearchParams({ limit: String(input.limit) });
  if (input.before !== undefined) query.set("before", input.before);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    method: "GET",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(
        httpBaseUrl,
        `/api/orchestration/threads/${input.threadId}/messages?${query.toString()}`,
      ),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_MESSAGES_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.orchestration.threadMessages({
        params: { threadId: input.threadId },
        query: {
          limit: input.limit,
          ...(input.before === undefined ? {} : { before: input.before }),
        },
        headers,
      }),
  });
});

export type FetchEnvironmentThreadMessagePageError = RemoteEnvironmentRequestError;

export class ThreadMessagePageLoader extends Context.Service<
  ThreadMessagePageLoader,
  {
    readonly loadOlder: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      options: {
        readonly beforeMessageId: MessageId | null;
        readonly limit: number;
      },
    ) => Effect.Effect<Option.Option<OrchestrationThreadMessagePage>>;
  }
>()("@t3tools/client-runtime/state/threadMessagesHttp/ThreadMessagePageLoader") {}

export const threadMessagePageLoaderLayer: Layer.Layer<
  ThreadMessagePageLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ThreadMessagePageLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return ThreadMessagePageLoader.of({
      loadOlder: (prepared, threadId, options) =>
        fetchEnvironmentThreadMessagePage({
          prepared,
          threadId,
          limit: options.limit,
          ...(options.beforeMessageId === null ? {} : { before: options.beforeMessageId }),
          signer,
          remoteAuthorization,
        }).pipe(
          Effect.map(Option.some<OrchestrationThreadMessagePage>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchTags({
            EnvironmentResourceNotFoundError: () =>
              Effect.logDebug("Thread message page not found.").pipe(
                Effect.annotateLogs({ threadId }),
                Effect.as(Option.none<OrchestrationThreadMessagePage>()),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not load older thread messages.").pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as(Option.none<OrchestrationThreadMessagePage>()),
            ),
          ),
        ),
    });
  }),
);
