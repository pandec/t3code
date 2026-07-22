import type { MessageSummaryRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  RemoteEnvironmentAuthFetchError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand } from "./runtime.ts";

const MESSAGE_SUMMARY_TIMEOUT_MS = 240_000;

export const summarizeMessage = Effect.fn("clientRuntime.messageArtifacts.summarizeMessage")(
  function* (request: MessageSummaryRequest) {
    const supervisor = yield* EnvironmentSupervisor;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) {
      return yield* new RemoteEnvironmentAuthFetchError({
        message: "The selected environment is not connected.",
        cause: "environment_not_connected",
      });
    }

    const requestUrl = environmentEndpointUrl(
      prepared.value.httpBaseUrl,
      "/api/messages/summaries",
    );
    const client = yield* makeEnvironmentHttpApiClient(prepared.value.httpBaseUrl);
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const headers = yield* buildEnvironmentAuthHeaders(
      prepared.value.httpAuthorization,
      "POST",
      requestUrl,
      signer,
    );
    return yield* executeEnvironmentHttpRequest(
      requestUrl,
      MESSAGE_SUMMARY_TIMEOUT_MS,
      withEnvironmentCredentials(
        prepared.value.httpAuthorization,
        client.voice.summarizeMessage({ payload: request, headers }),
      ),
    );
  },
);

export function createMessageSummaryEnvironmentCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-data:commands:message-artifacts:summarize",
    execute: (input: MessageSummaryRequest) => summarizeMessage(input),
    concurrency: { mode: "parallel" },
  });
}
