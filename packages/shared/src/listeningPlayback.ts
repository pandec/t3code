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
 * track identity never re-render on the player's 250ms progress tick.
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
  const track = snapshot.track;
  return (
    track !== null &&
    track.playing &&
    track.environmentId === environmentId &&
    track.threadId === threadId
  );
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
