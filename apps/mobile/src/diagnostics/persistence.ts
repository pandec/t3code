import type { MobileDiagnosticEvent } from "./events";

export const MOBILE_DIAGNOSTICS_DIRECTORY = "mobile-diagnostics";
export const MOBILE_DIAGNOSTICS_FILE = "events.ndjson";
export const MOBILE_DIAGNOSTICS_MAX_FILE_BYTES = 1_000_000;

const ROTATED_FILES = ["events.1.ndjson", "events.2.ndjson"] as const;

export function serializeMobileDiagnosticEvents(
  events: ReadonlyArray<MobileDiagnosticEvent>,
): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

export function shouldRotateMobileDiagnostics(
  currentBytes: number,
  incomingBytes: number,
): boolean {
  return currentBytes > 0 && currentBytes + incomingBytes > MOBILE_DIAGNOSTICS_MAX_FILE_BYTES;
}

export async function appendMobileDiagnosticEvents(
  events: ReadonlyArray<MobileDiagnosticEvent>,
): Promise<void> {
  if (events.length === 0) return;

  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, MOBILE_DIAGNOSTICS_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });

  const payload = serializeMobileDiagnosticEvents(events);
  const incomingBytes = new TextEncoder().encode(payload).byteLength;
  const current = new File(directory, MOBILE_DIAGNOSTICS_FILE);

  if (shouldRotateMobileDiagnostics(current.size, incomingBytes)) {
    const oldest = new File(directory, ROTATED_FILES[1]);
    if (oldest.exists) oldest.delete();

    const previous = new File(directory, ROTATED_FILES[0]);
    if (previous.exists) previous.moveSync(oldest, { overwrite: true });
    if (current.exists) current.moveSync(previous, { overwrite: true });
  }

  const output = new File(directory, MOBILE_DIAGNOSTICS_FILE);
  if (!output.exists) output.create({ intermediates: true, overwrite: true });
  output.write(payload, { append: true });
}
