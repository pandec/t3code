import {
  VOICE_TRANSCRIPTION_MAX_BYTES,
  VOICE_TRANSCRIPTION_MAX_DURATION_MS,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, PanResponder, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ComposerToolbarButton } from "../../components/ComposerToolbarTrigger";
import { transcribeVoiceRecording } from "../../state/voice";
import { useAtomCommand } from "../../state/use-atom-command";

interface RetainedRecording {
  readonly uri: string;
  readonly durationMs: number;
}

export function VoiceRecorderControl(props: {
  readonly environmentId: EnvironmentId;
  readonly available: boolean;
  readonly disabled?: boolean;
  readonly onTranscript: (text: string) => void;
}) {
  const transcribe = useAtomCommand(transcribeVoiceRecording, { reportFailure: false });
  const recorder = useAudioRecorder(RecordingPresets.LOW_QUALITY);
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "transcribing" | "failed">(
    "idle",
  );
  const [elapsedMs, setElapsedMs] = useState(0);
  const [locked, setLocked] = useState(false);
  const [retained, setRetained] = useState<RetainedRecording | null>(null);
  const phaseRef = useRef(phase);
  const lockedRef = useRef(false);
  const startedAtRef = useRef(0);
  const releasedBeforeStartRef = useRef(false);
  const finishingRef = useRef(false);
  phaseRef.current = phase;

  const discardFile = useCallback((uri: string | null | undefined) => {
    if (!uri) return;
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      // The recorder may already have cleaned up an empty or interrupted file.
    }
  }, []);

  const submitRecording = useCallback(
    async (recording: RetainedRecording) => {
      setPhase("transcribing");
      try {
        const file = new File(recording.uri);
        const sizeBytes = file.size ?? 0;
        if (sizeBytes <= 0 || sizeBytes > VOICE_TRANSCRIPTION_MAX_BYTES) {
          throw new Error("The recording is empty or too large.");
        }
        const base64 = await file.base64();
        const result = await transcribe({
          environmentId: props.environmentId,
          input: {
            mimeType: "audio/mp4",
            dataUrl: `data:audio/mp4;base64,${base64}`,
            durationMs: recording.durationMs,
            sizeBytes,
          },
        });
        if (result._tag === "Success") {
          discardFile(recording.uri);
          setRetained(null);
          setPhase("idle");
          props.onTranscript(result.value.text);
          return;
        }
      } catch {
        // Retain the local file so Retry remains useful after a transient failure.
      }
      setRetained(recording);
      setPhase("failed");
    },
    [discardFile, props, transcribe],
  );

  const finishRecording = useCallback(
    async (discard: boolean) => {
      if (phaseRef.current !== "recording" || finishingRef.current) return;
      finishingRef.current = true;
      const durationMs = Math.min(
        VOICE_TRANSCRIPTION_MAX_DURATION_MS,
        Math.max(1, Date.now() - startedAtRef.current),
      );
      try {
        await recorder.stop();
        const uri = recorder.uri;
        setLocked(false);
        lockedRef.current = false;
        setElapsedMs(0);
        if (discard || uri === null) {
          discardFile(uri);
          setPhase("idle");
          return;
        }
        await submitRecording({ uri, durationMs });
      } catch {
        setPhase("idle");
      } finally {
        finishingRef.current = false;
        await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      }
    },
    [discardFile, recorder, submitRecording],
  );

  const startRecording = useCallback(async () => {
    if (props.disabled || phaseRef.current !== "idle") return;
    releasedBeforeStartRef.current = false;
    phaseRef.current = "starting";
    setPhase("starting");
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Microphone access needed",
          "Allow microphone access in Settings to record a voice message.",
        );
        phaseRef.current = "idle";
        setPhase("idle");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      startedAtRef.current = Date.now();
      phaseRef.current = "recording";
      setPhase("recording");
      recorder.record();
      if (releasedBeforeStartRef.current) void finishRecording(false);
    } catch {
      phaseRef.current = "idle";
      setPhase("idle");
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    }
  }, [finishRecording, props.disabled, recorder]);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => {
      const nextElapsedMs = Date.now() - startedAtRef.current;
      setElapsedMs(Math.min(nextElapsedMs, VOICE_TRANSCRIPTION_MAX_DURATION_MS));
      if (nextElapsedMs >= VOICE_TRANSCRIPTION_MAX_DURATION_MS) {
        clearInterval(timer);
        void finishRecording(false);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [finishRecording, phase]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active" && phaseRef.current === "recording") {
        void finishRecording(true);
      }
    });
    return () => subscription.remove();
  }, [finishRecording]);

  const lockRecording = useCallback(() => {
    if (phaseRef.current !== "recording" || lockedRef.current) return;
    lockedRef.current = true;
    setLocked(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, []);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => phaseRef.current === "idle" && props.disabled !== true,
        onMoveShouldSetPanResponder: () => phaseRef.current === "recording",
        onPanResponderGrant: () => void startRecording(),
        onPanResponderMove: (_event, gesture) => {
          if (gesture.dy <= -56) lockRecording();
        },
        onPanResponderRelease: () => {
          if (phaseRef.current === "starting") {
            releasedBeforeStartRef.current = true;
            return;
          }
          if (!lockedRef.current) void finishRecording(false);
        },
        onPanResponderTerminate: () => {
          if (phaseRef.current === "recording" && !lockedRef.current) {
            void finishRecording(true);
          }
        },
      }),
    [finishRecording, lockRecording, props.disabled, startRecording],
  );

  if (!props.available) return null;

  const content = (() => {
    if (phase === "recording") {
      return (
        <View className="h-11 flex-row items-center gap-1 rounded-full bg-danger/10 px-2">
          <Text className="min-w-10 text-center text-xs font-t3-bold text-danger tabular-nums">
            {`${Math.floor(elapsedMs / 60_000)}:${String(Math.floor(elapsedMs / 1_000) % 60).padStart(2, "0")}`}
          </Text>
          <Text className="text-2xs text-foreground-muted">
            {locked ? "Locked" : "Swipe up to lock"}
          </Text>
          <ComposerToolbarButton
            accessibilityLabel="Cancel recording"
            icon="xmark"
            showChevron={false}
            variant="danger"
            onPress={() => void finishRecording(true)}
          />
          <ComposerToolbarButton
            accessibilityLabel="Finish recording"
            icon="checkmark"
            showChevron={false}
            variant="primary"
            onPress={() => void finishRecording(false)}
          />
        </View>
      );
    }

    if (phase === "starting" || phase === "transcribing") {
      return (
        <ComposerToolbarButton
          accessibilityLabel={
            phase === "starting" ? "Starting recording" : "Transcribing recording"
          }
          disabled
          iconNode={<ActivityIndicator size="small" />}
          showChevron={false}
        />
      );
    }

    if (phase === "failed" && retained !== null) {
      return (
        <View className="h-11 flex-row items-center gap-1 rounded-full bg-subtle px-2">
          <Text className="text-2xs text-foreground-muted">Transcription failed</Text>
          <ComposerToolbarButton
            accessibilityLabel="Retry transcription"
            icon="arrow.clockwise"
            showChevron={false}
            onPress={() => void submitRecording(retained)}
          />
          <ComposerToolbarButton
            accessibilityLabel="Discard recording"
            icon="trash"
            showChevron={false}
            variant="danger"
            onPress={() => {
              discardFile(retained.uri);
              setRetained(null);
              setPhase("idle");
            }}
          />
        </View>
      );
    }

    return (
      <ComposerToolbarButton
        accessibilityLabel="Hold to record voice message"
        disabled={props.disabled}
        icon="mic"
        showChevron={false}
        onPress={() => void startRecording()}
      />
    );
  })();

  return <View {...panResponder.panHandlers}>{content}</View>;
}
