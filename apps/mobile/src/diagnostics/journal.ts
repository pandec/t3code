import {
  mobileDiagnosticEvent,
  type MobileDiagnosticDetails,
  type MobileDiagnosticEvent,
} from "./events";
import { appendMobileDiagnosticEvents } from "./persistence";

const DEFAULT_MAX_PENDING_EVENTS = 512;
const MAX_CONSECUTIVE_WRITE_FAILURES = 3;
/** Failures closer together than this are treated as one episode. */
const WRITE_FAILURE_EPISODE_MS = 5_000;

interface DiagnosticClock {
  readonly wallTimeMs: () => number;
  readonly monotonicTimeMs: () => number;
}

interface MobileDiagnosticJournalOptions {
  readonly enabled: boolean;
  readonly maxPendingEvents?: number;
  readonly clock?: DiagnosticClock;
  readonly write?: (events: ReadonlyArray<MobileDiagnosticEvent>) => Promise<void>;
}

export interface MobileDiagnosticJournal {
  readonly enabled: () => boolean;
  readonly record: (kind: string, details?: MobileDiagnosticDetails) => void;
  readonly flush: () => Promise<void>;
}

export function createMobileDiagnosticJournal(
  options: MobileDiagnosticJournalOptions,
): MobileDiagnosticJournal {
  const maxPendingEvents = options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS;
  const clock =
    options.clock ??
    ({
      wallTimeMs: Date.now,
      monotonicTimeMs: () => globalThis.performance?.now?.() ?? Date.now(),
    } satisfies DiagnosticClock);
  const write = options.write ?? appendMobileDiagnosticEvents;

  let active = options.enabled;
  let consecutiveWriteFailures = 0;
  let writeFailureEpisodeStartedAt: number | null = null;
  let droppedEvents = 0;
  let pending: MobileDiagnosticEvent[] = [];
  let writes = Promise.resolve();

  const record = (kind: string, details: MobileDiagnosticDetails = {}) => {
    if (!active) return;
    pending.push(mobileDiagnosticEvent(kind, details, clock.wallTimeMs(), clock.monotonicTimeMs()));
    if (pending.length > maxPendingEvents) {
      pending.shift();
      droppedEvents += 1;
    }
  };

  const runFlush = async () => {
    if (!active || pending.length === 0) return;

    const batch = pending;
    pending = [];
    const droppedEventsInBatch = droppedEvents;
    if (droppedEventsInBatch > 0) {
      // Stamped with the oldest retained event rather than the flush instant, so
      // the marker sits at the gap it describes and the file stays monotonic.
      batch.unshift(
        mobileDiagnosticEvent(
          "journal",
          { droppedEvents: droppedEventsInBatch },
          batch[0].t,
          batch[0].m,
        ),
      );
      droppedEvents = 0;
    }

    try {
      await write(batch);
      consecutiveWriteFailures = 0;
      writeFailureEpisodeStartedAt = null;
    } catch {
      // Backgrounding, a memory warning, a severe stall, and the periodic timer
      // can all flush within a second of each other, so counting invocations
      // would spend the entire failure budget on a single bad moment (an early
      // launch before first unlock, say). Count failure episodes instead.
      const failedAt = clock.monotonicTimeMs();
      if (
        writeFailureEpisodeStartedAt === null ||
        failedAt - writeFailureEpisodeStartedAt >= WRITE_FAILURE_EPISODE_MS
      ) {
        consecutiveWriteFailures += 1;
        writeFailureEpisodeStartedAt = failedAt;
      }

      // Requeueing can overflow the buffer. Account for what that discards, or
      // the journal reports a clean record over a hole it silently created.
      // The marker is regenerated from its count rather than requeued as an
      // ordinary event, so evicting it cannot erase the earlier gap it records.
      const failedEvents = droppedEventsInBatch > 0 ? batch.slice(1) : batch;
      const restored = [...failedEvents, ...pending];
      const overflow = Math.max(0, restored.length - maxPendingEvents);
      droppedEvents += droppedEventsInBatch + overflow;
      pending = restored.slice(overflow);

      if (consecutiveWriteFailures >= MAX_CONSECUTIVE_WRITE_FAILURES) {
        active = false;
        pending = [];
      }
    }
  };

  return {
    enabled: () => active,
    record,
    flush: () => {
      writes = writes.then(runFlush, runFlush);
      return writes;
    },
  };
}

export const mobileDiagnosticsEnabled = process.env.EXPO_PUBLIC_MOBILE_DIAGNOSTICS === "1";

export const mobileDiagnosticJournal = createMobileDiagnosticJournal({
  enabled: mobileDiagnosticsEnabled,
});

export function recordMobileDiagnostic(kind: string, details?: MobileDiagnosticDetails): void {
  mobileDiagnosticJournal.record(kind, details);
}

export function flushMobileDiagnostics(): Promise<void> {
  return mobileDiagnosticJournal.flush();
}
