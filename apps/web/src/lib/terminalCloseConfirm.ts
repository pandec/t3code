import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

/**
 * For individual closes (drawer/panel buttons, `terminal.close`, the tab strip);
 * auto-exit cleanup and bulk tab closes skip it. Awaits hydration because the
 * pre-hydration snapshot is the schema default and would prompt even when
 * `confirmTerminalClose` is off.
 */
export async function confirmTerminalClose(
  labels: readonly [string, ...string[]],
): Promise<boolean> {
  await ensureClientSettingsHydrated();
  if (!getClientSettings().confirmTerminalClose) return true;
  const localApi = readLocalApi();
  if (!localApi) return true;
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [
            `Close terminal "${labels[0]}"?`,
            "This stops the running process and clears its history.",
          ].join("\n")
        : [
            `Close ${labels.length} terminals?`,
            `This stops their running processes and clears their histories: ${labels
              .map((label) => `"${label}"`)
              .join(", ")}.`,
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
