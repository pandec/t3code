import type { MessageSpeechSynthesisRequest, VoiceTranscriptionRequest } from "@t3tools/contracts";
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

const VOICE_TRANSCRIPTION_TIMEOUT_MS = 75_000;
const MESSAGE_SPEECH_SYNTHESIS_TIMEOUT_MS = 330_000;

export const transcribeVoiceRecording = Effect.fn("clientRuntime.voice.transcribeVoiceRecording")(
  function* (request: VoiceTranscriptionRequest) {
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
      "/api/voice/transcriptions",
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
      VOICE_TRANSCRIPTION_TIMEOUT_MS,
      withEnvironmentCredentials(
        prepared.value.httpAuthorization,
        client.voice.transcribe({ payload: request, headers }),
      ),
    );
  },
);

export function createVoiceTranscriptionEnvironmentCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-data:commands:voice:transcribe",
    execute: (input: VoiceTranscriptionRequest) => transcribeVoiceRecording(input),
    concurrency: { mode: "parallel" },
  });
}

export const synthesizeMessageSpeech = Effect.fn("clientRuntime.voice.synthesizeMessageSpeech")(
  function* (request: MessageSpeechSynthesisRequest) {
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
      "/api/voice/message-speech",
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
      MESSAGE_SPEECH_SYNTHESIS_TIMEOUT_MS,
      withEnvironmentCredentials(
        prepared.value.httpAuthorization,
        client.voice.synthesizeMessage({ payload: request, headers }),
      ),
    );
  },
);

export function createMessageSpeechSynthesisEnvironmentCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-data:commands:voice:synthesize-message",
    execute: (input: MessageSpeechSynthesisRequest) => synthesizeMessageSpeech(input),
    concurrency: { mode: "parallel" },
  });
}
