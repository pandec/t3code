export function formatProviderUsageEmail(email: string, masked = false): string {
  if (!masked) return email;
  const separator = email.lastIndexOf("@");
  const localPart = separator > 0 ? email.slice(0, separator) : email;
  const domain = separator > 0 ? email.slice(separator) : "";
  const firstCharacter = Array.from(localPart)[0] ?? "";
  return `${firstCharacter}•••${domain}`;
}

/**
 * Newest `observedAt` across usage snapshots, or 0 when there are none.
 *
 * A refresh RPC succeeds even when every probe failed, so the client compares
 * this before and after to tell "refreshed" from "silently returned nothing".
 */
export function newestProviderUsageObservedAt(
  snapshots: ReadonlyArray<{ readonly observedAt: number }> | undefined,
): number {
  return (snapshots ?? []).reduce((newest, snapshot) => Math.max(newest, snapshot.observedAt), 0);
}
