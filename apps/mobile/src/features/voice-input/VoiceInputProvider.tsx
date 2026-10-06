import {
  VOICE_TRANSCRIPTION_MAX_BYTES,
  VOICE_TRANSCRIPTION_MAX_DURATION_MS,
  VOICE_TRANSCRIPTION_MIN_DURATION_MS,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type RecorderState,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import { useSharedValue } from "react-native-reanimated";

import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  voiceInputBlocksSubmission,
  type VoiceInputState,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { setListeningRecordingActive } from "../../state/listeningPlayback";
import { useAtomCommand } from "../../state/use-atom-command";
import { transcribeVoiceRecording } from "../../state/voice";
import { createLazyVoiceRecorder, type LazyVoiceRecorder } from "./lazyVoiceRecorder";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const VOICE_METERING_INTERVAL_MS = 80;
// The native constructor takes platform-flattened options, as `useAudioRecorder`
// builds them with expo-audio's internal `createRecordingOptions`.
const { ios: IOS_RECORDING_OPTIONS, android: ANDROID_RECORDING_OPTIONS } =
  RecordingPresets.HIGH_QUALITY;
const VOICE_RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
  isMeteringEnabled: true,
  ...(Platform.OS === "ios" ? IOS_RECORDING_OPTIONS : ANDROID_RECORDING_OPTIONS),
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

/** Whether this device can dictate without an environment's server transcriber. */
export function isDeviceVoiceInputAvailable(): boolean {
  // Store screenshots show the dictation button even on simulators, whose
  // on-device transcription is unavailable.
  return getLocalVoiceTranscriber() !== null || getNativeShowcaseScene() !== null;
}

const VoiceInputContext = createContext<ReturnType<typeof useVoiceInputRuntime> | null>(null);

export function VoiceInputProvider({ children }: { readonly children: ReactNode }) {
  const runtime = useVoiceInputRuntime();
  return <VoiceInputContext value={runtime}>{children}</VoiceInputContext>;
}

export function useGlobalVoiceInput() {
  const context = use(VoiceInputContext);
  if (!context) throw new Error("Voice input provider is missing.");
  return context;
}

function useVoiceInputRuntime() {
  const transcribeInEnvironment = useAtomCommand(transcribeVoiceRecording, {
    reportFailure: false,
  });
  const transcribeInEnvironmentRef = useRef(transcribeInEnvironment);
  transcribeInEnvironmentRef.current = transcribeInEnvironment;
  const [{ state, ownerKey, label }, setState] = useState({
    state: INITIAL_STATE,
    ownerKey: null as string | null,
    label: null as string | null,
  });
  const [focusedOwners, setFocusedOwners] = useState<ReadonlySet<string>>(new Set());
  const setOwnerFocused = useCallback((key: string, focused: boolean) => {
    setFocusedOwners((current) => {
      const next = new Set(current);
      if (focused) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const keepAwakeId = useId();
  const keepAwakeSessionRef = useRef(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  const sessionRef = useRef<VoiceInputSession | null>(null);
  const recorderRef = useRef<LazyVoiceRecorder<RecorderState> | null>(null);
  // Server transcription caps duration and size; the active recording keeps
  // whichever transcriber prepared it.
  const usesEnvironmentTranscriberRef = useRef(false);
  const recordingDurationMsRef = useRef(0);
  const listeningRecordingOwnerRef = useRef(Symbol("mobile-voice-input"));

  if (!sessionRef.current || !recorderRef.current) {
    // The native recorder is created when dictation starts, not on app launch.
    const recorder = createLazyVoiceRecorder({
      create: () => new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
      onStatus: (status: RecordingStatus) => {
        sessionRef.current?.controller.handleRecorderStatus({
          isFinished: status.isFinished,
          hasError: status.hasError || status.mediaServicesDidReset === true,
          error: status.error,
          url: status.url,
        });
      },
    });
    recorderRef.current = recorder;
    const createEnvironmentTranscriber = (environmentId: EnvironmentId): VoiceTranscriber => ({
      prepare: async ({ signal }) => {
        throwIfVoiceTranscriptionAborted(signal);
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
            const result = await transcribeInEnvironmentRef.current({
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
    });
    sessionRef.current = new VoiceInputSession({
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
        // Read from the target captured at start, never from the focused composer.
        const environmentId = sessionRef.current?.transcriptionEnvironmentId ?? null;
        const localTranscriber = getLocalVoiceTranscriber();
        const environmentTranscriber = environmentId
          ? createEnvironmentTranscriber(environmentId)
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
        // Dictation and listening playback share the audio session.
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
      onStateChange: (nextState) =>
        setState({
          state: nextState,
          ownerKey: sessionRef.current?.ownerKey ?? null,
          label: sessionRef.current?.label ?? null,
        }),
    });
  }

  const session = sessionRef.current;
  const controller = session.controller;
  const recorder = recorderRef.current;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS reports `inactive` while its permission dialog is open. Only the
      // real background state cancels preparation; recorder status handles
      // calls and route interruptions during capture.
      if (nextState === "background") controller.appMovedToBackground();
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(
    () => () => {
      // Dispose first so an active recording is stopped before the recorder is released.
      controller.dispose();
      recorder.release();
    },
    [controller, recorder],
  );

  useEffect(() => {
    if (state.phase !== "recording") return;

    const tag = `voice-input:${keepAwakeId}:${++keepAwakeSessionRef.current}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    return () => {
      // Release after activation settles, even if the recording ends immediately.
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [keepAwakeId, state.phase]);

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
      if (!status?.isRecording) return;
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

  const stop = useCallback(() => controller.stop(), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);

  return {
    // An environment captured with the active target can still retry it.
    isAvailable: isDeviceVoiceInputAvailable() || session.transcriptionEnvironmentId !== null,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    ownerKey,
    label,
    focusedOwners,
    setOwnerFocused,
    session,
    stop,
    cancel,
  };
}
