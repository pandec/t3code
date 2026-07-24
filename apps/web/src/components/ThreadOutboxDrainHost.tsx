import { useThreadOutboxDrain } from "../state/use-thread-outbox-drain";

/** Mounts the queued-message drain once for the whole app; renders nothing. */
export function ThreadOutboxDrainHost() {
  useThreadOutboxDrain();
  return null;
}
