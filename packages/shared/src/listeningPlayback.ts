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

export interface ListeningPlaybackSnapshot {
  readonly speed: number;
  readonly blocked: boolean;
}

type PausePlayback = () => void;

export interface ListeningPlaybackCoordinator {
  readonly getSnapshot: () => ListeningPlaybackSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly activate: (id: string, pause: PausePlayback) => boolean;
  readonly isActive: (id: string, pause: PausePlayback) => boolean;
  readonly release: (id: string, pause: PausePlayback) => void;
  readonly pauseActive: () => void;
  readonly setBlocked: (blocked: boolean) => void;
  readonly setSpeed: (speed: number) => void;
  readonly nudgeSpeed: (direction: -1 | 1) => void;
}

export function createListeningPlaybackCoordinator(): ListeningPlaybackCoordinator {
  let snapshot: ListeningPlaybackSnapshot = { speed: LISTENING_SPEED_MIN, blocked: false };
  let active: { readonly id: string; readonly pause: PausePlayback } | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: ListeningPlaybackSnapshot) => {
    if (next.speed === snapshot.speed && next.blocked === snapshot.blocked) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const pauseActive = () => {
    try {
      active?.pause();
    } catch {
      // A virtualized row can release its native player while a pause is in flight.
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activate: (id, pause) => {
      if (snapshot.blocked) return false;
      if (active !== null && (active.id !== id || active.pause !== pause)) pauseActive();
      active = { id, pause };
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
  };
}
