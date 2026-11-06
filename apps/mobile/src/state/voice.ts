import {
  createMessageSpeechSynthesisEnvironmentCommand,
  createMessageSpeechThreadAtomFamily,
} from "@t3tools/client-runtime/state/voice";

export {
  messageSpeechFailureDescription,
  messageSpeechFailureReasonFromError,
} from "@t3tools/client-runtime/state/voice";

import { connectionAtomRuntime } from "../connection/runtime";

export const synthesizeMessageSpeech =
  createMessageSpeechSynthesisEnvironmentCommand(connectionAtomRuntime);

export const messageSpeechThread = createMessageSpeechThreadAtomFamily(connectionAtomRuntime);
