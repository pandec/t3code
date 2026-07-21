import {
  createMessageSpeechSynthesisEnvironmentCommand,
  createVoiceTranscriptionEnvironmentCommand,
} from "@t3tools/client-runtime/state/voice";

import { connectionAtomRuntime } from "../connection/runtime";

export const transcribeVoiceRecording =
  createVoiceTranscriptionEnvironmentCommand(connectionAtomRuntime);

export const synthesizeMessageSpeech =
  createMessageSpeechSynthesisEnvironmentCommand(connectionAtomRuntime);
