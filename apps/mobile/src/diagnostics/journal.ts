import {
  mobileDiagnosticEvent,
  type MobileDiagnosticDetails,
  type MobileDiagnosticEvent,
} from "./events";
import { appendMobileDiagnosticEvents } from "./persistence";

const DEFAULT_MAX_PENDING_EVENTS = 512;
const MAX_CONSECUTIVE_WRITE_FAILURES = 3;

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
    if (droppedEvents > 0) {
      batch.unshift(
        mobileDiagnosticEvent(
          "journal",
          { droppedEvents },
          clock.wallTimeMs(),
          clock.monotonicTimeMs(),
        ),
      );
      droppedEvents = 0;
    }

    try {
      await write(batch);
      consecutiveWriteFailures = 0;
    } catch {
      consecutiveWriteFailures += 1;
      pending = [...batch, ...pending].slice(-maxPendingEvents);
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
