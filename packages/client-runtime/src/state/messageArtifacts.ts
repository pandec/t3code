import type {
  EnvironmentId,
  MessageId,
  MessageSpeechSynthesisResult,
  MessageSummaryRequest,
  MessageSummaryResult,
} from "@t3tools/contracts";
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

export interface MessageArtifactSessionSnapshot {
  readonly summary: MessageSummaryResult | null;
  readonly speech: MessageSpeechSynthesisResult | null;
}

const EMPTY_ARTIFACTS: MessageArtifactSessionSnapshot = { summary: null, speech: null };
const MAX_RETAINED_ARTIFACTS = 16;
const sessionArtifacts = new Map<string, MessageArtifactSessionSnapshot & { sourceText: string }>();
const sessionArtifactListeners = new Map<string, Set<() => void>>();
const pendingArtifactRequests = new Map<string, number>();
const retainedArtifactKeys = new Set<string>();
const artifactKey = (environmentId: EnvironmentId, messageId: MessageId) =>
  `${environmentId}\u0000${messageId}`;

function retainCompletedArtifact(key: string) {
  retainedArtifactKeys.delete(key);
  retainedArtifactKeys.add(key);
  if (retainedArtifactKeys.size <= MAX_RETAINED_ARTIFACTS) return;

  const oldestKey = retainedArtifactKeys.values().next().value;
  if (oldestKey === undefined) return;
  retainedArtifactKeys.delete(oldestKey);
  if (!pendingArtifactRequests.has(oldestKey) && !sessionArtifactListeners.has(oldestKey)) {
    sessionArtifacts.delete(oldestKey);
  }
}

export function beginMessageArtifactRequest(
  environmentId: EnvironmentId,
  messageId: MessageId,
): () => void {
  const key = artifactKey(environmentId, messageId);
  pendingArtifactRequests.set(key, (pendingArtifactRequests.get(key) ?? 0) + 1);
  retainedArtifactKeys.delete(key);

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;

    const remainingRequests = (pendingArtifactRequests.get(key) ?? 1) - 1;
    if (remainingRequests > 0) {
      pendingArtifactRequests.set(key, remainingRequests);
      return;
    }

    pendingArtifactRequests.delete(key);
    if (sessionArtifacts.has(key)) {
      retainCompletedArtifact(key);
    } else {
      retainedArtifactKeys.delete(key);
    }
  };
}

export function getMessageArtifactSessionSnapshot(
  environmentId: EnvironmentId,
  messageId: MessageId,
  sourceText: string,
): MessageArtifactSessionSnapshot {
  const current = sessionArtifacts.get(artifactKey(environmentId, messageId));
  return current?.sourceText === sourceText ? current : EMPTY_ARTIFACTS;
}

export function subscribeMessageArtifactSession(
  environmentId: EnvironmentId,
  messageId: MessageId,
  listener: () => void,
): () => void {
  const key = artifactKey(environmentId, messageId);
  const listeners = sessionArtifactListeners.get(key) ?? new Set();
  listeners.add(listener);
  sessionArtifactListeners.set(key, listeners);
  if (retainedArtifactKeys.delete(key)) retainedArtifactKeys.add(key);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && sessionArtifactListeners.get(key) === listeners) {
      sessionArtifactListeners.delete(key);
      if (!pendingArtifactRequests.has(key) && !retainedArtifactKeys.has(key)) {
        sessionArtifacts.delete(key);
      }
    }
  };
}

function updateMessageArtifactSession(
  environmentId: EnvironmentId,
  messageId: MessageId,
  sourceText: string,
  update: Partial<MessageArtifactSessionSnapshot>,
) {
  const key = artifactKey(environmentId, messageId);
  const listeners = sessionArtifactListeners.get(key);
  if (listeners === undefined && !pendingArtifactRequests.has(key)) return;

  const current = sessionArtifacts.get(key);
  sessionArtifacts.set(key, {
    sourceText,
    summary: current?.sourceText === sourceText ? current.summary : null,
    speech: current?.sourceText === sourceText ? current.speech : null,
    ...update,
  });
  for (const listener of listeners ?? []) listener();
}

export const rememberMessageSummary = (
  environmentId: EnvironmentId,
  sourceText: string,
  summary: MessageSummaryResult,
) => updateMessageArtifactSession(environmentId, summary.messageId, sourceText, { summary });

export const rememberMessageSpeech = (
  environmentId: EnvironmentId,
  sourceText: string,
  speech: MessageSpeechSynthesisResult,
) => updateMessageArtifactSession(environmentId, speech.messageId, sourceText, { speech });

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
        client.messageArtifacts.summarizeMessage({ payload: request, headers }),
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
