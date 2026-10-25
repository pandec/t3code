export function formatProviderUsageEmail(email: string, masked = false): string {
  if (!masked) return email;
  const separator = email.lastIndexOf("@");
  const localPart = separator > 0 ? email.slice(0, separator) : email;
  const domain = separator > 0 ? email.slice(separator) : "";
  const firstCharacter = Array.from(localPart)[0] ?? "";
  return `${firstCharacter}•••${domain}`;
}

/**
 * Newest `observedAt` across snapshots, optionally limited to the refreshed instances; 0
 * when none. A refresh RPC succeeds even when every probe failed, so callers compare this
 * across the refresh to tell "refreshed" from "silently returned nothing".
 */
