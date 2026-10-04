/**
 * Spoken name for a driver, for row accessibility labels. Null for drivers
 * with no established name — {@link ProviderIcon} falls back to the OpenAI
 * mark for those, and announcing a raw driver id would be worse than silence.
 */
export function providerDisplayName(driver: string | null): string | null {
  switch (driver) {
    case "claudeAgent":
      return "Claude";
    case "codex":
      return "Codex";
    default:
      return null;
  }
}
