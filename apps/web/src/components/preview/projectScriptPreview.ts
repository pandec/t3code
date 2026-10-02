/** How long a started action waits for its dev server before opening the configured URL. */
export const PROJECT_SCRIPT_PREVIEW_WAIT_MS = 60_000;

/**
 * Opens an action's preview path on the dev server detected for its workspace,
 * so the configured URL's port never has to match the server's actual port.
 */
export function workspaceServerPreviewUrl(serverUrl: string, previewUrl: string): string {
  const target = new URL(serverUrl);
  try {
    const configured = new URL(previewUrl, target);
    target.pathname = configured.pathname;
    target.search = configured.search;
    target.hash = configured.hash;
  } catch {
    // An unparseable preview URL falls back to the server root.
  }
  return target.href;
}
