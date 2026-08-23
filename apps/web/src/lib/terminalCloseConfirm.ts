import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

/** Whether a terminal-close confirmation is currently waiting on the user. */
export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

/**
 * Confirmation for individual terminal close actions: drawer buttons, panel
 * buttons, the `terminal.close` keybinding, and closing a terminal surface from
 * the tab strip. Auto-exit cleanup and bulk tab closes skip this path and close
 * directly.
 *
 * The `confirmTerminalClose` setting turns the prompt off. The pre-hydration
 * snapshot is the schema default, so a close early in a cold start would ask
 * even though the user turned the prompt off; awaiting hydration reads the
 * persisted answer instead.
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
