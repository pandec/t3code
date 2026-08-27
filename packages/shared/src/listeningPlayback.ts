export const LISTENING_SPEED_MIN = 1;
export const LISTENING_SPEED_MAX = 2;
export const LISTENING_SPEED_STEP = 0.05;
export const LISTENING_SPEED_PRESETS = [1, 1.25, 1.5, 1.75, 2] as const;

const LISTENING_SPEED_UNITS_PER_X = 1 / LISTENING_SPEED_STEP;

export function clampListeningSpeed(value: number): number {
  if (!Number.isFinite(value)) return LISTENING_SPEED_MIN;
  const units = Math.round(value * LISTENING_SPEED_UNITS_PER_X);
  const minUnits = LISTENING_SPEED_MIN * LISTENING_SPEED_UNITS_PER_X;
  const maxUnits = LISTENING_SPEED_MAX * LISTENING_SPEED_UNITS_PER_X;
  return Math.min(maxUnits, Math.max(minUnits, units)) / LISTENING_SPEED_UNITS_PER_X;
}

export function nudgeListeningSpeed(value: number, direction: -1 | 1): number {
  const units = Math.round(clampListeningSpeed(value) * LISTENING_SPEED_UNITS_PER_X);
  return clampListeningSpeed((units + direction) / LISTENING_SPEED_UNITS_PER_X);
}

export function formatListeningSpeed(value: number): string {
  return `${clampListeningSpeed(value).toFixed(2)}×`;
}

export function listeningSpeedSpokenLabel(value: number): string {
  return `${clampListeningSpeed(value)} times`;
}

export function formatListeningClock(seconds: number): string {
  const wholeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

/**
 * Identity of one recording, rich enough for the thread lists to point back
 * at the thread that owns the playing audio. Plain strings on purpose: this
 * package sits below the contracts brands, and the branded ids narrow to
 * string without a cast.
 */
export interface ListeningTrackRef {
  readonly environmentId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly speechId: string;
}

export interface ListeningActiveTrack extends ListeningTrackRef {
  readonly playing: boolean;
}

export interface ListeningPlaybackSnapshot {
  readonly speed: number;
  readonly blocked: boolean;
  /** The track loaded into the app-scoped player; null until first playback. */
  readonly track: ListeningActiveTrack | null;
}

/**
 * Position updates live outside the main snapshot so list rows subscribing to
 * track identity never re-render on the player's progress ticks (each
 * platform controller picks its own cadence).
 */
export interface ListeningPlaybackProgress {
  readonly currentTime: number;
  readonly duration: number;
}

/** True when the actively PLAYING (not merely loaded) track belongs to the thread. */
export function isThreadListeningPlaying(
  snapshot: ListeningPlaybackSnapshot,
  environmentId: string,
  threadId: string,
): boolean {
  return threadListeningState(snapshot, environmentId, threadId) === "playing";
}

/** True when the loaded track (playing or paused) belongs to the thread. */
export function isThreadListeningLoaded(
  snapshot: ListeningPlaybackSnapshot,
  environmentId: string,
  threadId: string,
): boolean {
  return threadListeningState(snapshot, environmentId, threadId) !== null;
}

export type ThreadListeningState = "playing" | "paused" | null;

/**
 * What the thread-list indicator should show for a thread: "playing" while
 * its audio runs, "paused" while it still owns the loaded track (the
 * indicator is a toggle, so pausing from the list must leave a way back in),
 * null otherwise.
 */
export function threadListeningState(
  snapshot: ListeningPlaybackSnapshot,
  environmentId: string,
  threadId: string,
): ThreadListeningState {
  const track = snapshot.track;
  if (track === null || track.environmentId !== environmentId || track.threadId !== threadId) {
    return null;
  }
  return track.playing ? "playing" : "paused";
}

/** How close to the end still counts as "finished" for replay purposes. */
export const LISTENING_TRACK_END_EPSILON_S = 0.1;

export interface ListeningTrackStartPlan {
  /** The request targets the recording already loaded in the player. */
  readonly sameTrack: boolean;
  /** The loaded recording had played to its end; playback restarts at 0. */
  readonly finished: boolean;
  /** Position the player should start from, in seconds. */
  readonly resumeAt: number;
}

/**
 * Decides how a play request relates to the loaded recording. End-of-track
 * detection keys on track identity, never on the source URL: a re-signed URL
 * for the same recording must replay from 0 when the old one had finished,
 * and resume in place when it had not.
 */
export function planListeningTrackStart(input: {
  readonly loadedTrack: ListeningTrackRef | null;
  readonly nextTrack: ListeningTrackRef;
  /** Player position of the currently loaded source, in seconds. */
  readonly positionSeconds: number;
  /** Duration of the currently loaded source; 0 or NaN when unknown. */
  readonly durationSeconds: number;
}): ListeningTrackStartPlan {
  const sameTrack =
    input.loadedTrack !== null && input.loadedTrack.speechId === input.nextTrack.speechId;
  const duration = Number.isFinite(input.durationSeconds) ? input.durationSeconds : 0;
  const finished =
    sameTrack && duration > 0 && input.positionSeconds >= duration - LISTENING_TRACK_END_EPSILON_S;
  const resumeAt = sameTrack && !finished ? Math.max(0, input.positionSeconds) : 0;
  return { sameTrack, finished, resumeAt };
}

type PausePlayback = () => void;

export interface ListeningPlaybackCoordinator {
  readonly getSnapshot: () => ListeningPlaybackSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getProgress: () => ListeningPlaybackProgress;
  readonly subscribeProgress: (listener: () => void) => () => void;
  readonly activate: (id: string, pause: PausePlayback, track?: ListeningTrackRef) => boolean;
  readonly isActive: (id: string, pause: PausePlayback) => boolean;
  readonly release: (id: string, pause: PausePlayback) => void;
  readonly pauseActive: () => void;
  readonly setBlocked: (blocked: boolean) => void;
  readonly setSpeed: (speed: number) => void;
  readonly nudgeSpeed: (direction: -1 | 1) => void;
  readonly setTrack: (track: ListeningTrackRef | null) => void;
  readonly setTrackPlaying: (playing: boolean) => void;
  readonly setProgress: (progress: ListeningPlaybackProgress) => void;
}

const ZERO_PROGRESS: ListeningPlaybackProgress = { currentTime: 0, duration: 0 };

function sameActiveTrack(a: ListeningActiveTrack | null, b: ListeningActiveTrack | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.playing === b.playing &&
    a.speechId === b.speechId &&
    a.messageId === b.messageId &&
    a.threadId === b.threadId &&
    a.environmentId === b.environmentId
  );
}

export function createListeningPlaybackCoordinator(): ListeningPlaybackCoordinator {
  let snapshot: ListeningPlaybackSnapshot = {
    speed: LISTENING_SPEED_MIN,
    blocked: false,
    track: null,
  };
  let progress: ListeningPlaybackProgress = ZERO_PROGRESS;
  let active: { readonly id: string; readonly pause: PausePlayback } | null = null;
  const listeners = new Set<() => void>();
  const progressListeners = new Set<() => void>();

  const publish = (next: ListeningPlaybackSnapshot) => {
    if (
      next.speed === snapshot.speed &&
      next.blocked === snapshot.blocked &&
      sameActiveTrack(next.track, snapshot.track)
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const publishProgress = (next: ListeningPlaybackProgress) => {
    if (next.currentTime === progress.currentTime && next.duration === progress.duration) return;
    progress = next;
    for (const listener of progressListeners) listener();
  };

  const pauseActive = () => {
    try {
      active?.pause();
    } catch {
      // A virtualized row can release its native player while a pause is in flight.
    }
  };

  const setTrack = (track: ListeningTrackRef | null) => {
    if (track === null) {
      publish({ ...snapshot, track: null });
      publishProgress(ZERO_PROGRESS);
      return;
    }
    const previous = snapshot.track;
    const sameSpeech = previous !== null && previous.speechId === track.speechId;
    // Re-activating the loaded recording keeps its playing flag; a new
    // recording starts paused until the platform player reports playback.
    publish({ ...snapshot, track: { ...track, playing: sameSpeech && previous.playing } });
    if (!sameSpeech) publishProgress(ZERO_PROGRESS);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getProgress: () => progress,
    subscribeProgress: (listener) => {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
    activate: (id, pause, track) => {
      if (snapshot.blocked) return false;
      if (active !== null && (active.id !== id || active.pause !== pause)) pauseActive();
      active = { id, pause };
      if (track !== undefined) setTrack(track);
      return true;
    },
    isActive: (id, pause) => active?.id === id && active.pause === pause,
    release: (id, pause) => {
      if (active?.id === id && active.pause === pause) active = null;
    },
    pauseActive,
    setBlocked: (blocked) => {
      if (blocked === snapshot.blocked) return;
      if (blocked) pauseActive();
      publish({ ...snapshot, blocked });
    },
    setSpeed: (speed) => publish({ ...snapshot, speed: clampListeningSpeed(speed) }),
    nudgeSpeed: (direction) =>
      publish({ ...snapshot, speed: nudgeListeningSpeed(snapshot.speed, direction) }),
    setTrack,
    setTrackPlaying: (playing) => {
      if (snapshot.track === null || snapshot.track.playing === playing) return;
      publish({ ...snapshot, track: { ...snapshot.track, playing } });
    },
    setProgress: publishProgress,
  };
}

// Two startup attempts for the SAME recording share an owner id and pause
// callback, so ownership alone cannot tell them apart. Each attempt takes a
// generation token; a stale attempt aborts instead of calling play() after
// the user paused or superseded it.
const startupGenerations = new WeakMap<ListeningPlaybackCoordinator, number>();

/**
 * The async playback startup flow shared by the platform controllers:
 * ownership activation, optional source attach, end-of-track restart, audio
 * mode preparation, speed application, then play — re-checking after every
 * await that the attempt is still current, unblocked, and owning.
 */
export async function startListeningPlayback(input: {
  readonly coordinator: ListeningPlaybackCoordinator;
  readonly id: string;
  readonly pause: () => void;
  /** Registers the recording with the coordinator so thread lists can point at it. */
  readonly track?: ListeningTrackRef;
  /** Attaches or swaps the player's source before playback starts. */
  readonly prepareSource?: () => Promise<void>;
  readonly restartFromBeginning: boolean;
  readonly seekToBeginning: () => Promise<void>;
  readonly prepareAudioMode: () => Promise<void>;
  readonly applyPlaybackRate: (speed: number) => void;
  readonly play: () => void;
}): Promise<void> {
  const coordinator = input.coordinator;
  const generation = (startupGenerations.get(coordinator) ?? 0) + 1;
  startupGenerations.set(coordinator, generation);
  if (!coordinator.activate(input.id, input.pause, input.track)) return;
  const isCurrent = () =>
    startupGenerations.get(coordinator) === generation &&
    !coordinator.getSnapshot().blocked &&
    coordinator.isActive(input.id, input.pause);

  try {
    if (input.prepareSource !== undefined) {
      await input.prepareSource();
      if (!isCurrent()) return;
    }
    if (input.restartFromBeginning) await input.seekToBeginning();
    if (!isCurrent()) return;

    await input.prepareAudioMode();
    if (!isCurrent()) return;

    input.applyPlaybackRate(coordinator.getSnapshot().speed);
    input.play();
  } catch {
    // Only the current attempt may unwind: a stale rejection must not
    // release ownership (or clear the track) now held by a newer attempt.
    if (startupGenerations.get(coordinator) !== generation) return;
    coordinator.release(input.id, input.pause);
    // A failed start must not leave a dead paused indicator in the lists:
    // the registered track has no working audio behind it.
    if (input.track !== undefined) coordinator.setTrack(null);
  }
}

/**
 * Pauses playback when the thread owns the loaded track, leaving it loaded
 * and resumable. Used when the thread is archived: its rows leave every list
 * surface that carries the pause control, so the audio must not keep playing
 * with no in-app affordance.
 */
export function pauseThreadListening(
  coordinator: ListeningPlaybackCoordinator,
  environmentId: string,
  threadId: string,
): void {
  if (!isThreadListeningLoaded(coordinator.getSnapshot(), environmentId, threadId)) return;
  coordinator.pauseActive();
}
