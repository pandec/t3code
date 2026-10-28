import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useEnvironmentScope } from "../../state/session";
import { isDeviceVoiceInputAvailable, useGlobalVoiceInput } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly label: string;
  /**
   * Environment whose server transcriber backs this composer when on-device
   * transcription is unavailable or fails to prepare. Captured with the target
   * when dictation starts, so navigation cannot retarget an active recording.
   */
  readonly environmentId: EnvironmentId | null;
  readonly environmentTranscriptionAvailable: boolean;
  readonly readDraftMessage: () => string | null;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  /**
   * Commits dictated text to the draft captured at start. Runs even after the
   * composer unmounts, so it must write by stable draft identity and keep the
   * `voice-transcription` input origin.
   */
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const global = useGlobalVoiceInput();
  const { session } = global;
  // Server transcription operates the environment; on-device dictation needs no grant.
  const canOperateEnvironment = useEnvironmentScope(
    input.environmentId,
    AuthOrchestrationOperateScope,
  );
  const environmentTranscriptionAvailable =
    input.environmentTranscriptionAvailable && canOperateEnvironment;
  const latestInput = useRef({ ...input, environmentTranscriptionAvailable });
  // oxlint-disable-next-line react/refs -- Transcription finishes asynchronously and must reach the composer's current selection setter, not the one captured at start.
  latestInput.current = { ...input, environmentTranscriptionAvailable };
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mount so async transcription results skip a composer that has unmounted
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ownerKey = input.ownerKey;
      if (!ownerKey) return;
      session.setOwnerFocused(ownerKey, true);
      return () => session.setOwnerFocused(ownerKey, false);
    }, [input.ownerKey, session]),
  );

  const start = useCallback(() => {
    const captured = latestInput.current;
    if (!captured.ownerKey || captured.disabled) return;
    void session.start({
      ...createVoiceInputTarget(
        captured.ownerKey,
        captured.readDraftMessage,
        (text, selection) => {
          captured.onChangeDraftMessage(text);
          if (mounted.current && latestInput.current.ownerKey === captured.ownerKey) {
            latestInput.current.onChangeSelection(selection);
          }
        },
        captured.selection,
        captured.subscribeToDraftChanges,
      ),
      label: captured.label,
      transcriptionEnvironmentId: captured.environmentTranscriptionAvailable
        ? captured.environmentId
        : null,
    });
  }, [session]);
  const state = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;
  const isBusy = voiceInputBlocksSubmission(state);
  const canTranscribe =
    isDeviceVoiceInputAvailable() ||
    (input.environmentId !== null && environmentTranscriptionAvailable);
  return {
    isAvailable: canTranscribe && (!global.isBusy || global.ownerKey === input.ownerKey),
    state,
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: isBusy,
    blocksSubmission: isBusy,
    start,
    stop: global.stop,
    cancel: global.cancel,
  };
}
