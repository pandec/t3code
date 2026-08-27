import {
  createListeningPlaybackCoordinator,
  isThreadListeningLoaded,
  pauseThreadListening,
  planListeningTrackStart,
  threadListeningState,
  type ListeningTrackRef,
  type ThreadListeningState,
} from "@t3tools/shared/listeningPlayback";
import { useCallback, useSyncExternalStore } from "react";

export const listeningPlayback = createListeningPlaybackCoordinator();
const recordingOwners = new Set<symbol>();

export function setListeningRecordingActive(owner: symbol, active: boolean): void {
  if (active) recordingOwners.add(owner);
  else recordingOwners.delete(owner);
  listeningPlayback.setBlocked(recordingOwners.size > 0);
}

/**
 * The app-scoped audio element behind every listening version and voice
 * reply. Living at module scope (not in a message row) lets audio keep
 * playing while the user navigates anywhere in the app; rows are views
 * bound to it through the coordinator's track snapshot.
 */
let sharedAudio: HTMLAudioElement | null = null;
// Progress publishes are throttled: timeupdate can fire faster than the
// transport needs (one publish per 200ms), and every publish wakes the
// subscribed view.
let lastProgressPublishMs = 0;
// Re-resolves a current signed URL for the loaded track, registry-based and
// component-independent: the row hands it over on play so the sidebar can
// resume long after the row unmounted and the old URL expired.
type ListeningUrlWatcher = (onResolved: (url: string | null) => void) => () => void;
let loadedTrackUrlWatcher: ListeningUrlWatcher | null = null;
let cancelResumeWatch: (() => void) | null = null;

const pauseSharedAudio = () => {
  sharedAudio?.pause();
};

function publishProgress(element: HTMLAudioElement): void {
  listeningPlayback.setProgress({
    currentTime: element.currentTime,
    duration: Number.isFinite(element.duration) ? element.duration : 0,
  });
}

function ensureSharedAudio(): HTMLAudioElement {
  if (sharedAudio !== null) return sharedAudio;
  const element = new Audio();
  element.preload = "metadata";
  element.addEventListener("play", () => listeningPlayback.setTrackPlaying(true));
  element.addEventListener("pause", () => listeningPlayback.setTrackPlaying(false));
  element.addEventListener("ended", () => {
    listeningPlayback.setTrackPlaying(false);
    publishProgress(element);
  });
  element.addEventListener("error", () => listeningPlayback.setTrackPlaying(false));
  element.addEventListener("durationchange", () => publishProgress(element));
  element.addEventListener("seeked", () => publishProgress(element));
  element.addEventListener("timeupdate", () => {
    const now = Date.now();
    if (now - lastProgressPublishMs < 200) return;
    lastProgressPublishMs = now;
    publishProgress(element);
  });
  sharedAudio = element;
  // Speed changes mid-playback land on the element immediately. The default
  // rate is pinned too because a source swap resets playbackRate to it.
  listeningPlayback.subscribe(() => {
    const { speed } = listeningPlayback.getSnapshot();
    element.defaultPlaybackRate = speed;
    if (element.playbackRate !== speed) element.playbackRate = speed;
  });
  return element;
}

/**
 * Loads (or resumes) a recording on the shared element and starts playback.
 * Rows always pass their freshest signed URL: a re-signed URL for the loaded
 * recording is swapped in with the position restored (or replayed from the
 * start when the old one had finished), which covers token expiry across
 * long pauses without a dedicated refresh path.
 */
export function playListeningTrack(input: {
  readonly track: ListeningTrackRef;
  readonly url: string;
  /** Re-resolves a fresh signed URL for this track; kept for sidebar resume. */
  readonly watchUrl?: ListeningUrlWatcher;
}): void {
  cancelResumeWatch?.();
  cancelResumeWatch = null;
  const element = ensureSharedAudio();
  const plan = planListeningTrackStart({
    loadedTrack: listeningPlayback.getSnapshot().track,
    nextTrack: input.track,
    positionSeconds: element.currentTime,
    durationSeconds: element.duration,
  });
  if (!listeningPlayback.activate(input.track.speechId, pauseSharedAudio, input.track)) return;
  if (input.watchUrl !== undefined || !plan.sameTrack) {
    loadedTrackUrlWatcher = input.watchUrl ?? null;
  }

  if (element.src !== input.url) {
    element.src = input.url;
    // Assigning currentTime before metadata arrives sets the default start
    // position, so the resume survives the source swap.
    if (plan.resumeAt > 0) element.currentTime = plan.resumeAt;
  } else if (plan.finished) {
    element.currentTime = 0;
  }
  element.preservesPitch = true;
  const { speed } = listeningPlayback.getSnapshot();
  element.defaultPlaybackRate = speed;
  element.playbackRate = speed;
  void element.play().catch(() => {
    // A rejected play (revoked URL, decode failure) leaves the track paused;
    // the next press retries with the row's fresh URL.
    listeningPlayback.setTrackPlaying(false);
  });
}

export function seekListeningTrack(seconds: number): void {
  const element = sharedAudio;
  if (element === null || !Number.isFinite(seconds)) return;
  element.currentTime = Math.max(0, seconds);
}

/**
 * Play/pause toggle for the loaded track, usable from any sidebar row.
 * Resume re-resolves a current signed URL through the watcher the row handed
 * over on play: after a long pause the loaded URL may have expired, and the
 * plan-based play path swap-restores the position on a fresh one. Without a
 * watcher it falls back to replaying the loaded source.
 */
export function toggleLoadedListeningTrack(): void {
  const track = listeningPlayback.getSnapshot().track;
  if (track === null) return;
  if (track.playing) {
    listeningPlayback.pauseActive();
    return;
  }
  const element = sharedAudio;
  if (element === null || element.src === "") return;
  const watchUrl = loadedTrackUrlWatcher;
  if (watchUrl === null) {
    playListeningTrack({ track, url: element.src });
    return;
  }
  cancelResumeWatch?.();
  cancelResumeWatch = watchUrl((url) => {
    cancelResumeWatch = null;
    if (url === null) return;
    const current = listeningPlayback.getSnapshot().track;
    // Only resume what the user asked to resume: a track swapped or started
    // playing while the URL resolved wins over this stale intent.
    if (current === null || current.speechId !== track.speechId || current.playing) return;
    playListeningTrack({ track: current, url, watchUrl });
  });
}

/**
 * Pauses playback owned by the thread without clearing it (used when it is
 * archived): archived rows leave every list surface that carries the pause
 * control, so the audio must not keep playing — but the recording stays
 * loaded and resumable.
 */
export function pauseListeningForThread(environmentId: string, threadId: string): void {
  if (isThreadListeningLoaded(listeningPlayback.getSnapshot(), environmentId, threadId)) {
    // An in-flight sidebar resume would restart the audio when its URL
    // resolves after the archive hid every surface with a pause control.
    cancelResumeWatch?.();
    cancelResumeWatch = null;
  }
  pauseThreadListening(listeningPlayback, environmentId, threadId);
}

/**
 * Stops and clears playback owned by the thread (used when it is deleted):
 * the loaded track must not outlive the thread that owns it.
 */
export function stopListeningForThread(environmentId: string, threadId: string): void {
  const snapshot = listeningPlayback.getSnapshot();
  if (!isThreadListeningLoaded(snapshot, environmentId, threadId)) return;
  const track = snapshot.track;
  if (track === null) return;
  cancelResumeWatch?.();
  cancelResumeWatch = null;
  loadedTrackUrlWatcher = null;
  const element = sharedAudio;
  if (element !== null) {
    element.pause();
    element.removeAttribute("src");
    element.load();
  }
  listeningPlayback.release(track.speechId, pauseSharedAudio);
  listeningPlayback.setTrack(null);
}

export function useListeningPlaybackSnapshot() {
  return useSyncExternalStore(
    listeningPlayback.subscribe,
    listeningPlayback.getSnapshot,
    listeningPlayback.getSnapshot,
  );
}

/** Position of the loaded track. Subscribe only from the active player view. */
export function useListeningPlaybackProgress() {
  return useSyncExternalStore(
    listeningPlayback.subscribeProgress,
    listeningPlayback.getProgress,
    listeningPlayback.getProgress,
  );
}

/**
 * Indicator state for a sidebar row: "playing", "paused" while the thread
 * still owns the loaded track, or null. String snapshots bail out of
 * re-renders exactly like a boolean selector would.
 */
export function useThreadListeningState(
  environmentId: string,
  threadId: string,
): ThreadListeningState {
  const read = useCallback(
    () => threadListeningState(listeningPlayback.getSnapshot(), environmentId, threadId),
    [environmentId, threadId],
  );
  return useSyncExternalStore(listeningPlayback.subscribe, read, read);
}
