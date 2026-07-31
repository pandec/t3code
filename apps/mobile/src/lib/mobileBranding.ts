export type MobileStageLabel = "Dev" | "Nightly";

// Production shows no stage pill: "Alpha" wasted header space, while the
// Dev/Nightly badges still tell side-by-side installs apart.
export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel | null {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return null;
}
