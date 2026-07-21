import {
  VOICE_TRANSCRIPTION_MAX_BYTES,
  VOICE_TRANSCRIPTION_MAX_DURATION_MS,
  VOICE_TRANSCRIPTION_MIN_DURATION_MS,
  type EnvironmentId,
  type VoiceAudioMimeType,
} from "@t3tools/contracts";
import {
  LoaderCircleIcon,
  MicIcon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { readFileAsDataUrl } from "../ChatView.logic";
import { transcribeVoiceRecording } from "../../state/voice";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

interface RetainedRecording {
  readonly blob: Blob;
  readonly durationMs: number;
  readonly mimeType: VoiceAudioMimeType;
}

interface DesktopVoiceRecorderProps {
  readonly environmentId: EnvironmentId;
  readonly available: boolean;
  readonly disabled: boolean;
  readonly onTranscript: (text: string) => void;
}

function supportedMimeType(): string | undefined {
  for (const candidate of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return undefined;
}

function normalizeMimeType(value: string): VoiceAudioMimeType | null {
  const mimeType = value.split(";", 1)[0]?.toLowerCase();
  switch (mimeType) {
    case "audio/mp4":
    case "audio/webm":
    case "audio/ogg":
    case "audio/mpeg":
    case "audio/wav":
      return mimeType;
    default:
      return null;
  }
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function DesktopVoiceRecorder({
  environmentId,
  available,
  disabled,
  onTranscript,
}: DesktopVoiceRecorderProps) {
  const transcribe = useAtomCommand(transcribeVoiceRecording, { reportFailure: false });
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "transcribing" | "failed">(
    "idle",
  );
  const [elapsedMs, setElapsedMs] = useState(0);
  const [retained, setRetained] = useState<RetainedRecording | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const finishingRef = useRef(false);
  const mountedRef = useRef(true);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const releaseStream = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // The recorder may already be stopping as its owner unmounts.
      }
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      phaseRef.current = "idle";
      releaseStream();
    };
  }, [releaseStream]);

  useEffect(() => {
    if (available) return;
    phaseRef.current = "idle";
    setPhase("idle");
    setElapsedMs(0);
    setRetained(null);
    releaseStream();
  }, [available, releaseStream]);

  const submitRecording = useCallback(
    async (recording: RetainedRecording) => {
      if (phaseRef.current === "transcribing") return;
      phaseRef.current = "transcribing";
      setPhase("transcribing");
      try {
        const dataUrl = await readFileAsDataUrl(
          new File([recording.blob], "voice-recording", { type: recording.mimeType }),
        );
        const result = await transcribe({
          environmentId,
          input: {
            mimeType: recording.mimeType,
            dataUrl,
            durationMs: recording.durationMs,
            sizeBytes: recording.blob.size,
          },
        });
        if (result._tag === "Success" && mountedRef.current) {
          setRetained(null);
          phaseRef.current = "idle";
          setPhase("idle");
          onTranscript(result.value.text);
          return;
        }
      } catch {
        // Retain the Blob for the explicit Retry action below.
      }
      if (mountedRef.current) {
        setRetained(recording);
        phaseRef.current = "failed";
        setPhase("failed");
      }
    },
    [environmentId, onTranscript, transcribe],
  );

  const stopRecording = useCallback(
    async (discard: boolean) => {
      const recorder = recorderRef.current;
      if (recorder === null || recorder.state === "inactive" || finishingRef.current) return;
      finishingRef.current = true;
      const durationMs = Math.min(
        VOICE_TRANSCRIPTION_MAX_DURATION_MS,
        Math.max(1, Date.now() - startedAtRef.current),
      );
      const blob = await new Promise<Blob>((resolve) => {
        recorder.addEventListener(
          "stop",
          () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType })),
          { once: true },
        );
        recorder.stop();
      });
      const mimeType = normalizeMimeType(blob.type);
      releaseStream();
      finishingRef.current = false;
      if (discard) {
        setElapsedMs(0);
        setRetained(null);
        phaseRef.current = "idle";
        setPhase("idle");
        return;
      }
      if (durationMs < VOICE_TRANSCRIPTION_MIN_DURATION_MS) {
        setRetained(null);
        phaseRef.current = "idle";
        setPhase("idle");
        toastManager.add({
          type: "error",
          title: "Recording too short",
          description: "Hold the microphone a little longer and try again.",
        });
        return;
      }
      if (mimeType === null || blob.size === 0 || blob.size > VOICE_TRANSCRIPTION_MAX_BYTES) {
        setRetained(null);
        phaseRef.current = "idle";
        setPhase("idle");
        toastManager.add({
          type: "error",
          title: "Recording unavailable",
          description:
            blob.size > VOICE_TRANSCRIPTION_MAX_BYTES
              ? "The recording is too large to transcribe."
              : "T3 Code could not read that recording.",
        });
        return;
      }
      await submitRecording({ blob, durationMs, mimeType });
    },
    [releaseStream, submitRecording],
  );

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setInterval(() => {
      const nextElapsedMs = Date.now() - startedAtRef.current;
      setElapsedMs(Math.min(nextElapsedMs, VOICE_TRANSCRIPTION_MAX_DURATION_MS));
      if (nextElapsedMs >= VOICE_TRANSCRIPTION_MAX_DURATION_MS) {
        window.clearInterval(timer);
        void stopRecording(false);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [phase, stopRecording]);

  const startRecording = useCallback(async () => {
    if (disabled || phaseRef.current !== "idle") return;
    phaseRef.current = "starting";
    setPhase("starting");
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || phaseRef.current !== "starting") {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = supportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      phaseRef.current = "recording";
      setPhase("recording");
      recorder.start(1_000);
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      releaseStream();
      phaseRef.current = "idle";
      if (!mountedRef.current) return;
      setPhase("idle");
      toastManager.add({
        type: "error",
        title: "Microphone unavailable",
        description: "Allow microphone access to record a voice message.",
      });
    }
  }, [disabled, releaseStream]);

  if (!available || typeof MediaRecorder === "undefined") return null;

  if (phase === "recording") {
    return (
      <div className="flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/5 px-1.5 py-1 text-xs tabular-nums">
        <span className="min-w-8 text-center text-destructive">{formatDuration(elapsedMs)}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Cancel recording"
          onClick={() => void stopRecording(true)}
        >
          <XIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="default"
          size="icon-xs"
          aria-label="Finish recording"
          onClick={() => void stopRecording(false)}
        >
          <SquareIcon className="size-3" />
        </Button>
      </div>
    );
  }

  if (phase === "starting" || phase === "transcribing") {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled
        aria-label={phase === "starting" ? "Starting recording" : "Transcribing recording"}
      >
        <LoaderCircleIcon className="size-4 animate-spin" />
      </Button>
    );
  }

  if (phase === "failed" && retained !== null) {
    return (
      <div className="flex items-center gap-0.5 rounded-full border border-border px-1 py-0.5">
        <span className="px-1 text-xs text-muted-foreground">Transcription failed</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Retry transcription"
          onClick={() => void submitRecording(retained)}
        >
          <RotateCcwIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Discard recording"
          onClick={() => {
            setRetained(null);
            setPhase("idle");
          }}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label="Record voice message"
            onClick={() => void startRecording()}
          >
            <MicIcon className="size-4" />
          </Button>
        }
      />
      <TooltipPopup>Record voice message</TooltipPopup>
    </Tooltip>
  );
}
