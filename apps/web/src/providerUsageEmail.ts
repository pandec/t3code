export function formatProviderUsageEmail(email: string, masked = false): string {
  if (!masked) return email;
  const separator = email.lastIndexOf("@");
  const localPart = separator > 0 ? email.slice(0, separator) : email;
  const domain = separator > 0 ? email.slice(separator) : "";
  const firstCharacter = Array.from(localPart)[0] ?? "";
  return `${firstCharacter}•••${domain}`;
}

/**
 * Newest `observedAt` across usage snapshots, optionally restricted to the
 * instances a refresh actually targeted; 0 when there are none.
 *
 * A refresh RPC succeeds even when every server-side probe failed or timed
 * out, so the client compares this across the refresh result to tell
 * "refreshed" from "silently returned nothing".
 */
