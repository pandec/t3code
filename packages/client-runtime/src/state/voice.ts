import {
  type MessageId,
  type MessageSpeechFailureReason,
  type MessageSpeechSynthesisRequest,
  type MessageSpeechSynthesisResult,
  type MessageSpeechThreadState,
  type MessageSpeechThreadUpdate,
  type MessageSummaryResult,
  type MessageSummaryThreadEntry,
  type VoiceTranscriptionRequest,
  WS_METHODS,
} from "@t3tools/contracts";
import { messageArtifactTextHash } from "@t3tools/shared/messageArtifactIdentity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/http";
import type { Atom } from "effect/reactivity";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

const VOICE_TRANSCRIPTION_TIMEOUT_MS = 75_000;
// Longer than the server's job timeout, so the server always answers first.
const MESSAGE_SPEECH_SYNTHESIS_TIMEOUT_MS = 330_000;
const MESSAGE_SPEECH_THREAD_IDLE_TTL_MS = 30_000;

export const messageSpeechFailureDescription = (
  reason: MessageSpeechFailureReason | undefined,
): string => {
  switch (reason) {
    case "source_too_long":
      return "This message is too long to prepare as audio.";
    case "message_unavailable":
      return "This message changed before audio was ready. Try again.";
    case "provider_quota_exceeded":
      return "The server's speech provider is out of quota or credits. Top it up or wait for the reset.";
    default:
      return "T3 Code could not prepare audio for this message. Try again in a moment.";
  }
};

/**
 * The speech failure behind a failed listening request, read from the
 * server's typed error; undefined for transport errors and anything else.
 */
export const messageSpeechFailureReasonFromError = (
  error: unknown,
): MessageSpeechFailureReason | undefined => {
  if (typeof error !== "object" || error === null || !("reason" in error)) return undefined;
  switch (error.reason) {
    case "speech_unavailable":
      return "unavailable";
    case "speech_message_unavailable":
      return "message_unavailable";
    case "speech_source_too_long":
      return "source_too_long";
    case "speech_script_failed":
      return "script_failed";
    case "speech_provider_failed":
      return "provider_failed";
    case "speech_provider_quota_exceeded":
      return "provider_quota_exceeded";
    default:
      return undefined;
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
      group: "voice",
      prepared: prepared.value,
      signer,
      remoteAuthorization,
      method: "POST",
      url: (urls) => urls.transcribe(),
      timeoutMs: VOICE_TRANSCRIPTION_TIMEOUT_MS,
      request: ({ client, headers }) => client.transcribe({ payload: request, headers }),
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

/**
 * Starts (or joins) the server-owned listening job for an assistant message
 * and waits for its recording. Leaving does not cancel the job; the thread's
 * listening state shows it to every client until it finishes.
 */
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
      group: "voice",
      prepared: prepared.value,
      signer,
      remoteAuthorization,
      method: "POST",
      url: (urls) => urls.synthesizeMessage(),
      timeoutMs: MESSAGE_SPEECH_SYNTHESIS_TIMEOUT_MS,
      request: ({ client, headers }) => client.synthesizeMessage({ payload: request, headers }),
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

/** A thread's listening state, indexed for per-message lookups. */
export interface MessageSpeechThreadView {
  readonly recordings: ReadonlyMap<MessageId, MessageSpeechSynthesisResult>;
  readonly pending: ReadonlySet<MessageId>;
  readonly summaries: ReadonlyMap<MessageId, MessageSummaryThreadEntry>;
}

export const toMessageSpeechThreadView = (
  state: MessageSpeechThreadState,
): MessageSpeechThreadView => ({
  recordings: new Map(state.recordings.map((recording) => [recording.messageId, recording])),
  pending: new Set(state.pendingMessageIds),
  summaries: new Map(state.summaries.map((summary) => [summary.messageId, summary])),
});

const withEntry = <V>(map: ReadonlyMap<MessageId, V>, messageId: MessageId, value?: V) => {
  const next = new Map(map);
  if (value === undefined) next.delete(messageId);
  else next.set(messageId, value);
  return next;
};

/**
 * Folds one streamed update into the view: a snapshot replaces it, a message
 * update replaces that message's entries. Null until the first snapshot.
 */
export const applyMessageSpeechThreadUpdate = (
  view: MessageSpeechThreadView | null,
  update: MessageSpeechThreadUpdate,
): MessageSpeechThreadView | null => {
  if (update.type === "snapshot") return toMessageSpeechThreadView(update.state);
  if (view === null) return null;
  const pending = new Set(view.pending);
  if (update.pending) pending.add(update.messageId);
  else pending.delete(update.messageId);
  return {
    recordings: withEntry(view.recordings, update.messageId, update.recording),
    pending,
    summaries: withEntry(view.summaries, update.messageId, update.summary),
  };
};

/**
 * The message's stored summary from the thread state, only while it still
 * summarizes `text` (the message text the client shows now).
 */
export const currentThreadMessageSummary = (
  view: MessageSpeechThreadView | null | undefined,
  messageId: MessageId,
  text: string,
): MessageSummaryResult | null => {
  const entry = view?.summaries.get(messageId);
  if (entry === undefined || entry.sourceTextHash !== messageArtifactTextHash(text.trim())) {
    return null;
  }
  return { messageId: entry.messageId, summary: entry.summary, createdAt: entry.createdAt };
};

/**
 * Live listening state per thread, shared by every row of the thread: one
 * subscription per open thread, kept briefly after the last reader leaves.
 */
export function createMessageSpeechThreadAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:voice:message-speech",
    tag: WS_METHODS.voiceSubscribeMessageSpeech,
    idleTtlMs: MESSAGE_SPEECH_THREAD_IDLE_TTL_MS,
    // Every (re)subscription starts with a snapshot, so the fold cannot fall behind.
    transform: (stream) =>
      stream.pipe(
        Stream.mapAccum(
          (): MessageSpeechThreadView | null => null,
          (view, update) => {
            const next = applyMessageSpeechThreadUpdate(view, update);
            return next === null ? [view, []] : [next, [next]];
          },
        ),
      ),
  });
}
