import {
  VOICE_TRANSCRIPTION_MAX_BYTES,
  VOICE_TRANSCRIPTION_MAX_DURATION_MS,
  VOICE_TRANSCRIPTION_MIN_DURATION_MS,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useSharedValue } from "react-native-reanimated";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VoiceInputController,
  VoiceTranscriptionError,
  VOICE_RECORDING_LIMIT_SECONDS,
  throwIfVoiceTranscriptionAborted,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceDraftSnapshot,
  type VoiceInputState,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { setListeningRecordingActive } from "../../state/listeningPlayback";
import { transcribeVoiceRecording } from "../../state/voice";
import { useAtomCommand } from "../../state/use-atom-command";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const VOICE_METERING_INTERVAL_MS = 80;
const VOICE_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

async function releaseVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Expo does not deactivate AVAudioSession when recording stops or its
    // category changes. Explicit deactivation resumes interrupted app audio.
    await setIsAudioActiveAsync(false);
  }
}

async function configureVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    try {
      await releaseVoiceRecordingAudio();
    } catch {
      // Keep the setup error. The controller has not started a recorder yet.
    }
    throw error;
  }
}

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly environmentTranscriptionAvailable: boolean;
  readonly draftMessage: string;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onCommitVoiceDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const transcribeInEnvironment = useAtomCommand(transcribeVoiceRecording, {
    reportFailure: false,
  });
  const [state, setState] = useState<VoiceInputState>(INITIAL_STATE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const usesEnvironmentTranscriberRef = useRef(false);
  const recordingDurationMsRef = useRef(0);
  const listeningRecordingOwnerRef = useRef(Symbol("mobile-voice-input"));
  const previousDraftRef = useRef({ ownerKey: input.ownerKey, text: input.draftMessage });
  const revisionRef = useRef(0);
  if (
    previousDraftRef.current.ownerKey !== input.ownerKey ||
    previousDraftRef.current.text !== input.draftMessage
  ) {
    previousDraftRef.current = { ownerKey: input.ownerKey, text: input.draftMessage };
    revisionRef.current += 1;
  }
  const latestInputRef = useRef(input);
  latestInputRef.current = input;

  const handleRecorderStatus = useCallback((status: RecordingStatus) => {
    controllerRef.current?.handleRecorderStatus({
      isFinished: status.isFinished,
      hasError: status.hasError || status.mediaServicesDidReset === true,
      error: status.error,
      url: status.url,
    });
  }, []);
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS, handleRecorderStatus);

  if (!controllerRef.current) {
    controllerRef.current = new VoiceInputController({
      recorder: {
        get uri() {
          return recorder.uri;
        },
        prepareToRecordAsync: () => recorder.prepareToRecordAsync(),
        record: ({ forDuration }) =>
          recorder.record({
            forDuration: usesEnvironmentTranscriberRef.current
              ? Math.min(forDuration, VOICE_TRANSCRIPTION_MAX_DURATION_MS / 1_000)
              : forDuration,
          }),
        stop: () => recorder.stop(),
      },
      getTranscriber: () => {
        const current = latestInputRef.current;
        const localTranscriber = getLocalVoiceTranscriber();
        const environmentTranscriber: VoiceTranscriber | null =
          current.environmentId && current.environmentTranscriptionAvailable
            ? {
                prepare: async ({ signal }) => {
                  throwIfVoiceTranscriptionAborted(signal);
                  const environmentId = current.environmentId;
                  if (!environmentId) {
                    throw new VoiceTranscriptionError(
                      "unavailable",
                      "The selected environment is no longer available.",
                    );
                  }
                  return {
                    locale: Intl.DateTimeFormat().resolvedOptions().locale,
                    transcribe: async (uri, options) => {
                      throwIfVoiceTranscriptionAborted(options.signal);
                      const durationMs = Math.min(
                        VOICE_TRANSCRIPTION_MAX_DURATION_MS,
                        recordingDurationMsRef.current,
                      );
                      if (durationMs < VOICE_TRANSCRIPTION_MIN_DURATION_MS) {
                        throw new VoiceTranscriptionError(
                          "transcription-failed",
                          "The recording was too short to transcribe.",
                        );
                      }

                      const file = new File(uri);
                      const sizeBytes = file.size ?? 0;
                      if (sizeBytes <= 0 || sizeBytes > VOICE_TRANSCRIPTION_MAX_BYTES) {
                        throw new VoiceTranscriptionError(
                          "transcription-failed",
                          "The recording was empty or too large to transcribe.",
                        );
                      }
                      const dataUrl = `data:audio/mp4;base64,${await file.base64()}`;
                      throwIfVoiceTranscriptionAborted(options.signal);
                      const result = await transcribeInEnvironment({
                        environmentId,
                        input: { mimeType: "audio/mp4", dataUrl, durationMs, sizeBytes },
                      });
                      throwIfVoiceTranscriptionAborted(options.signal);
                      if (result._tag === "Success") return result.value.text;
                      throw new VoiceTranscriptionError(
                        "transcription-failed",
                        "Environment voice transcription failed.",
                      );
                    },
                  };
                },
              }
            : null;

        usesEnvironmentTranscriberRef.current = localTranscriber === null;
        if (!localTranscriber) return environmentTranscriber;
        if (!environmentTranscriber) return localTranscriber;
        return {
          prepare: async (options) => {
            try {
              const prepared = await localTranscriber.prepare(options);
              usesEnvironmentTranscriberRef.current = false;
              return prepared;
            } catch {
              throwIfVoiceTranscriptionAborted(options.signal);
              usesEnvironmentTranscriberRef.current = true;
              return environmentTranscriber.prepare(options);
            }
          },
        };
      },
      requestPermission: async () => {
        const permission = await requestRecordingPermissionsAsync();
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      },
      configureRecording: async () => {
        recordingDurationMsRef.current = 0;
        setListeningRecordingActive(listeningRecordingOwnerRef.current, true);
        try {
          await configureVoiceRecordingAudio();
        } catch (error) {
          setListeningRecordingActive(listeningRecordingOwnerRef.current, false);
          throw error;
        }
      },
      releaseRecording: async () => {
        try {
          await releaseVoiceRecordingAudio();
        } finally {
          setListeningRecordingActive(listeningRecordingOwnerRef.current, false);
        }
      },
      deleteRecording: (uri) => new File(uri).delete(),
      readDraft: (): VoiceDraftSnapshot | null => {
        const current = latestInputRef.current;
        if (!current.ownerKey) return null;
        return {
          ownerKey: current.ownerKey,
          text: current.draftMessage,
          selection: current.selection,
          revision: revisionRef.current,
        };
      },
      commitDraft: (text, selection) => {
        const current = latestInputRef.current;
        current.onChangeSelection(selection);
        current.onCommitVoiceDraftMessage(text);
      },
      onStateChange: setState,
    });
  }

  const controller = controllerRef.current;
  const previousOwnerRef = useRef(input.ownerKey);
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey) return;
    previousOwnerRef.current = input.ownerKey;
    controller.ownerChanged();
  }, [controller, input.ownerKey]);

  useFocusEffect(
    useCallback(
      () => () => {
        controller.dispose();
      },
      [controller],
    ),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS reports `inactive` while its permission dialog is open. Only the
      // real background state cancels preparation; recorder status handles
      // calls and route interruptions during capture.
      if (nextState === "background") controller.appMovedToBackground();
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    if (state.phase !== "preparing" && state.phase !== "recording") return;

    if (audioLevelsRef.current.some((level) => level !== 0)) {
      audioLevelsRef.current = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
      audioLevels.value = audioLevelsRef.current;
    }
    if (elapsedSecondsRef.current !== 0) {
      elapsedSecondsRef.current = 0;
      setElapsedSeconds(0);
    }
    if (state.phase !== "recording") return;

    const sampleRecording = () => {
      if (controller.currentState.phase !== "recording") return;
      const status = recorder.getStatus();
      if (!status.isRecording) return;
      recordingDurationMsRef.current = Math.max(0, Math.round(status.durationMillis));

      const level = normalizeVoiceInputDecibels(status.metering);
      const history = audioLevelsRef.current;
      if (level !== 0 || history.some((sample) => sample !== 0)) {
        const nextLevels = [...history.slice(1), level];
        audioLevelsRef.current = nextLevels;
        audioLevels.value = nextLevels;
      }

      const recordingLimitSeconds = usesEnvironmentTranscriberRef.current
        ? VOICE_TRANSCRIPTION_MAX_DURATION_MS / 1_000
        : VOICE_RECORDING_LIMIT_SECONDS;
      const nextElapsedSeconds = Math.min(
        recordingLimitSeconds,
        Math.max(0, Math.floor(status.durationMillis / 1_000)),
      );
      if (nextElapsedSeconds !== elapsedSecondsRef.current) {
        elapsedSecondsRef.current = nextElapsedSeconds;
        setElapsedSeconds(nextElapsedSeconds);
      }
    };

    sampleRecording();
    const intervalId = setInterval(sampleRecording, VOICE_METERING_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [audioLevels, controller, recorder, state.phase]);

  const start = useCallback(() => {
    if (!latestInputRef.current.disabled) void controller.start();
  }, [controller]);
  const stop = useCallback(() => controller.stop(), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);

  return {
    // Store screenshots show the dictation button even on simulators, whose
    // on-device transcription is unavailable.
    isAvailable:
      getLocalVoiceTranscriber() !== null ||
      (input.environmentId !== null && input.environmentTranscriptionAvailable) ||
      getNativeShowcaseScene() !== null,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    blocksSubmission: voiceInputBlocksSubmission(state),
    start,
    stop,
    cancel,
  };
}
