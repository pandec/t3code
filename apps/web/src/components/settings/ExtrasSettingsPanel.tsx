import { useCallback, useState, type CSSProperties } from "react";
import {
  clampAccentTintIntensityPercent,
  clampSteerGraceWindowMs,
  clampTurnCompletionMinDurationSeconds,
  DEFAULT_UNIFIED_SETTINGS,
  MAX_ACCENT_TINT_INTENSITY_PERCENT,
  MAX_PROVIDER_USAGE_ALERT_PERCENT,
  MAX_STEER_GRACE_WINDOW_MS,
  MAX_TURN_COMPLETION_MIN_DURATION_SECONDS,
  MIN_ACCENT_TINT_INTENSITY_PERCENT,
  MIN_PROVIDER_USAGE_ALERT_PERCENT,
  MIN_STEER_GRACE_WINDOW_MS,
  MIN_TURN_COMPLETION_MIN_DURATION_SECONDS,
  type SidebarThreadProviderIconVisibility,
} from "@t3tools/contracts/settings";

import { isElectron } from "../../env";
import {
  usePrimarySettings,
  useSidebarV2Enabled,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import {
  buildNotificationSettingsSupportText,
  readBrowserNotificationPermissionState,
  requestBrowserNotificationPermission,
  showSystemNotification,
} from "../../notifications/turnCompletion";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import {
  NumberField,
  NumberFieldGroup,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { resolveProviderUsageThresholdCommit } from "./ExtrasSettingsPanel.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const THREAD_PROVIDER_ICON_LABELS: Record<SidebarThreadProviderIconVisibility, string> = {
  hover: "On hover",
  always: "Always",
  never: "Never",
};

/**
 * Mirrors the server's built-in ElevenLabs defaults (`DEFAULT_ELEVENLABS_TTS_*`
 * in `apps/server/src/voice/MessageSpeech.ts`). Duplicated as placeholder copy
 * only — the client never sends these, it sends "" to mean "leave it to the
 * server" — but keep the two in sync when the server default changes.
 */
const DEFAULT_TTS_MODEL_PLACEHOLDER = "eleven_flash_v2_5";
const DEFAULT_TTS_VOICE_PLACEHOLDER = "JBFqnCBsd6RMkjVDRZzb";

/** Half-second granularity keeps the steer window readable in seconds. */
const STEER_GRACE_WINDOW_STEP_MS = 500;

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function sliderFillStyle(value: number, minimum: number, maximum: number): CSSProperties {
  const ratio = maximum === minimum ? 0 : (value - minimum) / (maximum - minimum);
  return {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
}

/**
 * Numeric settings control that writes on commit (blur, Enter, or a stepper
 * release) rather than per keystroke, so a value that is clamped on the way in
 * cannot fight the user mid-edit.
 */
function SettingsNumberField({
  ariaLabel,
  max,
  min,
  onCommit,
  suffix,
  value,
}: {
  readonly ariaLabel: string;
  readonly max: number;
  readonly min: number;
  readonly onCommit: (value: number | null) => void;
  readonly suffix: string;
  readonly value: number;
}) {
  return (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <NumberField
        className="w-28"
        max={max}
        min={min}
        onValueCommitted={(next) => onCommit(next)}
        size="sm"
        step={1}
        value={value}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={`Decrease ${ariaLabel}`} />
          <NumberFieldInput aria-label={ariaLabel} />
          <NumberFieldIncrement aria-label={`Increase ${ariaLabel}`} />
        </NumberFieldGroup>
      </NumberField>
      <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>
    </div>
  );
}

function NotificationsExtrasSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [browserPermissionState, setBrowserPermissionState] = useState(
    readBrowserNotificationPermissionState,
  );

  const handleSystemNotificationsChange = useCallback(
    async (checked: boolean) => {
      if (!checked || isElectron) {
        updateSettings({ enableTurnCompletionSystemNotifications: checked });
        return;
      }
      const permissionState = await requestBrowserNotificationPermission();
      setBrowserPermissionState(permissionState);
      if (permissionState === "granted") {
        updateSettings({ enableTurnCompletionSystemNotifications: true });
        return;
      }
      updateSettings({ enableTurnCompletionSystemNotifications: false });
      toastManager.add({
        type: "warning",
        title: "System notifications unavailable",
        description: buildNotificationSettingsSupportText(permissionState),
      });
    },
    [updateSettings],
  );

  const handleTestNotification = useCallback(async () => {
    const shown = await showSystemNotification({
      title: "Test notification",
      body: "This is how a finished agent turn will be announced.",
    });
    if (!shown) {
      toastManager.add({
        type: "warning",
        title: "Could not show a test notification",
        description: buildNotificationSettingsSupportText(readBrowserNotificationPermissionState()),
      });
    }
  }, []);

  const minDurationSeconds = clampTurnCompletionMinDurationSeconds(
    settings.turnCompletionMinDurationSeconds,
  );
  const thresholds = {
    providerUsageWarningPercent: settings.providerUsageWarningPercent,
    providerUsageCriticalPercent: settings.providerUsageCriticalPercent,
  };

  return (
    <SettingsSection title="Notifications">
      <SettingsRow
        title="Completion toasts"
        description="Show an in-app toast when an agent turn finishes."
        resetAction={
          settings.enableTurnCompletionToasts !==
          DEFAULT_UNIFIED_SETTINGS.enableTurnCompletionToasts ? (
            <SettingResetButton
              label="completion toasts"
              onClick={() =>
                updateSettings({
                  enableTurnCompletionToasts: DEFAULT_UNIFIED_SETTINGS.enableTurnCompletionToasts,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.enableTurnCompletionToasts}
            onCheckedChange={(checked) =>
              updateSettings({ enableTurnCompletionToasts: Boolean(checked) })
            }
            aria-label="Show completion toasts"
          />
        }
      />

      <SettingsRow
        title="System notifications"
        description={`Notify through the operating system when an agent turn finishes while the app is in the background. ${buildNotificationSettingsSupportText(browserPermissionState)}`}
        resetAction={
          settings.enableTurnCompletionSystemNotifications !==
          DEFAULT_UNIFIED_SETTINGS.enableTurnCompletionSystemNotifications ? (
            <SettingResetButton
              label="system notifications"
              onClick={() =>
                updateSettings({
                  enableTurnCompletionSystemNotifications:
                    DEFAULT_UNIFIED_SETTINGS.enableTurnCompletionSystemNotifications,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-3">
            <Button size="xs" variant="outline" onClick={() => void handleTestNotification()}>
              Test
            </Button>
            <Switch
              checked={settings.enableTurnCompletionSystemNotifications}
              onCheckedChange={(checked) => void handleSystemNotificationsChange(Boolean(checked))}
              aria-label="Show system notifications"
            />
          </div>
        }
      />

      <SettingsRow
        title="Minimum turn duration"
        description="Skip both the toast and the system notification for turns that finish faster than this. 0 announces every completed turn."
        resetAction={
          minDurationSeconds !== DEFAULT_UNIFIED_SETTINGS.turnCompletionMinDurationSeconds ? (
            <SettingResetButton
              label="minimum turn duration"
              onClick={() =>
                updateSettings({
                  turnCompletionMinDurationSeconds:
                    DEFAULT_UNIFIED_SETTINGS.turnCompletionMinDurationSeconds,
                })
              }
            />
          ) : null
        }
        control={
          <SettingsNumberField
            ariaLabel="Minimum turn duration in seconds"
            max={MAX_TURN_COMPLETION_MIN_DURATION_SECONDS}
            min={MIN_TURN_COMPLETION_MIN_DURATION_SECONDS}
            onCommit={(next) => {
              if (next === null) return;
              updateSettings({
                turnCompletionMinDurationSeconds: clampTurnCompletionMinDurationSeconds(next),
              });
            }}
            suffix="seconds"
            value={minDurationSeconds}
          />
        }
      />

      <SettingsRow
        title="Rate limit alerts"
        description="Warn once per rate-limit window when subscription usage crosses the warning or critical threshold."
        resetAction={
          settings.enableRateLimitAlerts !== DEFAULT_UNIFIED_SETTINGS.enableRateLimitAlerts ? (
            <SettingResetButton
              label="rate limit alerts"
              onClick={() =>
                updateSettings({
                  enableRateLimitAlerts: DEFAULT_UNIFIED_SETTINGS.enableRateLimitAlerts,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.enableRateLimitAlerts}
            onCheckedChange={(checked) =>
              updateSettings({ enableRateLimitAlerts: Boolean(checked) })
            }
            aria-label="Warn about rate limit usage"
          />
        }
      />

      <SettingsRow
        title="Warning threshold"
        description="Usage at which the quota ring turns amber and the first rate limit alert fires. Never exceeds the critical threshold."
        resetAction={
          settings.providerUsageWarningPercent !==
          DEFAULT_UNIFIED_SETTINGS.providerUsageWarningPercent ? (
            <SettingResetButton
              label="warning threshold"
              onClick={() =>
                updateSettings(
                  resolveProviderUsageThresholdCommit({
                    field: "warning",
                    value: DEFAULT_UNIFIED_SETTINGS.providerUsageWarningPercent,
                    current: thresholds,
                  }),
                )
              }
            />
          ) : null
        }
        control={
          <SettingsNumberField
            ariaLabel="Usage warning threshold"
            max={MAX_PROVIDER_USAGE_ALERT_PERCENT}
            min={MIN_PROVIDER_USAGE_ALERT_PERCENT}
            onCommit={(next) =>
              updateSettings(
                resolveProviderUsageThresholdCommit({
                  field: "warning",
                  value: next,
                  current: thresholds,
                }),
              )
            }
            suffix="%"
            value={settings.providerUsageWarningPercent}
          />
        }
      />

      <SettingsRow
        title="Critical threshold"
        description="Usage at which the quota ring turns red and a second alert fires. Lowering it past the warning threshold pulls that one down too."
        resetAction={
          settings.providerUsageCriticalPercent !==
          DEFAULT_UNIFIED_SETTINGS.providerUsageCriticalPercent ? (
            <SettingResetButton
              label="critical threshold"
              onClick={() =>
                updateSettings(
                  resolveProviderUsageThresholdCommit({
                    field: "critical",
                    value: DEFAULT_UNIFIED_SETTINGS.providerUsageCriticalPercent,
                    current: thresholds,
                  }),
                )
              }
            />
          ) : null
        }
        control={
          <SettingsNumberField
            ariaLabel="Usage critical threshold"
            max={MAX_PROVIDER_USAGE_ALERT_PERCENT}
            min={MIN_PROVIDER_USAGE_ALERT_PERCENT}
            onCommit={(next) =>
              updateSettings(
                resolveProviderUsageThresholdCommit({
                  field: "critical",
                  value: next,
                  current: thresholds,
                }),
              )
            }
            suffix="%"
            value={settings.providerUsageCriticalPercent}
          />
        }
      />
    </SettingsSection>
  );
}

function SidebarExtrasSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const sidebarV2Enabled = useSidebarV2Enabled();

  return (
    <SettingsSection title="Sidebar">
      <SettingsRow
        title="Thread provider icon"
        description="Choose whether thread rows show their provider only on hover, at all times, or never."
        resetAction={
          settings.sidebarThreadProviderIconVisibility !==
          DEFAULT_UNIFIED_SETTINGS.sidebarThreadProviderIconVisibility ? (
            <SettingResetButton
              label="thread provider icon"
              onClick={() =>
                updateSettings({
                  sidebarThreadProviderIconVisibility:
                    DEFAULT_UNIFIED_SETTINGS.sidebarThreadProviderIconVisibility,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.sidebarThreadProviderIconVisibility}
            onValueChange={(value) => {
              if (value === "hover" || value === "always" || value === "never") {
                updateSettings({ sidebarThreadProviderIconVisibility: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="Thread provider icon">
              <SelectValue>
                {THREAD_PROVIDER_ICON_LABELS[settings.sidebarThreadProviderIconVisibility]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(THREAD_PROVIDER_ICON_LABELS).map(([value, label]) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      {sidebarV2Enabled ? (
        <SettingsRow
          title="Compact thread cards"
          description="Show active threads in two lines: the branch line is hidden and its metadata moves beside the title."
          resetAction={
            settings.sidebarV2CompactCards !== DEFAULT_UNIFIED_SETTINGS.sidebarV2CompactCards ? (
              <SettingResetButton
                label="compact thread cards"
                onClick={() =>
                  updateSettings({
                    sidebarV2CompactCards: DEFAULT_UNIFIED_SETTINGS.sidebarV2CompactCards,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sidebarV2CompactCards}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarV2CompactCards: Boolean(checked) })
              }
              aria-label="Compact sidebar v2 thread cards"
            />
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function ComposerExtrasSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const steerGraceWindowMs = clampSteerGraceWindowMs(settings.steerGraceWindowMs);

  return (
    <SettingsSection title="Composer">
      <SettingsRow
        title="Steer grace window"
        description="How long a steered message waits in the composer before it is sent to the running agent. Until the window elapses the message can still be edited or recalled; 0s locks it in immediately."
        resetAction={
          steerGraceWindowMs !== DEFAULT_UNIFIED_SETTINGS.steerGraceWindowMs ? (
            <SettingResetButton
              label="steer grace window"
              onClick={() =>
                updateSettings({
                  steerGraceWindowMs: DEFAULT_UNIFIED_SETTINGS.steerGraceWindowMs,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center gap-3 sm:w-52">
            <output
              className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
              htmlFor="steer-grace-window"
            >
              {formatSeconds(steerGraceWindowMs)}
            </output>
            <input
              aria-label="Steer grace window in seconds"
              className="settings-range-slider min-w-0 flex-1"
              id="steer-grace-window"
              max={MAX_STEER_GRACE_WINDOW_MS}
              min={MIN_STEER_GRACE_WINDOW_MS}
              onChange={(event) =>
                updateSettings({
                  steerGraceWindowMs: clampSteerGraceWindowMs(Number(event.currentTarget.value)),
                })
              }
              step={STEER_GRACE_WINDOW_STEP_MS}
              style={sliderFillStyle(
                steerGraceWindowMs,
                MIN_STEER_GRACE_WINDOW_MS,
                MAX_STEER_GRACE_WINDOW_MS,
              )}
              type="range"
              value={steerGraceWindowMs}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}

function AccentTintsExtrasSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const intensityPercent = clampAccentTintIntensityPercent(settings.accentTintIntensityPercent);

  return (
    <SettingsSection title="Accent tints">
      <SettingsRow
        title="Project accent tints"
        description="Wash a project's accent color over its thread rows and new-thread choices. Off keeps the color as a dot only. Colors themselves are set per project from the project menu in the sidebar."
        resetAction={
          settings.accentTintsEnabled !== DEFAULT_UNIFIED_SETTINGS.accentTintsEnabled ? (
            <SettingResetButton
              label="project accent tints"
              onClick={() =>
                updateSettings({ accentTintsEnabled: DEFAULT_UNIFIED_SETTINGS.accentTintsEnabled })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.accentTintsEnabled}
            onCheckedChange={(checked) => updateSettings({ accentTintsEnabled: Boolean(checked) })}
            aria-label="Tint surfaces with project accent colors"
          />
        }
      />

      <SettingsRow
        title="Tint intensity"
        description="How strongly the accent color washes over a tinted row."
        resetAction={
          intensityPercent !== DEFAULT_UNIFIED_SETTINGS.accentTintIntensityPercent ? (
            <SettingResetButton
              label="tint intensity"
              onClick={() =>
                updateSettings({
                  accentTintIntensityPercent: DEFAULT_UNIFIED_SETTINGS.accentTintIntensityPercent,
                })
              }
            />
          ) : null
        }
        control={
          <div
            className={`flex w-full items-center gap-3 sm:w-52 ${
              settings.accentTintsEnabled ? "" : "opacity-50"
            }`}
          >
            <output
              className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
              htmlFor="accent-tint-intensity"
            >
              {intensityPercent}%
            </output>
            <input
              aria-label="Accent tint intensity"
              className="settings-range-slider min-w-0 flex-1"
              disabled={!settings.accentTintsEnabled}
              id="accent-tint-intensity"
              max={MAX_ACCENT_TINT_INTENSITY_PERCENT}
              min={MIN_ACCENT_TINT_INTENSITY_PERCENT}
              onChange={(event) =>
                updateSettings({
                  accentTintIntensityPercent: clampAccentTintIntensityPercent(
                    Number(event.currentTarget.value),
                  ),
                })
              }
              step={1}
              style={sliderFillStyle(
                intensityPercent,
                MIN_ACCENT_TINT_INTENSITY_PERCENT,
                MAX_ACCENT_TINT_INTENSITY_PERCENT,
              )}
              type="range"
              value={intensityPercent}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}

function VoiceExtrasSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsSection title="Voice & Listening">
      <SettingsRow
        title="Text-to-speech model"
        description="ElevenLabs model used to read assistant messages aloud. Leave empty to use the server's configured default."
        resetAction={
          settings.voice.ttsModelId !== DEFAULT_UNIFIED_SETTINGS.voice.ttsModelId ? (
            <SettingResetButton
              label="text-to-speech model"
              onClick={() =>
                updateSettings({
                  voice: { ttsModelId: DEFAULT_UNIFIED_SETTINGS.voice.ttsModelId },
                })
              }
            />
          ) : null
        }
        control={
          <DraftInput
            className="w-full sm:w-72"
            value={settings.voice.ttsModelId}
            onCommit={(next) => updateSettings({ voice: { ttsModelId: next } })}
            placeholder={DEFAULT_TTS_MODEL_PLACEHOLDER}
            spellCheck={false}
            aria-label="Text-to-speech model"
          />
        }
      />

      <SettingsRow
        title="Text-to-speech voice"
        description="ElevenLabs voice id used for playback. Leave empty to use the server's configured default."
        resetAction={
          settings.voice.ttsVoiceId !== DEFAULT_UNIFIED_SETTINGS.voice.ttsVoiceId ? (
            <SettingResetButton
              label="text-to-speech voice"
              onClick={() =>
                updateSettings({
                  voice: { ttsVoiceId: DEFAULT_UNIFIED_SETTINGS.voice.ttsVoiceId },
                })
              }
            />
          ) : null
        }
        control={
          <DraftInput
            className="w-full sm:w-72"
            value={settings.voice.ttsVoiceId}
            onCommit={(next) => updateSettings({ voice: { ttsVoiceId: next } })}
            placeholder={DEFAULT_TTS_VOICE_PLACEHOLDER}
            spellCheck={false}
            aria-label="Text-to-speech voice id"
          />
        }
      />

      <p className="max-w-xl px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        Speech playback needs <code>ELEVENLABS_API_KEY</code> in the server's environment. When set,
        these fields override the server's <code>ELEVENLABS_TTS_MODEL</code> and{" "}
        <code>ELEVENLABS_TTS_VOICE_ID</code> environment variables.
      </p>
    </SettingsSection>
  );
}

export function ExtrasSettingsPanel() {
  return (
    <SettingsPageContainer>
      <NotificationsExtrasSection />
      <SidebarExtrasSection />
      <ComposerExtrasSection />
      <AccentTintsExtrasSection />
      <VoiceExtrasSection />
    </SettingsPageContainer>
  );
}
