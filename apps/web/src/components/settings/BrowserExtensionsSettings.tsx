import {
  browserExtensionSettings,
  resolveBrowserProfiles,
  updateBrowserExtensionSettings,
  type BrowserExtensionSettings,
  type DesktopBrowserExtensionInstallation,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import {
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrated,
} from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const extensionsBridge = previewBridge?.extensions ?? null;

/** Patches from the saved setting, not a render's copy, so quick successive changes all apply. */
const updateExtension = (
  extensionId: string,
  patch: (setting: BrowserExtensionSettings) => Partial<BrowserExtensionSettings>,
) =>
  void persistClientSettingsUpdate((current) => ({
    ...current,
    browserExtensions: updateBrowserExtensionSettings(
      current.browserExtensions,
      extensionId,
      patch(browserExtensionSettings(current.browserExtensions, extensionId)),
    ),
  }));

function updateSummary(installation: DesktopBrowserExtensionInstallation): string | null {
  const update = installation.update;
  if (update === undefined) return null;
  if (update.activity === "checking") return "Checking for updates…";
  if (update.activity === "downloading") return "Downloading the new version…";
  if (update.activity === "updating") return "Restarting on the new version…";
  const parts = [
    update.readyVersion !== null ? `v${update.readyVersion} is ready to install.` : null,
    update.error,
    update.readyVersion === null && update.error === null && update.checkedAt !== null
      ? `Up to date, checked ${formatRelativeTimeLabel(update.checkedAt)}.`
      : null,
  ];
  return parts.filter((part) => part !== null).join(" ") || null;
}

/** Desktop-only; other clients have no extension runtime and show nothing. */
export function BrowserExtensionsSettings() {
  if (extensionsBridge === null) return null;
  return (
    <SettingsSection id="browser-extensions" title="Extensions">
      <BrowserExtensionRows bridge={extensionsBridge} />
    </SettingsSection>
  );
}

function BrowserExtensionRows({
  bridge,
}: {
  readonly bridge: NonNullable<typeof extensionsBridge>;
}) {
  const [installations, setInstallations] =
    useState<ReadonlyArray<DesktopBrowserExtensionInstallation> | null>(null);
  const extensions = useClientSettings((settings) => settings.browserExtensions);
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const hydrated = useClientSettingsHydrated();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installs and update checks run in the desktop main process, which reports changes
  useEffect(() => {
    let active = true;
    let latest = 0;
    const load = () => {
      latest += 1;
      const request = latest;
      // Overlapping loads can settle out of order; only the newest may apply.
      void bridge.listInstallations().then(
        (next) => active && request === latest && setInstallations(next),
        () => undefined,
      );
    };
    load();
    const unsubscribe = bridge.onInstallationsChange(load);
    // Relative check times go stale while the window is in the background.
    window.addEventListener("focus", load);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("focus", load);
    };
  }, [bridge]);

  // Extensions need a persistent session; incognito tabs never run them.
  const profiles = resolveBrowserProfiles(userProfiles).filter(
    (profile) => profile.kind === "persistent",
  );

  return installations?.map((installation) => {
    const setting = browserExtensionSettings(extensions, installation.id);
    const update = installation.update;
    const busy = update !== undefined && update.activity !== "idle";
    const summary = updateSummary(installation);
    return (
      <SettingsRow
        key={installation.id}
        title={installation.name}
        description={
          <>
            {installation.version === null
              ? "Not installed. Turn it on, then press Install."
              : `Installed v${installation.version}. Runs in the profiles checked below, never in Incognito. Reopen tabs that were open before turning it on.`}
            {summary === null ? null : <span className="block">{summary}</span>}
          </>
        }
        control={
          <Switch
            disabled={!hydrated}
            checked={setting.enabled}
            onCheckedChange={(checked) =>
              updateExtension(installation.id, () => ({ enabled: Boolean(checked) }))
            }
            aria-label={`Enable ${installation.name}`}
          />
        }
      >
        {setting.enabled && update !== undefined ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void bridge.checkForUpdates(installation.id)}
            >
              {installation.version === null ? "Install" : "Check for updates"}
            </Button>
            {update.readyVersion === null ? null : (
              <>
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => void bridge.applyUpdate(installation.id)}
                >
                  Update now
                </Button>
                <span className="text-xs text-muted-foreground">
                  Restarts {installation.name}, which locks your vault.
                </span>
              </>
            )}
          </div>
        ) : null}
        {setting.enabled ? (
          <div className="mt-2 mb-2 overflow-hidden rounded-lg border border-border/60">
            {profiles.map((profile, index) => (
              <label
                key={profile.id}
                className={cn(
                  "flex cursor-pointer items-center gap-3 px-3 py-2 text-sm text-foreground",
                  index > 0 && "border-t border-border/60",
                )}
              >
                <Checkbox
                  disabled={!hydrated}
                  checked={setting.profileIds.includes(profile.id)}
                  onCheckedChange={(checked) =>
                    updateExtension(installation.id, ({ profileIds }) => ({
                      profileIds:
                        checked === true
                          ? [...profileIds.filter((id) => id !== profile.id), profile.id]
                          : profileIds.filter((id) => id !== profile.id),
                    }))
                  }
                />
                <span className="truncate">{profile.name}</span>
              </label>
            ))}
          </div>
        ) : null}
      </SettingsRow>
    );
  });
}
