import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  VOICE_TRANSCRIPTION_MAX_BYTES,
  VOICE_TRANSCRIPTION_MAX_DURATION_MS,
  VOICE_TRANSCRIPTION_MIN_DURATION_MS,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AudioModule, RecordingPresets, type RecordingStatus } from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Atom, AsyncResult } from "effect/reactivity";
import { makeMutable } from "react-native-reanimated";

import {
  type MicrophoneEntry,
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  voiceInputBlocksSubmission,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { setListeningRecordingActive } from "../../state/listeningPlayback";
import { transcribeVoiceRecording } from "../../state/voice";
import { createLazyVoiceRecorder } from "./lazyVoiceRecorder";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";
import { createVoiceRecordingPermission } from "./voiceRecordingPermission";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";

// The native constructor expects platform-flattened options, as built by useAudioRecorder.
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

function keepScreenAwake(tag: string): () => void {
  const activation = activateKeepAwakeAsync(tag);
  void activation.catch(() => {});
  // Release after activation settles, even if the recording ends immediately.
  return () => void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
}

export const deviceMicrophoneOrder = (saved?: ReadonlyArray<MicrophoneEntry>) =>
  microphoneOrder(saved, Platform.OS === "android" ? "android" : "ios");

/** "checking" until the first availability probe settles; re-probed on foreground. */
export const localVoiceTranscriberAtom = makePermissionStatusAtom<
  VoiceTranscriber | null | "checking"
>({
  label: "mobile:voice-input:transcriber",
  initial: "checking",
  read: () => getLocalVoiceTranscriber().catch(() => null),
}).pipe(Atom.keepAlive);

// Each foreground re-probe yields a new transcriber; composers re-render only when availability flips.
const localVoiceInputAvailableAtom = Atom.make((get) => {
  const transcriber = get(localVoiceTranscriberAtom);
  return transcriber !== null && transcriber !== "checking";
});

/** Whether this device can dictate without an environment's server transcriber. */
export function useDeviceVoiceInputAvailable(): boolean {
  // Store screenshots show the dictation button even on simulators, whose
  // on-device transcription is unavailable.
  return useAtomValue(localVoiceInputAvailableAtom) || getNativeShowcaseScene() !== null;
}

/**
 * The app has one microphone and one dictation at a time, so the session
 * lives for the registry's lifetime rather than any screen's.
 */
const voiceInputAtom = Atom.make((get) => {
  const registry = get.registry;
  // Mounted so the recorder can read and remember microphones synchronously.
  get.mount(mobilePreferencesAtom);
  get.mount(updateMobilePreferencesAtom);
  get.mount(localVoiceTranscriberAtom);
  const audioLevels = makeMutable<ReadonlyArray<number>>(
    Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0),
  );
  let keepAwakeSequence = 0;
  let audioToken: ReturnType<typeof acquireAudioSession> | null = null;
  // Fork: server transcription caps duration and size; the active recording keeps
  // whichever transcriber prepared it.
  let usesEnvironmentTranscriber = false;
  let recordingDurationMs = 0;
  const listeningRecordingOwner = Symbol("mobile-voice-input");
  const permission = createVoiceRecordingPermission(() => {
    void session.controller.appMovedToBackground();
  });
  const recorder = createLazyVoiceRecorder({
    create: () => new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
    onStatus: (status: RecordingStatus) => {
      session.controller.handleRecorderStatus({
        isFinished: status.isFinished,
        hasError: status.hasError || status.mediaServicesDidReset === true,
        error: status.error,
        url: status.url,
      });
    },
    // Read when recording starts so preference changes do not re-render every composer.
    selectInput: (inputs) => {
      const preferences = registry.get(mobilePreferencesAtom);
      if (!AsyncResult.isSuccess(preferences)) return null;
      const known = deviceMicrophoneOrder(preferences.value.microphones);
      const order = rememberMicrophones(known, inputs);
      if (order !== known) {
        registry.set(updateMobilePreferencesAtom, {
          transform: (current) => ({
            microphones: rememberMicrophones(deviceMicrophoneOrder(current.microphones), inputs),
          }),
        });
      }
      return preferredMicrophoneInput(inputs, order);
    },
  });
  const createEnvironmentTranscriber = (environmentId: EnvironmentId): VoiceTranscriber => ({
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return {
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        transcribe: async (uri, options) => {
          throwIfVoiceTranscriptionAborted(options.signal);
          const durationMs = Math.min(VOICE_TRANSCRIPTION_MAX_DURATION_MS, recordingDurationMs);
          if (durationMs < VOICE_TRANSCRIPTION_MIN_DURATION_MS) {
            throw new VoiceTranscriptionError({
              code: "transcription-failed",
              message: "The recording was too short to transcribe.",
            });
          }

          const file = new File(uri);
          const sizeBytes = file.size ?? 0;
          if (sizeBytes <= 0 || sizeBytes > VOICE_TRANSCRIPTION_MAX_BYTES) {
            throw new VoiceTranscriptionError({
              code: "transcription-failed",
              message: "The recording was empty or too large to transcribe.",
            });
          }
          const dataUrl = `data:audio/mp4;base64,${await file.base64()}`;
          throwIfVoiceTranscriptionAborted(options.signal);
          const result = await runAtomCommand(
            registry,
            transcribeVoiceRecording,
            { environmentId, input: { mimeType: "audio/mp4", dataUrl, durationMs, sizeBytes } },
            { reportFailure: false },
          );
          throwIfVoiceTranscriptionAborted(options.signal);
          if (result._tag === "Success") return result.value.text;
          throw new VoiceTranscriptionError({
            code: "transcription-failed",
            message: "Environment voice transcription failed.",
          });
        },
      };
    },
  });
  const session: VoiceInputSession = new VoiceInputSession({
    recorder: {
      get uri() {
        return recorder.uri;
      },
      prepareToRecordAsync: (signal) => recorder.prepareToRecordAsync(signal),
      record: ({ forDuration }) =>
        recorder.record({
          forDuration: usesEnvironmentTranscriber
            ? Math.min(forDuration, VOICE_TRANSCRIPTION_MAX_DURATION_MS / 1_000)
            : forDuration,
        }),
      stop: () => recorder.stop(),
    },
    getTranscriber: () => {
      // Read from the target captured at start, never from the focused composer.
      const environmentId = session.transcriptionEnvironmentId;
      const probed = registry.get(localVoiceTranscriberAtom);
      const localTranscriber = probed === "checking" ? null : probed;
      const environmentTranscriber = environmentId
        ? createEnvironmentTranscriber(environmentId)
        : null;
      usesEnvironmentTranscriber = localTranscriber === null;
      if (!localTranscriber) return environmentTranscriber;
      if (!environmentTranscriber) return localTranscriber;
      return {
        prepare: async (options) => {
          try {
            const prepared = await localTranscriber.prepare(options);
            usesEnvironmentTranscriber = false;
            return prepared;
          } catch {
            throwIfVoiceTranscriptionAborted(options.signal);
            usesEnvironmentTranscriber = true;
            return environmentTranscriber.prepare(options);
          }
        },
      };
    },
    requestPermission: permission.requestPermission,
    configureRecording: async () => {
      recordingDurationMs = 0;
      // Dictation and listening playback share the audio session.
      setListeningRecordingActive(listeningRecordingOwner, true);
      const token = acquireAudioSession("recording");
      audioToken = token;
      try {
        await activateAudioSession(token);
      } catch (error) {
        await releaseAudioSession(token).catch(() => {});
        audioToken = null;
        setListeningRecordingActive(listeningRecordingOwner, false);
        throw error;
      }
    },
    releaseRecording: async () => {
      try {
        if (audioToken) await releaseAudioSession(audioToken);
      } finally {
        audioToken = null;
        setListeningRecordingActive(listeningRecordingOwner, false);
      }
    },
    deleteRecording: (uri) => new File(uri).delete(),
    sampleRecording: () => {
      const status = recorder.getStatus();
      if (!status?.isRecording) return null;
      recordingDurationMs = Math.max(0, Math.round(status.durationMillis));
      return { durationMillis: status.durationMillis, metering: status.metering };
    },
    recordingLimitSeconds: () =>
      usesEnvironmentTranscriber
        ? VOICE_TRANSCRIPTION_MAX_DURATION_MS / 1_000
        : VOICE_RECORDING_LIMIT_SECONDS,
    publishAudioLevels: (levels) => audioLevels.set(levels),
    keepAwake: () => keepScreenAwake(`voice-input:${++keepAwakeSequence}`),
  });
  get.addFinalizer(() => {
    permission.dispose();
    session.dispose();
    recorder.release();
  });
  return { session, audioLevels };
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-input"));

export function useGlobalVoiceInput() {
  const { session, audioLevels } = useAtomValue(voiceInputAtom);
  const isDeviceAvailable = useDeviceVoiceInputAvailable();
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snapshot,
    // An environment captured with the active target can still retry it.
    isAvailable: isDeviceAvailable || session.transcriptionEnvironmentId !== null,
    audioLevels,
    isBusy: voiceInputBlocksSubmission(snapshot.state),
    session,
    stop: () => session.controller.stop(),
    cancel: () => session.controller.cancel(),
  };
}
