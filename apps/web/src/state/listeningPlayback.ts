import {
  createListeningPlaybackCoordinator,
  isThreadListeningLoaded,
  pauseThreadListening,
  planListeningTrackStart,
  threadListeningState,
  type ListeningTrackMetadata,
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
let loadedTrackMetadata: ListeningTrackMetadata | null = null;
let cancelResumeWatch: (() => void) | null = null;
let mediaSessionHandlersRegistered = false;
// Whether our OS media entry should exist (the web twin of mobile's
// lock-screen activation flag). Archiving disarms it so the element's async
// pause event cannot resurrect the cleared session and the OS play key cannot
// resume a thread whose every in-app pause control just left the screen; the
// next explicit in-app play re-arms.
let mediaSessionArmed = false;

function getMediaSession(): MediaSession | null {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return null;
  return navigator.mediaSession;
}

function setMediaSessionPlaybackState(state: MediaSessionPlaybackState): void {
  const mediaSession = getMediaSession();
  if (mediaSession === null || !mediaSessionArmed) return;
  mediaSession.playbackState = state;
}

function publishMediaSessionPosition(element: HTMLAudioElement): void {
  const mediaSession = getMediaSession();
  if (mediaSession === null || !mediaSessionArmed) return;
  if (!Number.isFinite(element.duration) || element.duration <= 0) return;
  const playbackRate =
    Number.isFinite(element.playbackRate) && element.playbackRate > 0 ? element.playbackRate : 1;
  const position = Math.min(
    element.duration,
    Math.max(0, Number.isFinite(element.currentTime) ? element.currentTime : 0),
  );
  mediaSession.setPositionState({ duration: element.duration, playbackRate, position });
}

function publishMediaSessionMetadata(metadata: ListeningTrackMetadata): void {
  const mediaSession = getMediaSession();
  if (mediaSession === null || !mediaSessionArmed) return;
  mediaSession.metadata = new MediaMetadata({ title: metadata.title, artist: "T3 Code" });
}

function clearMediaSession(): void {
  mediaSessionArmed = false;
  const mediaSession = getMediaSession();
  if (mediaSession === null) return;
  mediaSession.metadata = null;
  mediaSession.playbackState = "none";
  mediaSession.setPositionState();
}

function setMediaSessionActionHandler(
  action: MediaSessionAction,
  handler: MediaSessionActionHandler,
): void {
  const mediaSession = getMediaSession();
  if (mediaSession === null) return;
  try {
    mediaSession.setActionHandler(action, handler);
  } catch {
    // Browsers may expose Media Session without supporting every action.
  }
}

function registerMediaSessionActionHandlers(): void {
  if (mediaSessionHandlersRegistered || getMediaSession() === null) return;
  mediaSessionHandlersRegistered = true;
  setMediaSessionActionHandler("play", () => {
    const { blocked, track } = listeningPlayback.getSnapshot();
    if (!mediaSessionArmed || blocked || track === null || track.playing) return;
    toggleLoadedListeningTrack();
  });
  setMediaSessionActionHandler("pause", () => listeningPlayback.pauseActive());
  setMediaSessionActionHandler("seekbackward", (details) => {
    const element = sharedAudio;
    if (element !== null) seekListeningTrack(element.currentTime - (details.seekOffset ?? 5));
  });
  setMediaSessionActionHandler("seekforward", (details) => {
    const element = sharedAudio;
    if (element !== null) seekListeningTrack(element.currentTime + (details.seekOffset ?? 5));
  });
  setMediaSessionActionHandler("seekto", (details) => {
    if (typeof details.seekTime === "number" && Number.isFinite(details.seekTime)) {
      seekListeningTrack(details.seekTime);
    }
  });
}

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
  registerMediaSessionActionHandlers();
  element.addEventListener("play", () => {
    listeningPlayback.setTrackPlaying(true);
    setMediaSessionPlaybackState("playing");
    // Re-baseline the OS position on every play/pause transition rather than
    // trusting the UA to rebuild its extrapolation across a resume.
    publishMediaSessionPosition(element);
  });
  // Position goes out before the playing flag on pause and end: the at-rest
  // state is derived when the flag flips, and the throttled tick can lag the
  // real position by up to 200ms.
  element.addEventListener("pause", () => {
    publishProgress(element);
    listeningPlayback.setTrackPlaying(false);
    setMediaSessionPlaybackState("paused");
    publishMediaSessionPosition(element);
  });
  element.addEventListener("ended", () => {
    // Pin the position to the end. Elements without a finite duration cannot
    // report one, and the finish signal is what decides at-rest, not the
    // last reported position.
    const duration = Number.isFinite(element.duration) ? element.duration : element.currentTime;
    listeningPlayback.setProgress({ currentTime: duration, duration });
    listeningPlayback.setTrackPlaying(false);
    setMediaSessionPlaybackState("paused");
    publishMediaSessionPosition(element);
  });
  element.addEventListener("error", () => {
    listeningPlayback.setTrackPlaying(false);
    setMediaSessionPlaybackState("paused");
  });
  element.addEventListener("durationchange", () => {
    publishProgress(element);
    publishMediaSessionPosition(element);
  });
  element.addEventListener("seeked", () => {
    publishProgress(element);
    publishMediaSessionPosition(element);
  });
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
    if (element.playbackRate === speed) return;
    element.playbackRate = speed;
    publishMediaSessionPosition(element);
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
  readonly metadata: ListeningTrackMetadata;
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
  mediaSessionArmed = true;
  loadedTrackMetadata = input.metadata;
  publishMediaSessionMetadata(input.metadata);
  if (input.watchUrl !== undefined || !plan.sameTrack) {
    loadedTrackUrlWatcher = input.watchUrl ?? null;
  }
  if (!plan.sameTrack) getMediaSession()?.setPositionState();

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
  const metadata = loadedTrackMetadata;
  if (element === null || element.src === "" || metadata === null) return;
  const watchUrl = loadedTrackUrlWatcher;
  if (watchUrl === null) {
    playListeningTrack({ track, metadata, url: element.src });
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
    playListeningTrack({ track: current, metadata, url, watchUrl });
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
    // The OS media surface goes with the archive too, but the watcher and
    // metadata stay: unarchiving must leave the sidebar resume control
    // functional, and only the next explicit in-app play re-arms the session.
    clearMediaSession();
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
  loadedTrackMetadata = null;
  const element = sharedAudio;
  if (element !== null) {
    element.pause();
    element.removeAttribute("src");
    element.load();
  }
  listeningPlayback.release(track.speechId, pauseSharedAudio);
  listeningPlayback.setTrack(null);
  clearMediaSession();
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
 * Indicator state for a sidebar row: "playing", "paused" while the thread's
 * recording sits mid-way, or null (including once it has played to the end).
 * String snapshots bail out of re-renders exactly like a boolean selector
 * would.
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
