export function formatProviderUsageEmail(email: string, masked = false): string {
  if (!masked) return email;
  const separator = email.lastIndexOf("@");
  const localPart = separator > 0 ? email.slice(0, separator) : email;
  const domain = separator > 0 ? email.slice(separator) : "";
  const firstCharacter = Array.from(localPart)[0] ?? "";
  return `${firstCharacter}•••${domain}`;
}
