import type {
  MessageSpeechFailureReason,
  MessageSpeechSynthesisRequest,
  VoiceTranscriptionRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import type { Atom } from "effect/unstable/reactivity";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand } from "./runtime.ts";

const VOICE_TRANSCRIPTION_TIMEOUT_MS = 75_000;
const MESSAGE_SPEECH_SYNTHESIS_TIMEOUT_MS = 330_000;

export const messageSpeechFailureDescription = (
  reason: MessageSpeechFailureReason | undefined,
): string => {
  switch (reason) {
    case "source_too_long":
      return "This message is too long to prepare as audio.";
    case "message_unavailable":
      return "This message changed before audio was ready. Try again.";
    case "provider_quota_exceeded":
      return "The server's ElevenLabs character quota is used up. Add credits or wait for the monthly reset.";
    default:
      return "T3 Code could not prepare audio for this message. Try again in a moment.";
  }
};

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

    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: prepared.value,
      signer,
      remoteAuthorization,
      method: "POST",
      url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/voice/transcriptions"),
      timeoutMs: VOICE_TRANSCRIPTION_TIMEOUT_MS,
      request: ({ client, headers }) => client.voice.transcribe({ payload: request, headers }),
    });
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

    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: prepared.value,
      signer,
      remoteAuthorization,
      method: "POST",
      url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/voice/message-speech"),
      timeoutMs: MESSAGE_SPEECH_SYNTHESIS_TIMEOUT_MS,
      request: ({ client, headers }) =>
        client.voice.synthesizeMessage({ payload: request, headers }),
    });
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
