import { useCallback, useMemo, useRef, type CSSProperties } from "react";
import {
  clampArchivedSectionVisibleCount,
  clampAccentTintIntensityPercent,
  clampSteerGraceWindowMs,
  DEFAULT_UNIFIED_SETTINGS,
  MAX_ARCHIVED_SECTION_VISIBLE_COUNT,
  MAX_ACCENT_TINT_INTENSITY_PERCENT,
  MAX_OPENROUTER_CREDITS_BUDGET_USD,
  MAX_PROVIDER_USAGE_ALERT_PERCENT,
  MAX_STEER_GRACE_WINDOW_MS,
  MIN_ACCENT_TINT_INTENSITY_PERCENT,
  MIN_ARCHIVED_SECTION_VISIBLE_COUNT,
  MIN_OPENROUTER_CREDITS_BUDGET_USD,
  MIN_PROVIDER_USAGE_ALERT_PERCENT,
  MIN_STEER_GRACE_WINDOW_MS,
  type SidebarThreadProviderIconVisibility,
} from "@t3tools/contracts/settings";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { normalizeLinearTeamKeys } from "@t3tools/contracts/settings";
import { formatUsd } from "@t3tools/shared/usageFormat";

import { useEnvironments } from "../../state/environments";
import { useServerConfigs } from "../../state/entities";
import { environmentReadsLinearIssues } from "../../lib/openLinearLink";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { linearEnvironment } from "../../state/linear";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  usePrimarySettings,
  useLegacySidebarEnabled,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
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
import {
  resolveOpenRouterCreditsBudgetCommit,
  resolveProviderUsageThresholdCommit,
} from "./ExtrasSettingsPanel.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { VoiceSettingsSection } from "./VoiceSettingsSection";

const THREAD_PROVIDER_ICON_LABELS: Record<SidebarThreadProviderIconVisibility, string> = {
  hover: "On hover",
  always: "Always",
  never: "Never",
};

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
  placeholder,
  prefix,
  suffix,
  value,
}: {
  readonly ariaLabel: string;
  readonly max: number;
  readonly min: number;
  readonly onCommit: (value: number | null) => void;
  readonly placeholder?: string;
  readonly prefix?: string;
  readonly suffix?: string;
  /** Null renders an empty field, for settings where unset is a real state. */
  readonly value: number | null;
}) {
  return (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      {prefix ? <span className="shrink-0 text-xs text-muted-foreground">{prefix}</span> : null}
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
          <NumberFieldInput aria-label={ariaLabel} placeholder={placeholder} />
          <NumberFieldIncrement aria-label={`Increase ${ariaLabel}`} />
        </NumberFieldGroup>
      </NumberField>
      {suffix ? <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

/** One environment's stored-key state and balance under the key field. */
function OpenRouterCreditsEnvironmentStatus({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.openRouterCredits({ environmentId, input: {} }),
  );
  let status: string;
  // The transport error outranks `data`: the query keeps the previous
  // success on failure, so a disconnected environment would otherwise show
  // its last balance as current forever. This also covers a server build
  // that predates the credits RPC.
  if (query.error !== null) {
    status = "Unavailable";
  } else if (query.data !== null) {
    const { configured, snapshot, error } = query.data;
    if (!configured) {
      // An unreadable secret store also reports unconfigured; its error
      // must win over "No management key", which suggests the wrong remedy.
      status = error ?? "No management key";
    } else if (snapshot !== null) {
      // A retained stale balance still says the last read failed, so a
      // revoked key can't hide behind yesterday's number.
      status = `${formatUsd(snapshot.totalCreditsUsd - snapshot.totalUsageUsd)} remaining${
        error !== undefined ? " · last read failed" : ""
      }`;
    } else {
      status = error ?? "No data";
    }
  } else {
    status = "Checking…";
  }
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-muted-foreground/80">{status}</span>
    </div>
  );
}

/** Key configuration targets: environments whose grant includes `settings:write`. */
function useSettingsWritableEnvironments<T extends { readonly environmentId: EnvironmentId }>(
  environments: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const writableIds = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  return useMemo(
    () => environments.filter((environment) => writableIds.has(environment.environmentId)),
    [environments, writableIds],
  );
}

function ProviderUsageExtrasSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const { environments } = useEnvironments();
  const writableEnvironments = useSettingsWritableEnvironments(environments);
  const configureOpenRouterCredits = useAtomCommand(serverEnvironment.configureOpenRouterCredits);
  const thresholds = {
    providerUsageWarningPercent: settings.providerUsageWarningPercent,
    providerUsageCriticalPercent: settings.providerUsageCriticalPercent,
  };

  // The balance is account-wide and the meter reads it from whichever
  // environment the active thread runs on, so a save applies the key to
  // every environment this client may configure rather than making the user pick one.
  const runOpenRouterApiKeyApply = useCallback(
    async (apiKey: string) => {
      if (writableEnvironments.length === 0) {
        toastManager.add({
          type: "warning",
          title: "No writable environments connected",
          description:
            "Connect an environment that allows settings changes before saving the OpenRouter management key.",
        });
        return;
      }
      const results = await Promise.all(
        writableEnvironments.map(async (environment) => ({
          label: environment.label,
          result: await configureOpenRouterCredits({
            environmentId: environment.environmentId,
            input: { apiKey },
          }),
        })),
      );
      // Interrupted counts as failed: the write did not verifiably land on
      // that environment, and a success toast would claim it did.
      const failed = results
        .filter(({ result }) => result._tag === "Failure")
        .map(({ label }) => label);
      const removed = apiKey.trim().length === 0;
      if (failed.length === 0) {
        toastManager.add({
          type: "success",
          title: removed ? "OpenRouter API key removed" : "OpenRouter API key saved",
        });
        return;
      }
      toastManager.add({
        type: "warning",
        title: removed
          ? "Could not remove the key everywhere"
          : "Could not save the key everywhere",
        description: `Failed for: ${failed.join(", ")}.`,
      });
    },
    [configureOpenRouterCredits, writableEnvironments],
  );

  // Applies run strictly in click order. The configure command's
  // single-flight lanes are keyed by payload, so without this chain a reset
  // clicked during a still-running save would race it — and could lose,
  // leaving the key configured after the user removed it.
  const pendingApplyRef = useRef<Promise<void>>(Promise.resolve());
  const applyOpenRouterApiKey = useCallback(
    (apiKey: string) => {
      const chained = pendingApplyRef.current.then(() => runOpenRouterApiKeyApply(apiKey));
      pendingApplyRef.current = chained;
      return chained;
    },
    [runOpenRouterApiKeyApply],
  );

  return (
    <SettingsSection {...searchableSetting("extras-provider-usage")}>
      <SettingsRow
        title="Mask provider emails"
        description="Obscure provider account email addresses in the usage meter."
        resetAction={
          settings.maskProviderUsageEmails !== DEFAULT_UNIFIED_SETTINGS.maskProviderUsageEmails ? (
            <SettingResetButton
              label="provider email masking"
              onClick={() =>
                updateSettings({
                  maskProviderUsageEmails: DEFAULT_UNIFIED_SETTINGS.maskProviderUsageEmails,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.maskProviderUsageEmails}
            onCheckedChange={(checked) =>
              updateSettings({ maskProviderUsageEmails: Boolean(checked) })
            }
            aria-label="Mask provider emails in usage meter"
          />
        }
      />

      <SettingsRow
        title="Warning threshold"
        description="Usage at which the quota ring turns amber. Never exceeds the critical threshold."
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
        description="Usage at which the quota ring turns red. Lowering it past the warning threshold pulls that one down too."
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
      <SettingsRow
        {...searchableSetting("openrouter-credits")}
        title="OpenRouter credits"
        description="Show your OpenRouter credit balance in the usage meter popover."
        resetAction={
          settings.showOpenRouterCredits !== DEFAULT_UNIFIED_SETTINGS.showOpenRouterCredits ? (
            <SettingResetButton
              label="OpenRouter credits"
              onClick={() =>
                updateSettings({
                  showOpenRouterCredits: DEFAULT_UNIFIED_SETTINGS.showOpenRouterCredits,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.showOpenRouterCredits}
            onCheckedChange={(checked) =>
              updateSettings({ showOpenRouterCredits: Boolean(checked) })
            }
            aria-label="Show OpenRouter credits in the usage meter"
          />
        }
      />

      {settings.showOpenRouterCredits ? (
        <>
          <SettingsRow
            title="OpenRouter management key"
            description="A management key from openrouter.ai/settings/management-keys — the credits endpoint rejects regular inference keys. Stored in each environment's secret store, only used server-side to read the balance, and applied to every connected environment on save."
            resetAction={
              <SettingResetButton
                label="OpenRouter management key"
                onClick={() => void applyOpenRouterApiKey("")}
              />
            }
            control={
              <DraftInput
                className="w-full sm:w-72"
                value=""
                onCommit={(next) => {
                  const trimmed = next.trim();
                  if (trimmed.length > 0) void applyOpenRouterApiKey(trimmed);
                }}
                type="password"
                autoComplete="off"
                placeholder="Management key"
                spellCheck={false}
                aria-label="OpenRouter management key"
              />
            }
          />
          <div className="flex max-w-xl flex-col gap-1 px-3 text-xs leading-normal sm:px-4">
            {environments.map((environment) => (
              <OpenRouterCreditsEnvironmentStatus
                key={environment.environmentId}
                environmentId={environment.environmentId}
                label={environment.label}
              />
            ))}
          </div>
          <SettingsRow
            title="OpenRouter budget"
            description="The starting balance to measure spend against. With a budget set, the usage meter shows how much of it you have spent, coloured by the warning and critical thresholds above. Leave empty or enter 0 to show the dollar amount only; budgets under $1 count as none."
            resetAction={
              settings.openRouterCreditsBudgetUsd !==
              DEFAULT_UNIFIED_SETTINGS.openRouterCreditsBudgetUsd ? (
                <SettingResetButton
                  label="OpenRouter budget"
                  onClick={() =>
                    updateSettings({
                      openRouterCreditsBudgetUsd:
                        DEFAULT_UNIFIED_SETTINGS.openRouterCreditsBudgetUsd,
                    })
                  }
                />
              ) : null
            }
            control={
              <SettingsNumberField
                ariaLabel="OpenRouter budget"
                max={MAX_OPENROUTER_CREDITS_BUDGET_USD}
                min={MIN_OPENROUTER_CREDITS_BUDGET_USD}
                onCommit={(next) =>
                  updateSettings({
                    openRouterCreditsBudgetUsd: resolveOpenRouterCreditsBudgetCommit(next),
                  })
                }
                placeholder="None"
                prefix="$"
                value={settings.openRouterCreditsBudgetUsd}
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}

/** One environment's Linear connection: who the key belongs to and which workspace it reads. */
function LinearEnvironmentStatus({
  environmentId,
  label,
  onDetectedTeamKeys,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onDetectedTeamKeys: (teamKeys: ReadonlyArray<string>) => void;
}) {
  const query = useEnvironmentQuery(linearEnvironment.status({ environmentId, input: {} }));
  let status: string;
  let teamKeys: ReadonlyArray<string> = [];
  if (query.error !== null) {
    status = "Unavailable";
  } else if (query.data !== null) {
    const { configured, viewer, workspace, error } = query.data;
    if (!configured) {
      status = error ?? "No API key";
    } else if (viewer !== null && workspace !== null) {
      status = `${viewer.displayName} · ${workspace.urlKey}`;
      teamKeys = query.data.teamKeys;
    } else {
      status = error ?? "No data";
    }
  } else {
    status = "Checking…";
  }
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-baseline gap-2 text-muted-foreground/80">
        <span className="truncate">{status}</span>
        {teamKeys.length > 0 ? (
          <button
            type="button"
            className="shrink-0 cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => onDetectedTeamKeys(teamKeys)}
          >
            use detected: {teamKeys.join(", ")}
          </button>
        ) : null}
      </span>
    </div>
  );
}

function LinearExtrasSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverConfigs = useServerConfigs();
  // Only servers that expose the RPCs: an older one would reject the probe and read as a failure.
  const allEnvironments = useEnvironments().environments;
  const environments = useMemo(
    () =>
      allEnvironments.filter((environment) =>
        environmentReadsLinearIssues(serverConfigs, environment.environmentId),
      ),
    [allEnvironments, serverConfigs],
  );
  // Status rows cover every Linear-capable environment; the key is only written where allowed.
  const writableEnvironments = useSettingsWritableEnvironments(environments);
  const configureLinear = useAtomCommand(linearEnvironment.configure, { reportFailure: false });

  // Like the OpenRouter key, one personal key applies to every writable environment; the
  // server probes it before storing, so a rejected key never replaces a working one. The
  // command runs serially per environment, so a save and a clear in quick succession land in
  // the order they were asked for.
  const applyLinearApiKey = useCallback(
    async (apiKey: string) => {
      if (writableEnvironments.length === 0) {
        toastManager.add({
          type: "warning",
          title: "No writable environments connected",
          description:
            "Connect an environment that allows settings changes before saving the Linear API key.",
        });
        return;
      }
      const results = await Promise.all(
        writableEnvironments.map(async (environment) => ({
          label: environment.label,
          result: await configureLinear({
            environmentId: environment.environmentId,
            input: { apiKey },
          }),
        })),
      );
      const failed = results.filter(({ result }) => result._tag === "Failure");
      const removed = apiKey.trim().length === 0;
      if (failed.length === 0) {
        toastManager.add({
          type: "success",
          title: removed ? "Linear API key removed" : "Linear API key saved",
        });
        return;
      }
      const firstFailure = failed[0]!.result;
      toastManager.add({
        type: "warning",
        title: removed
          ? "Could not remove the key everywhere"
          : "Could not save the key everywhere",
        description: `Failed for: ${failed.map(({ label }) => label).join(", ")}.${
          firstFailure._tag === "Failure"
            ? ` ${formatEnvironmentQueryError(firstFailure.cause)}`
            : ""
        }`,
      });
    },
    [configureLinear, writableEnvironments],
  );
  const setTeamKeys = useCallback(
    (teamKeys: ReadonlyArray<string>) => updateSettings({ linearTeamKeys: teamKeys }),
    [updateSettings],
  );

  return (
    <SettingsSection {...searchableSetting("extras-linear")}>
      <SettingsRow
        title="Linear API key"
        description="A personal API key from linear.app/settings/account/security. Stored in each environment's secret store and only used server-side to read issues and post comments. Applied to every connected environment on save."
        resetAction={
          <SettingResetButton label="Linear API key" onClick={() => void applyLinearApiKey("")} />
        }
        control={
          <DraftInput
            className="w-full sm:w-72"
            value=""
            onCommit={(next) => {
              const trimmed = next.trim();
              if (trimmed.length > 0) void applyLinearApiKey(trimmed);
            }}
            type="password"
            autoComplete="off"
            placeholder="lin_api_…"
            spellCheck={false}
            aria-label="Linear API key"
          />
        }
      />
      <div className="flex max-w-xl flex-col gap-1 px-3 text-xs leading-normal sm:px-4">
        {environments.map((environment) => (
          <LinearEnvironmentStatus
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
            onDetectedTeamKeys={setTeamKeys}
          />
        ))}
      </div>
      <SettingsRow
        title="Linear team keys"
        description="Comma-separated team keys (for example SP, OP). Bare identifiers like SP-123 in messages become issue links only for these keys; linear.app links always open in the panel."
        resetAction={
          settings.linearTeamKeys.length > 0 ? (
            <SettingResetButton label="Linear team keys" onClick={() => setTeamKeys([])} />
          ) : null
        }
        control={
          <DraftInput
            key={settings.linearTeamKeys.join(",")}
            className="w-full sm:w-72"
            value={settings.linearTeamKeys.join(", ")}
            onCommit={(next) => setTeamKeys(normalizeLinearTeamKeys(next.split(",")))}
            autoComplete="off"
            placeholder="SP, OP"
            spellCheck={false}
            aria-label="Linear team keys"
          />
        }
      />
    </SettingsSection>
  );
}

function SidebarExtrasSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const defaultSidebarEnabled = !useLegacySidebarEnabled();
  const archivedSectionVisibleCount = clampArchivedSectionVisibleCount(
    settings.archivedSectionVisibleCount,
  );

  return (
    <SettingsSection {...searchableSetting("extras-sidebar")}>
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

      {defaultSidebarEnabled ? (
        <>
          <SettingsRow
            {...searchableSetting("sidebar-thread-groups-button")}
            description="Show a Thread groups button in the sidebar toolbar. The command palette can always open the same dialog."
            resetAction={
              settings.sidebarThreadGroupsButton !==
              DEFAULT_UNIFIED_SETTINGS.sidebarThreadGroupsButton ? (
                <SettingResetButton
                  label="thread groups button"
                  onClick={() =>
                    updateSettings({
                      sidebarThreadGroupsButton: DEFAULT_UNIFIED_SETTINGS.sidebarThreadGroupsButton,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.sidebarThreadGroupsButton}
                onCheckedChange={(checked) =>
                  updateSettings({ sidebarThreadGroupsButton: Boolean(checked) })
                }
                aria-label="Show thread groups button in the sidebar"
              />
            }
          />
          <SettingsRow
            title="New thread button in the project row"
            description="Show the New thread button at the end of the project filter row instead of the search row."
            resetAction={
              settings.sidebarV2NewThreadButtonInProjectRow !==
              DEFAULT_UNIFIED_SETTINGS.sidebarV2NewThreadButtonInProjectRow ? (
                <SettingResetButton
                  label="new thread button position"
                  onClick={() =>
                    updateSettings({
                      sidebarV2NewThreadButtonInProjectRow:
                        DEFAULT_UNIFIED_SETTINGS.sidebarV2NewThreadButtonInProjectRow,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.sidebarV2NewThreadButtonInProjectRow}
                onCheckedChange={(checked) =>
                  updateSettings({ sidebarV2NewThreadButtonInProjectRow: Boolean(checked) })
                }
                aria-label="Show new thread button in the project row"
              />
            }
          />

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
          <SettingsRow
            title="Recent archived threads"
            description="Choose how many recently archived threads appear at the end of Sidebar V2."
            resetAction={
              archivedSectionVisibleCount !==
              DEFAULT_UNIFIED_SETTINGS.archivedSectionVisibleCount ? (
                <SettingResetButton
                  label="recent archived threads"
                  onClick={() =>
                    updateSettings({
                      archivedSectionVisibleCount:
                        DEFAULT_UNIFIED_SETTINGS.archivedSectionVisibleCount,
                    })
                  }
                />
              ) : null
            }
            control={
              <SettingsNumberField
                ariaLabel="Recent archived threads"
                max={MAX_ARCHIVED_SECTION_VISIBLE_COUNT}
                min={MIN_ARCHIVED_SECTION_VISIBLE_COUNT}
                onCommit={(next) => {
                  if (next === null) return;
                  updateSettings({
                    archivedSectionVisibleCount: clampArchivedSectionVisibleCount(next),
                  });
                }}
                suffix="threads"
                value={archivedSectionVisibleCount}
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}

function PanelsExtrasSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsSection {...searchableSetting("extras-panels")}>
      <SettingsRow
        {...searchableSetting("panel-toggle-buttons")}
        description="Show the terminal drawer and right panel toggles in the thread header, including both panes of a split view. Their keyboard shortcuts work either way."
        resetAction={
          settings.showPanelToggleButtons !== DEFAULT_UNIFIED_SETTINGS.showPanelToggleButtons ? (
            <SettingResetButton
              label="panel toggle buttons"
              onClick={() =>
                updateSettings({
                  showPanelToggleButtons: DEFAULT_UNIFIED_SETTINGS.showPanelToggleButtons,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.showPanelToggleButtons}
            onCheckedChange={(checked) =>
              updateSettings({ showPanelToggleButtons: Boolean(checked) })
            }
            aria-label="Show panel toggle buttons"
          />
        }
      />
    </SettingsSection>
  );
}

function MessagesExtrasSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsSection {...searchableSetting("extras-messages")}>
      <SettingsRow
        {...searchableSetting("chat-wide-tables")}
        description="Let a table in an agent reply widen past the chat column, up to the width of the thread view, instead of scrolling sideways."
        resetAction={
          settings.chatWideTables !== DEFAULT_UNIFIED_SETTINGS.chatWideTables ? (
            <SettingResetButton
              label="wide tables"
              onClick={() =>
                updateSettings({ chatWideTables: DEFAULT_UNIFIED_SETTINGS.chatWideTables })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.chatWideTables}
            onCheckedChange={(checked) => updateSettings({ chatWideTables: Boolean(checked) })}
            aria-label="Wide tables"
          />
        }
      />
    </SettingsSection>
  );
}

function ComposerExtrasSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const steerGraceWindowMs = clampSteerGraceWindowMs(settings.steerGraceWindowMs);

  return (
    <SettingsSection {...searchableSetting("extras-composer")}>
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
              className="settings-slider min-w-0 flex-1"
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
    <SettingsSection {...searchableSetting("extras-accent-tints")}>
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
              className="settings-slider min-w-0 flex-1"
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

export function ExtrasSettingsPanel() {
  return (
    <SettingsPageContainer>
      <ProviderUsageExtrasSection />
      <LinearExtrasSection />
      <SidebarExtrasSection />
      <PanelsExtrasSection />
      <MessagesExtrasSection />
      <ComposerExtrasSection />
      <AccentTintsExtrasSection />
      <VoiceSettingsSection />
    </SettingsPageContainer>
  );
}
