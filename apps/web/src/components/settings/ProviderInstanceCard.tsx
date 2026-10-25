import { Spinner } from "~/components/ui/spinner";

import {
  AlertTriangleIcon,
  CheckIcon,
  ArrowUpCircleIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LayersIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Lock as LockGlyph, LockOpen } from "lucide";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  isProviderDriverKind,
  PROVIDER_USAGE_SOURCE_CLIPROXYAPI,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ProviderInstanceUsageSource,
  type AcpRegistryUrlAuthAction,
  type EnvironmentId,
  type ProjectId,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  type CustomModelDefinition,
  readCustomModelEntries,
  toCustomModelSetting,
} from "@t3tools/shared/model";
import { cn } from "../../lib/utils";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useStableCallback } from "../../hooks/useStableCallback";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { DraftInput } from "../ui/draft-input";
import { SecretInput } from "./SecretInput";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type {
  ProviderClientDefinition,
  ProviderEnvironmentField,
} from "@t3tools/provider-core/client";
import { deriveProviderSettingsFields, ProviderSettingsForm } from "./ProviderSettingsForm";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { AcpSessionManagementSection } from "./AcpSessionManagementSection";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { readCodexSetupMode } from "./CodexSetupSection.logic";
import {
  getProviderVersionAdvisoryPresentation,
  PROVIDER_STATUS_STYLES,
  getProviderStatusKey,
  getProviderSummary,
  getProviderVersionLabel,
} from "./providerStatus";

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function ProviderStatusDiagnostic({
  detail,
  children,
}: {
  detail: string | null;
  children: ReactElement;
}) {
  if (!detail) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="top">{detail}</TooltipPopup>
    </Tooltip>
  );
}

let environmentVariableDraftId = 0;
const nextEnvironmentVariableDraftId = () => `provider-env-${environmentVariableDraftId++}`;

type EnvironmentDraftRow = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
};

function makeEnvironmentDraftRow(
  variable: ProviderInstanceEnvironmentVariable,
  index: number,
): EnvironmentDraftRow {
  return {
    id: `${index}:${variable.name}`,
    name: variable.name,
    value: variable.value,
    sensitive: variable.sensitive,
    ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}),
  };
}

function providerEnvironmentsEqual(
  left: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  right: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): boolean {
  return (
    left.length === right.length &&
    left.every((variable, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        variable.name === other.name &&
        variable.value === other.value &&
        variable.sensitive === other.sensitive &&
        variable.valueRedacted === other.valueRedacted
      );
    })
  );
}

function readConfigCustomModels(config: unknown): ReadonlyArray<CustomModelDefinition> {
  if (config === null || typeof config !== "object") return [];
  return readCustomModelEntries((config as Record<string, unknown>).customModels);
}

function readConfigString(config: unknown, key: string): string | null {
  if (config === null || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** String-to-string record at `key` (e.g. `customModelIcons`), trimmed and null-prototype so
 * user-authored keys like "constructor" miss cleanly. */
const EMPTY_STRING_RECORD: Readonly<Record<string, string>> = Object.freeze(Object.create(null));

function readConfigStringRecord(config: unknown, key: string): Readonly<Record<string, string>> {
  if (config === null || typeof config !== "object") return EMPTY_STRING_RECORD;
  const value = (config as Record<string, unknown>)[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_STRING_RECORD;
  }
  const record: Record<string, string> = Object.create(null);
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") continue;
    const trimmedKey = entryKey.trim();
    const trimmedValue = entryValue.trim();
    if (trimmedKey.length > 0 && trimmedValue.length > 0) {
      record[trimmedKey] = trimmedValue;
    }
  }
  return record;
}

/** Key-order-insensitive equality for JSON-shaped config blobs. */
function configsEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => configsEqual(entry, b[index]));
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key, index) =>
      key === bKeys[index] &&
      configsEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** The server stores secret env values and usage-source management keys out of band and echoes
 * them redacted, so mask those fields on both sides or a pending write never matches its echo.
 * A foreign edit differing only in masked fields can acknowledge early; that only reverts the
 * card to prop-based behavior. */
function withComparableSecrets(envelope: ProviderInstanceConfig): unknown {
  if (envelope.environment === undefined && envelope.usageSource === undefined) return envelope;
  return {
    ...envelope,
    ...(envelope.environment !== undefined
      ? {
          environment: envelope.environment.map((variable) => ({
            name: variable.name,
            sensitive: variable.sensitive,
          })),
        }
      : {}),
    ...(envelope.usageSource !== undefined
      ? {
          usageSource: {
            kind: envelope.usageSource.kind,
            ...(envelope.usageSource.managementUrl !== undefined
              ? { managementUrl: envelope.usageSource.managementUrl }
              : {}),
          },
        }
      : {}),
  };
}

/** Preserve explicit empty arrays/objects; clearing a custom list differs from selecting driver defaults. */
function nextConfigBlobWithValue(
  config: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  base[key] = value;
  return base;
}

export function deriveProviderModelsForDisplay(input: {
  readonly liveModels: ReadonlyArray<ServerProviderModel> | undefined;
  readonly customModels: ReadonlyArray<CustomModelDefinition>;
}): ReadonlyArray<ServerProviderModel> {
  const liveCustomModelsBySlug = new Map(
    Arr.filterMap(input.liveModels ?? [], (model) =>
      model.isCustom ? Result.succeed([model.slug, model] as const) : Result.failVoid,
    ),
  );
  const serverModels = input.liveModels?.filter((model) => !model.isCustom) ?? [];
  const serverSlugs = new Set(serverModels.map((model) => model.slug));
  const customModels = input.customModels.flatMap((entry) =>
    serverSlugs.has(entry.slug)
      ? []
      : [
          {
            slug: entry.slug,
            name: entry.name,
            isCustom: true,
            capabilities:
              entry.capabilities ?? liveCustomModelsBySlug.get(entry.slug)?.capabilities ?? null,
          },
        ],
  );
  return [...serverModels, ...customModels];
}

function ProviderAuthEmail(props: { readonly email: string | undefined }) {
  const email = props.email?.trim();
  if (!email) return null;

  return (
    <RedactedSensitiveText
      value={email}
      ariaLabel="Toggle account email visibility"
      revealTooltip="Click to reveal email"
      hideTooltip="Click to hide email"
      className="max-w-full truncate"
    />
  );
}

function readProviderEnvironmentVariable(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  name: string,
): ProviderInstanceEnvironmentVariable | undefined {
  return environment?.find((variable) => variable.name === name);
}

function providerEnvironmentWithoutNames(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  names: ReadonlySet<string>,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  return (environment ?? []).filter((variable) => !names.has(variable.name));
}

export function nextProviderEnvironmentWithFieldValue(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  field: ProviderEnvironmentField,
  value: string,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  const trimmed = value.trim();
  const next: ProviderInstanceEnvironmentVariable[] = [];
  let found = false;

  for (const variable of environment ?? []) {
    if (variable.name !== field.name) {
      next.push(variable);
      continue;
    }
    found = true;
    if (trimmed.length > 0) {
      next.push({
        name: variable.name,
        value: trimmed,
        sensitive: field.sensitive ?? true,
      });
    }
  }

  if (!found && trimmed.length > 0) {
    next.push({
      name: field.name,
      value: trimmed,
      sensitive: field.sensitive ?? true,
    });
  }

  return next;
}

function ProviderEnvironmentFieldRow(props: {
  readonly field: ProviderEnvironmentField;
  readonly variable: ProviderInstanceEnvironmentVariable | undefined;
  readonly idPrefix: string;
  readonly onCommit: (field: ProviderEnvironmentField, value: string) => void;
  readonly onRemove: (field: ProviderEnvironmentField) => void;
}) {
  const inputId = `${props.idPrefix}-environment-${props.field.name}`;
  const value = props.variable?.valueRedacted ? "" : (props.variable?.value ?? "");

  return (
    <SettingsRow
      title={<label htmlFor={inputId}>{props.field.label}</label>}
      description={props.field.description}
      control={
        <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-56">
          {props.field.sensitive === false ? (
            <DraftInput
              id={inputId}
              size="sm"
              className="min-w-0 flex-1"
              autoComplete="off"
              value={value}
              onCommit={(next) => props.onCommit(props.field, next)}
              placeholder={props.field.placeholder}
              spellCheck={false}
            />
          ) : (
            <SecretInput
              id={inputId}
              size="sm"
              className="min-w-0 flex-1"
              value={value}
              onCommit={(next) => props.onCommit(props.field, next)}
              placeholder={props.field.placeholder}
              configured={props.variable?.valueRedacted === true}
              spellCheck={false}
            />
          )}
          {props.variable ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-destructive"
              onClick={() => props.onRemove(props.field)}
              aria-label={`Clear ${props.field.label}`}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

export function ProviderEnvironmentSection(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const [rows, setRows] = useState<ReadonlyArray<EnvironmentDraftRow>>(() =>
    props.environment.map(makeEnvironmentDraftRow),
  );
  const previousEnvironmentRef = useRef(props.environment);
  const lastPublishedEnvironmentRef = useRef<
    ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined
  >(undefined);

  useEffect(() => {
    const previousEnvironment = previousEnvironmentRef.current;
    const lastPublishedEnvironment = lastPublishedEnvironmentRef.current;
    previousEnvironmentRef.current = props.environment;
    lastPublishedEnvironmentRef.current = undefined;
    if (
      previousEnvironment === props.environment ||
      providerEnvironmentsEqual(previousEnvironment, props.environment) ||
      (lastPublishedEnvironment !== undefined &&
        providerEnvironmentsEqual(lastPublishedEnvironment, props.environment))
    ) {
      return;
    }
    setRows(props.environment.map(makeEnvironmentDraftRow));
  }, [props.environment]);

  const publishRows = (nextRows: ReadonlyArray<EnvironmentDraftRow>) => {
    const published: ProviderInstanceEnvironmentVariable[] = [];
    for (const row of nextRows) {
      const name = row.name.trim();
      if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
        if (
          name.length > 0 ||
          row.value.length > 0 ||
          row.sensitive !== true ||
          row.valueRedacted !== undefined
        ) {
          return;
        }
        continue;
      }
      const { id: _id, ...rest } = row;
      published.push({ ...rest, name });
    }
    lastPublishedEnvironmentRef.current = published;
    props.onChange(published);
  };

  const updateVariable = (id: string, patch: Partial<Omit<EnvironmentDraftRow, "id">>) => {
    const nextRows = rows.map((row) =>
      row.id === id
        ? {
            ...row,
            ...patch,
            ...(patch.value !== undefined ? { valueRedacted: false } : {}),
          }
        : row,
    );
    setRows(nextRows);
    publishRows(nextRows);
  };

  const removeVariable = (id: string) => {
    const nextRows = rows.filter((row) => row.id !== id);
    setRows(nextRows);
    publishRows(nextRows);
  };

  const addVariable = () =>
    setRows([
      ...rows,
      {
        id: nextEnvironmentVariableDraftId(),
        name: "",
        value: "",
        sensitive: true,
      },
    ]);

  return (
    <SettingsRow
      title="Variables"
      description="API keys, base URLs, and other per-instance CLI settings."
      control={
        <Button type="button" size="sm" variant="outline" onClick={addVariable}>
          <PlusIcon className="size-3" />
          Add variable
        </Button>
      }
    >
      {rows.length > 0 ? (
        <div className="mt-3 min-w-0 space-y-2 pb-2">
          {rows.map((variable, index) => (
            <div key={variable.id} className="flex min-w-0 flex-wrap items-center gap-1.5">
              <DraftInput
                size="sm"
                font="mono"
                className="w-full min-w-0 sm:w-44 sm:shrink-0"
                value={variable.name}
                onCommit={(name) => updateVariable(variable.id, { name: name.trim() })}
                placeholder="VARIABLE_NAME"
                spellCheck={false}
                aria-label={`Environment variable name ${index + 1}`}
              />
              <span className="hidden text-xs text-muted-foreground sm:inline" aria-hidden>
                =
              </span>
              {variable.sensitive ? (
                <SecretInput
                  size="sm"
                  font="mono"
                  className="min-w-0 flex-1"
                  value={variable.valueRedacted ? "" : variable.value}
                  onCommit={(value) => updateVariable(variable.id, { value })}
                  placeholder="value"
                  configured={variable.valueRedacted === true}
                  spellCheck={false}
                  aria-label={`Environment variable value ${index + 1}`}
                />
              ) : (
                <DraftInput
                  size="sm"
                  font="mono"
                  className="min-w-0 flex-1"
                  value={variable.valueRedacted ? "" : variable.value}
                  onCommit={(value) => updateVariable(variable.id, { value })}
                  autoComplete="off"
                  placeholder="value"
                  spellCheck={false}
                  aria-label={`Environment variable value ${index + 1}`}
                />
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost-muted"
                      onClick={() => {
                        const sensitive = !variable.sensitive;
                        updateVariable(variable.id, {
                          sensitive,
                          ...(sensitive && variable.valueRedacted === undefined
                            ? {}
                            : { valueRedacted: sensitive ? variable.valueRedacted : false }),
                        });
                      }}
                      aria-pressed={variable.sensitive}
                      aria-label={`Mark environment variable ${variable.name || index + 1} as sensitive`}
                    >
                      <MorphIcon
                        className="size-3"
                        icon={variable.sensitive ? LockGlyph : LockOpen}
                      />
                    </Button>
                  }
                />
                <TooltipPopup side="top">
                  {variable.sensitive ? "Sensitive, stored separately" : "Plain text"}
                </TooltipPopup>
              </Tooltip>
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-destructive"
                onClick={() => removeVariable(variable.id)}
                aria-label={`Remove environment variable ${variable.name || index + 1}`}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Sensitive values are stored separately and never returned to the app.
          </p>
        </div>
      ) : null}
    </SettingsRow>
  );
}

/**
 * Emits field-level intent rather than a whole `usageSource`: the card owns
 * merging against the last written envelope, so an edit made while an
 * earlier write is still in flight cannot resurrect a stale sibling field
 * from this section's props.
 */
type ProviderUsageSourcePatch =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly managementUrl?: string | undefined;
      readonly managementKey?: string;
    };

function ProviderUsageSourceSection(props: {
  readonly usageSource: ProviderInstanceUsageSource | undefined;
  readonly onChange: (patch: ProviderUsageSourcePatch) => void;
}) {
  const usageSource = props.usageSource;
  const enabled = usageSource?.kind === PROVIDER_USAGE_SOURCE_CLIPROXYAPI;

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">Usage source</span>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => props.onChange({ enabled: Boolean(checked) })}
          aria-label="Meter usage from a CLIProxyAPI gateway"
        />
      </div>
      <span className="text-xs text-muted-foreground">
        For instances routed through a CLIProxyAPI gateway: read subscription quota for the
        gateway&apos;s pooled accounts from its management API instead of this instance&apos;s own
        login.
      </span>
      {enabled && usageSource ? (
        <div className="grid gap-2">
          <DraftInput
            value={usageSource.managementUrl ?? ""}
            onCommit={(value) => {
              const trimmed = value.trim();
              props.onChange({
                enabled: true,
                managementUrl: trimmed.length > 0 ? trimmed : undefined,
              });
            }}
            placeholder="Management URL (defaults to the ANTHROPIC_BASE_URL origin)"
            spellCheck={false}
            aria-label="CLIProxyAPI management URL"
          />
          <DraftInput
            value={usageSource.managementKeyRedacted ? "" : usageSource.managementKey}
            onCommit={(value) => props.onChange({ enabled: true, managementKey: value })}
            type="password"
            autoComplete="off"
            placeholder={
              usageSource.managementKeyRedacted
                ? "Stored management key - enter a new value to replace"
                : "Management key"
            }
            spellCheck={false}
            aria-label="CLIProxyAPI management key"
          />
        </div>
      ) : null}
    </div>
  );
}

function ProjectOverrideInheritance({
  projectEnabled,
  deviceEnabled,
}: {
  readonly projectEnabled: boolean;
  readonly deviceEnabled: boolean;
}) {
  const layers = [
    { key: "project", label: "Project", enabled: projectEnabled, effective: true },
    { key: "device", label: "Device", enabled: deviceEnabled, effective: false },
  ];
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label="Overridden for this project. Show where this value comes from"
                />
              }
            />
          }
        >
          <LayersIcon className="size-3 text-primary" />
        </TooltipTrigger>
        <TooltipPopup side="top">Overridden for this project</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" width="md" padding="none">
        <ol role="list" className="px-3 py-2.5 text-sm">
          {layers.map((layer) => (
            <li
              key={layer.key}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1",
                layer.effective && "bg-foreground/[0.06]",
              )}
            >
              <span
                className={cn(
                  "min-w-0 truncate",
                  layer.effective ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {layer.label}
              </span>
              <span
                className={cn(
                  "flex items-center gap-1.5",
                  layer.effective ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {layer.enabled ? "On" : "Off"}
                {layer.effective ? (
                  <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
                ) : (
                  <span aria-hidden className="size-3.5 shrink-0" />
                )}
              </span>
            </li>
          ))}
        </ol>
      </PopoverPopup>
    </Popover>
  );
}

interface ProjectOverrideControl {
  readonly value: boolean | undefined;
  readonly effectiveEnabled: boolean;
  readonly onChange: (next: boolean) => void;
  readonly onReset: () => void;
}

interface ProviderInstanceCardProps {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driverOption: ProviderClientDefinition | undefined;
  readonly liveProvider: ServerProvider | undefined;
  /** Shared by the list row and editor mount for this environment. */
  readonly pendingInstancesRef: {
    current: Map<ProviderInstanceId, ProviderInstanceConfig>;
  };
  readonly mode: "list" | "editor";
  readonly selected?: boolean | undefined;
  readonly onSelect?: (() => void) | undefined;
  readonly readOnly?: boolean | undefined;
  readonly canWriteSettings?: boolean;
  readonly onUpdate: (nextInstance: ProviderInstanceConfig) => void;
  readonly onDelete?: (() => void) | undefined;
  readonly headerAction?: ReactNode | undefined;
  readonly setup?: ReactNode;
  readonly runtime?: ReactNode;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (
    next: ReadonlyArray<string>,
    affectedModels?: ReadonlyArray<string>,
  ) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onToggleFavorite: (model: string) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly onRunUpdate?: (() => void) | undefined;
  readonly onInstallRecommended?: (() => void) | undefined;
  readonly isUpdating?: boolean | undefined;
  readonly onAcceptUrlAuth?: ((action: AcpRegistryUrlAuthAction) => void) | undefined;
  readonly environmentId?: EnvironmentId | undefined;
  readonly projectOverride?: ProjectOverrideControl | undefined;
  readonly acpProjects?:
    | ReadonlyArray<{
        readonly id: ProjectId;
        readonly title: string;
        readonly workspaceRoot: string;
      }>
    | undefined;
}

const EMPTY_ACP_PROJECTS: NonNullable<ProviderInstanceCardProps["acpProjects"]> = [];
const NO_CUSTOM_MODELS: ReadonlyArray<CustomModelDefinition> = [];

/** Unknown drivers stay read-only to preserve fork config. projectOverride switches affect only the
 * project, not instance.enabled. */
export function ProviderInstanceCard({
  instanceId,
  instance,
  driverOption,
  liveProvider,
  pendingInstancesRef,
  mode,
  selected = false,
  onSelect,
  readOnly = false,
  canWriteSettings = true,
  onUpdate,
  onDelete,
  headerAction,
  setup,
  runtime,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onToggleFavorite,
  onModelOrderChange,
  onRunUpdate,
  onInstallRecommended,
  isUpdating = false,
  onAcceptUrlAuth,
  environmentId,
  acpProjects = EMPTY_ACP_PROJECTS,
  projectOverride,
}: ProviderInstanceCardProps) {
  const enabled = projectOverride?.effectiveEnabled ?? resolveProviderInstanceEnabled(instance);
  const effectiveProvider = liveProvider && { ...liveProvider, enabled };
  const compatibility = enabled ? liveProvider?.compatibilityAdvisory : undefined;
  const statusKey = enabled ? getProviderStatusKey(effectiveProvider) : "disabled";
  const statusStyle = PROVIDER_STATUS_STYLES[statusKey];
  const summary = enabled
    ? getProviderSummary(effectiveProvider)
    : { headline: "Disabled", detail: null };
  const authEmail = liveProvider?.auth.email?.trim();
  const isAuthenticated = enabled && liveProvider?.auth.status === "authenticated";
  const authLabel =
    enabled && liveProvider?.auth.status === "authenticated"
      ? (liveProvider.auth.label ?? liveProvider.auth.type ?? null)
      : null;
  const versionLabel = getProviderVersionLabel(liveProvider?.version);
  const versionAdvisory = getProviderVersionAdvisoryPresentation(
    liveProvider?.versionAdvisory,
    liveProvider?.compatibilityAdvisory,
    enabled,
  );
  const updateCommand = versionAdvisory?.updateCommand ?? null;
  const updateState = liveProvider?.updateState;
  const updateProgress = isUpdating
    ? ((updateState?.status === "queued" || updateState?.status === "running"
        ? updateState.message
        : null) ?? "Starting update")
    : null;
  const updateProblem =
    !isUpdating && (updateState?.status === "failed" || updateState?.status === "unchanged")
      ? updateState.message
      : null;
  const hasCompatibilityWarning =
    compatibility !== undefined &&
    compatibility.status !== "supported" &&
    compatibility.status !== "unknown";
  const VersionAdvisoryIcon = hasCompatibilityWarning ? AlertTriangleIcon : ArrowUpCircleIcon;
  const onRunVersionAction = readOnly
    ? undefined
    : versionAdvisory?.targetVersion
      ? onInstallRecommended
      : onRunUpdate;
  const urlAuthAction = liveProvider?.auth.action;
  const displayName =
    instance.displayName?.trim() || driverOption?.label || String(instance.driver);
  const accentColor = normalizeProviderAccentColor(instance.accentColor);
  const { copyToClipboard } = useCopyToClipboard<{ providerName: string }>({
    onCopy: ({ providerName }) => {
      toastManager.add({
        type: "success",
        title: `${providerName} update command copied`,
        description: "Run it in a terminal when you are ready to update.",
      });
    },
    onError: (error, { providerName }) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not copy ${providerName} update command`,
          description: error.message,
        }),
      );
    },
  });

  const driverKind: ProviderDriverKind | null = isProviderDriverKind(instance.driver)
    ? instance.driver
    : null;
  // Writes have no optimistic patch and replace the whole envelope, so every mutator bases on the
  // last *written* envelope (panel-owned, shared by list and editor mounts) instead of the stale
  // prop. Clear an entry only when an echo structurally matches it, so an intermediate echo cannot
  // hide a newer in-flight write; secrets compare in the server-normalized shape.
  useEffect(() => {
    const pendingInstance = pendingInstancesRef.current.get(instanceId);
    if (
      pendingInstance !== undefined &&
      configsEqual(withComparableSecrets(pendingInstance), withComparableSecrets(instance))
    ) {
      pendingInstancesRef.current.delete(instanceId);
    }
  }, [instance, instanceId, pendingInstancesRef]);
  const baseInstance = () => pendingInstancesRef.current.get(instanceId) ?? instance;
  const baseConfig = () => baseInstance().config;
  const commitInstance = (next: ProviderInstanceConfig) => {
    pendingInstancesRef.current.set(instanceId, next);
    onUpdate(next);
  };

  const updateEnabled = (value: boolean) => {
    if (projectOverride) {
      projectOverride.onChange(value);
      return;
    }
    commitInstance({ ...baseInstance(), enabled: value });
  };

  const versionAdvisoryNode = versionAdvisory ? (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size={mode === "list" ? "icon-micro" : "icon-xs"}
                  variant="ghost-muted"
                  className={mode === "list" ? "pointer-events-auto relative shrink-0" : undefined}
                  aria-label={`${updateProgress ? "Updating" : versionAdvisory.title}, view details`}
                >
                  {updateProgress ? (
                    <Spinner tone="muted" {...(mode === "list" ? { size: "sm" as const } : {})} />
                  ) : (
                    <VersionAdvisoryIcon
                      className={cn(
                        mode === "list" && "size-3.5",
                        hasCompatibilityWarning && "text-warning",
                      )}
                    />
                  )}
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="top">
          {updateProgress ? "Updating" : versionAdvisory.title}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="end" width="md" aria-label={versionAdvisory.title}>
        <div className="grid min-w-0 gap-3">
          <div className="grid gap-0.5">
            <p className="text-sm font-semibold leading-tight text-foreground">
              {versionAdvisory.title}
            </p>
            <p
              className={cn(
                "text-xs leading-snug [overflow-wrap:anywhere]",
                versionAdvisory.emphasis === "strong" ? "text-warning" : "text-muted-foreground",
              )}
            >
              {versionAdvisory.detail}
            </p>
          </div>
          {onRunVersionAction ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="w-full"
              disabled={isUpdating}
              onClick={onRunVersionAction}
            >
              {isUpdating ? <Spinner /> : <DownloadIcon />}
              {isUpdating
                ? "Updating"
                : versionAdvisory.targetVersion
                  ? `Install ${getProviderVersionLabel(versionAdvisory.targetVersion)}`
                  : "Update now"}
            </Button>
          ) : null}
          {updateProgress || updateProblem ? (
            <p
              aria-live="polite"
              className={cn(
                "text-xs leading-snug [overflow-wrap:anywhere]",
                updateProblem ? "text-warning" : "text-muted-foreground",
              )}
            >
              {updateProgress ?? updateProblem}
            </p>
          ) : null}
          {onRunVersionAction && updateCommand ? (
            <div className="flex items-center gap-2 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
              <span aria-hidden className="h-px flex-1 bg-border" />
              or, update manually using
              <span aria-hidden className="h-px flex-1 bg-border" />
            </div>
          ) : null}
          {updateCommand ? (
            <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
              <code className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground">
                {updateCommand}
              </code>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      className="shrink-0"
                      onClick={() => copyToClipboard(updateCommand, { providerName: displayName })}
                      aria-label="Copy update command"
                    >
                      <CopyIcon className="size-3" />
                    </Button>
                  }
                />
                <TooltipPopup side="top">Copy command</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  ) : null;

  // Render reads the echoed `instance`; only mutators read the pending
  // envelope. Keyed on the stored list, not the whole instance, so writing
  // another field leaves the models list (often ~50 rows) with the same props.
  const storedCustomModels =
    instance.config !== null && typeof instance.config === "object"
      ? (instance.config as Record<string, unknown>).customModels
      : undefined;
  const customModels =
    instance.driver === "antigravity"
      ? NO_CUSTOM_MODELS
      : readCustomModelEntries(storedCustomModels);
  const customModelIcons =
    instance.driver === "antigravity"
      ? EMPTY_STRING_RECORD
      : readConfigStringRecord(instance.config, "customModelIcons");
  // Server-returned models may lag behind settings writes. Treat server
  // models as the source for built-ins only; custom rows come directly
  // from the current instance config so add/remove reflects immediately.
  const modelsForDisplay = deriveProviderModelsForDisplay({
    liveModels: liveProvider?.models,
    customModels,
  });

  const updateDisplayName = (value: string) => {
    const trimmed = value.trim();
    const { displayName: _omit, ...rest } = baseInstance();
    commitInstance(
      trimmed.length > 0
        ? ({ ...rest, displayName: trimmed } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateAccentColor = (value: string) => {
    const normalized = normalizeProviderAccentColor(value);
    const { accentColor: _omit, ...rest } = baseInstance();
    commitInstance(
      normalized
        ? ({ ...rest, accentColor: normalized } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const commitConfig = (nextConfig: Record<string, unknown> | undefined) => {
    const { config: _omit, ...rest } = baseInstance();
    commitInstance(
      nextConfig !== undefined
        ? ({ ...rest, config: nextConfig } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  // Keys owned by the models section below, not by ProviderSettingsForm.
  const MODEL_SECTION_CONFIG_KEYS = ["customModels", "customModelIcons"] as const;

  const updateConfig = (formConfig: Record<string, unknown> | undefined) => {
    // The form's replacement blob comes from a `value` prop that may predate an in-flight
    // models/icons write. It never edits those keys, so re-overlay them from the latest base
    // instead of letting the stale snapshot clobber or resurrect them.
    const base = baseConfig();
    const baseObject =
      base !== null && typeof base === "object" ? (base as Record<string, unknown>) : undefined;
    let next = formConfig;
    for (const key of MODEL_SECTION_CONFIG_KEYS) {
      const baseValue = baseObject?.[key];
      if (baseValue !== undefined) {
        next = { ...next, [key]: baseValue };
      } else if (next !== undefined && Object.hasOwn(next, key)) {
        const rest = { ...next };
        delete rest[key];
        next = rest;
      }
    }
    commitConfig(next);
  };

  const updateCustomModels = useStableCallback((next: ReadonlyArray<CustomModelDefinition>) => {
    const base = baseConfig();
    // `onChange` describes one edit relative to this render. Replay that
    // delta onto the latest pending list so a second add/edit/remove cannot
    // overwrite an earlier write that the server has not echoed yet.
    const nextSlugs = new Set(next.map((entry) => entry.slug));
    const removedSlugs = new Set(
      customModels.filter((entry) => !nextSlugs.has(entry.slug)).map((entry) => entry.slug),
    );
    let merged = readConfigCustomModels(base).filter((entry) => !removedSlugs.has(entry.slug));
    for (const nextEntry of next) {
      const renderedEntry = customModels.find((entry) => entry.slug === nextEntry.slug);
      const currentIndex = merged.findIndex((entry) => entry.slug === nextEntry.slug);
      if (renderedEntry === undefined) {
        if (currentIndex === -1) merged = [...merged, nextEntry];
      } else if (!configsEqual(renderedEntry, nextEntry) && currentIndex !== -1) {
        // The rendered row is the echoed definition, which can predate a
        // pending edit of the same model; carry over only the fields this
        // edit changed so an unechoed rename or option change survives.
        const pending = merged[currentIndex]!;
        const edited: CustomModelDefinition = {
          slug: nextEntry.slug,
          name: renderedEntry.name === nextEntry.name ? pending.name : nextEntry.name,
          capabilities: configsEqual(renderedEntry.capabilities, nextEntry.capabilities)
            ? pending.capabilities
            : nextEntry.capabilities,
        };
        merged = merged.map((entry, index) => (index === currentIndex ? edited : entry));
      }
    }
    const nextConfig = nextConfigBlobWithValue(
      base,
      "customModels",
      merged.map(toCustomModelSetting),
    );
    // Model removal and icon pruning belong to one config write so a stale
    // icon map cannot resurrect an override for a deleted slug.
    const remainingSlugs = new Set(merged.map((entry) => entry.slug));
    const keptIcons = Object.fromEntries(
      Object.entries(readConfigStringRecord(base, "customModelIcons")).filter(([slug]) =>
        remainingSlugs.has(slug),
      ),
    );
    if (Object.keys(keptIcons).length > 0) {
      nextConfig.customModelIcons = keptIcons;
    } else {
      delete nextConfig.customModelIcons;
    }
    commitConfig(nextConfig);
  });

  const updateCustomModelIcon = (slug: string, icon: string | null) => {
    const base = baseConfig();
    // Null prototype so a slug like "__proto__" becomes an own data
    // property instead of silently vanishing into the inherited setter.
    const icons: Record<string, string> = Object.assign(
      Object.create(null),
      readConfigStringRecord(base, "customModelIcons"),
    );
    if (icon === null) {
      delete icons[slug];
    } else {
      icons[slug] = icon;
    }
    const nextConfig = nextConfigBlobWithValue(base, "customModelIcons", icons);
    if (Object.keys(icons).length === 0) {
      delete nextConfig.customModelIcons;
    }
    commitConfig(nextConfig);
  };

  if (mode === "list") {
    const listTitleIconNode = (
      <ProviderInstanceIcon
        driverKind={driverKind ?? instance.driver}
        displayName={displayName}
        accentColor={accentColor}
        acpRegistryAgentId={
          readConfigString(instance.config, "source") === "local"
            ? undefined
            : (readConfigString(instance.config, "agentId") ?? undefined)
        }
        acpRegistryIconUrl={
          readConfigString(instance.config, "source") === "local"
            ? undefined
            : (readConfigString(instance.config, "registryIconUrl") ?? undefined)
        }
        showBadge={Boolean(accentColor)}
        className="size-5"
        iconClassName="size-4 text-foreground/80"
        badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-3xs"
      />
    );
    const listVersionCodeNode = versionLabel ? (
      <code className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
        {versionLabel}
      </code>
    ) : null;
    const listStatusDotNode =
      statusKey === "warning" || statusKey === "error" ? (
        <span className={cn("size-1.5 shrink-0 rounded-full", statusStyle.dot)} aria-hidden />
      ) : null;
    const listNeedsAttention = statusKey === "warning" || statusKey === "error";

    return (
      <div
        data-slot="settings-row"
        className={cn(
          "group flex min-h-18 items-center gap-3 px-3 py-3 transition-colors sm:px-4",
          selected ? "bg-muted/45" : "hover:bg-muted/25",
        )}
      >
        <div
          className={cn(
            "pointer-events-none relative flex min-w-0 flex-1 items-start gap-3 rounded-md text-left transition-opacity",
            !enabled && !selected && "opacity-60 group-hover:opacity-100",
          )}
        >
          <button
            type="button"
            className="pointer-events-auto absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={onSelect}
            aria-label={`Select ${displayName}`}
            aria-pressed={selected}
          />
          {listTitleIconNode}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
              {String(instanceId) !== String(instance.driver) ? (
                <code className="min-w-0 truncate rounded bg-muted/60 px-1 py-0.5 text-3xs text-muted-foreground">
                  {instanceId}
                </code>
              ) : null}
              {listVersionCodeNode}
              {versionAdvisoryNode}
            </span>
            <span className="mt-0.5 flex items-start gap-1.5 text-xs leading-normal text-muted-foreground/80">
              {listStatusDotNode && !updateProgress ? (
                <span className="flex h-[1.45em] shrink-0 items-center">{listStatusDotNode}</span>
              ) : null}
              <span aria-live="polite" className="line-clamp-2 [overflow-wrap:anywhere]">
                {updateProgress ? (
                  `Updating · ${updateProgress}`
                ) : (
                  <>
                    {summary.headline}
                    {listNeedsAttention && summary.detail ? ` · ${summary.detail}` : null}
                  </>
                )}
              </span>
            </span>
          </span>
        </div>
        <span className="flex h-5 shrink-0 items-center gap-1">
          {projectOverride?.value !== undefined ? (
            <span className="flex items-center">
              <ProjectOverrideInheritance
                projectEnabled={projectOverride.value}
                deviceEnabled={resolveProviderInstanceEnabled(instance)}
              />
              <SettingResetButton
                label={`${displayName} enablement`}
                tooltip="Reset to the device setting"
                disabled={readOnly || !canWriteSettings}
                onClick={projectOverride.onReset}
              />
            </span>
          ) : null}
          <Switch
            checked={enabled}
            disabled={readOnly || (projectOverride !== undefined && !canWriteSettings)}
            onCheckedChange={(checked) => updateEnabled(Boolean(checked))}
            aria-label={`Enable ${displayName}`}
          />
        </span>
      </div>
    );
  }

  const updateEnvironment = (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => {
    const cleaned = environment.filter((variable) => variable.name.trim().length > 0);
    const { environment: _omit, ...rest } = baseInstance();
    commitInstance(
      cleaned.length > 0
        ? ({ ...rest, environment: cleaned } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };
  // Drivers that need a named secret (Cursor's API key) get a dedicated field;
  // the generic editor only shows the remaining variables.
  const environmentFields = driverOption?.environmentFields ?? [];
  const environmentFieldNames = new Set(environmentFields.map((field) => field.name));
  const genericEnvironment = providerEnvironmentWithoutNames(
    instance.environment,
    environmentFieldNames,
  );
  const updateGenericEnvironment = (
    environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  ) => {
    const dedicatedEnvironment = (baseInstance().environment ?? []).filter((variable) =>
      environmentFieldNames.has(variable.name),
    );
    updateEnvironment([...dedicatedEnvironment, ...environment]);
  };
  const updateEnvironmentField = (field: ProviderEnvironmentField, value: string) => {
    updateEnvironment(
      nextProviderEnvironmentWithFieldValue(baseInstance().environment, field, value),
    );
  };
  const removeEnvironmentField = (field: ProviderEnvironmentField) => {
    updateEnvironment(
      providerEnvironmentWithoutNames(baseInstance().environment, new Set([field.name])),
    );
  };

  const updateUsageSource = (patch: ProviderUsageSourcePatch) => {
    const { usageSource: current, ...rest } = baseInstance();
    if (!patch.enabled) {
      commitInstance(rest as ProviderInstanceConfig);
      return;
    }
    const base: ProviderInstanceUsageSource = current ?? {
      kind: PROVIDER_USAGE_SOURCE_CLIPROXYAPI,
      managementKey: "",
    };
    const managementUrl = "managementUrl" in patch ? patch.managementUrl : base.managementUrl;
    // A newly entered key is unredacted; the server redacts it on echo.
    const keyFields =
      patch.managementKey !== undefined
        ? { managementKey: patch.managementKey }
        : {
            managementKey: base.managementKey,
            ...(base.managementKeyRedacted ? { managementKeyRedacted: true } : {}),
          };
    commitInstance({
      ...rest,
      usageSource: {
        kind: PROVIDER_USAGE_SOURCE_CLIPROXYAPI,
        ...(managementUrl !== undefined ? { managementUrl } : {}),
        ...keyFields,
      },
    } as ProviderInstanceConfig);
  };

  const titleIconNode = (
    <ProviderInstanceIcon
      driverKind={driverKind ?? instance.driver}
      displayName={displayName}
      accentColor={accentColor}
      acpRegistryAgentId={
        readConfigString(instance.config, "source") === "local"
          ? undefined
          : (readConfigString(instance.config, "agentId") ?? undefined)
      }
      acpRegistryIconUrl={
        readConfigString(instance.config, "source") === "local"
          ? undefined
          : (readConfigString(instance.config, "registryIconUrl") ?? undefined)
      }
      showBadge={Boolean(accentColor)}
      className="size-5"
      iconClassName="size-4 text-foreground/80"
      badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"
    />
  );

  const titleTailNode = headerAction ? (
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">{headerAction}</span>
  ) : null;

  const versionCodeNode = versionLabel ? (
    <code className="text-xs text-muted-foreground">{versionLabel}</code>
  ) : null;

  // Healthy and disabled rows read fine from their text; only trouble gets a dot.
  const statusDotNode =
    statusKey === "warning" || statusKey === "error" ? (
      <span className={cn("size-1.5 shrink-0 rounded-full", statusStyle.dot)} aria-hidden />
    ) : null;
  const needsAttention = statusKey === "warning" || statusKey === "error";
  const statusDiagnostic = hasCompatibilityWarning && needsAttention ? summary.detail : null;
  // Keep compatibility copy compact; the version popover carries the explanation.
  const inlineStatusDetail = hasCompatibilityWarning
    ? compatibility?.status === "broken"
      ? "Incompatible"
      : compatibility?.status === "unsupported"
        ? "Unsupported"
        : "Limited support"
    : summary.detail;
  const editorStatusNode =
    isAuthenticated && authEmail ? (
      <>
        {needsAttention ? statusDotNode : null}
        <span>Authenticated as</span>
        <ProviderAuthEmail email={authEmail} />
        {authLabel ? <span>· {authLabel}</span> : null}
        {inlineStatusDetail ? (
          <span className="min-w-0 [overflow-wrap:anywhere]">· {inlineStatusDetail}</span>
        ) : null}
      </>
    ) : (
      <>
        {statusDotNode}
        <span>{summary.headline}</span>
        {inlineStatusDetail ? (
          <span className="min-w-0 [overflow-wrap:anywhere]">· {inlineStatusDetail}</span>
        ) : null}
      </>
    );
  const editorHeaderAction = (
    <div className="flex shrink-0 items-center gap-1.5">
      {driverOption?.badgeLabel ? (
        <Badge variant="warning" size="sm" className="shrink-0">
          {driverOption.badgeLabel}
        </Badge>
      ) : null}
      {versionCodeNode}
      {versionAdvisoryNode}
      <span
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        className={cn("inline-flex items-center gap-1", readOnly && "opacity-50")}
      >
        {titleTailNode}
        {onDelete ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-destructive"
            disabled={readOnly}
            onClick={onDelete}
            aria-label={`Delete instance ${instanceId}`}
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </span>
    </div>
  );

  const runtimeFields = driverOption ? (
    <ProviderSettingsForm
      definition={driverOption}
      value={instance.config}
      idPrefix={`provider-instance-${instanceId}`}
      variant="settings"
      onChange={updateConfig}
    />
  ) : (
    <SettingsRow
      title="Driver"
      description={
        <span>
          This instance uses <code className="text-foreground">{String(instance.driver)}</code>,
          which is not available in this build. Its configuration is preserved.
        </span>
      }
    />
  );

  return (
    <>
      <SettingsSection title={displayName} icon={titleIconNode} headerAction={editorHeaderAction}>
        <SettingsRow
          title="Display name"
          status={
            <>
              <ProviderStatusDiagnostic detail={statusDiagnostic}>
                <div
                  tabIndex={statusDiagnostic ? 0 : undefined}
                  className="flex min-w-0 flex-wrap items-baseline gap-x-1.5"
                >
                  {editorStatusNode}
                </div>
              </ProviderStatusDiagnostic>
              {urlAuthAction && onAcceptUrlAuth ? (
                <div className="grid max-w-xl gap-1.5 pt-1 text-xs">
                  <p>{urlAuthAction.message}</p>
                  <code className="break-all text-2xs">{urlAuthAction.url}</code>
                  <Button
                    render={
                      <a
                        href={urlAuthAction.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => onAcceptUrlAuth(urlAuthAction)}
                      />
                    }
                    size="xs"
                    variant="outline"
                    className="w-fit"
                    disabled={readOnly}
                  >
                    <ExternalLinkIcon />
                    Continue authentication
                  </Button>
                </div>
              ) : null}
            </>
          }
          control={
            <div
              inert={readOnly}
              aria-disabled={readOnly || undefined}
              className={cn(
                "flex w-full min-w-0 items-center justify-end gap-2 @min-[32rem]/settings-row:w-auto",
                readOnly && "opacity-50 select-none",
              )}
            >
              <ProviderAccentColorPicker
                layout="inline"
                displayName={displayName}
                value={accentColor}
                onCommit={updateAccentColor}
                commitDelayMs={120}
              />
              <DraftInput
                id={`provider-instance-${instanceId}-display-name`}
                size="sm"
                className="min-w-0 flex-1 @min-[32rem]/settings-row:w-56"
                value={instance.displayName ?? ""}
                onCommit={updateDisplayName}
                placeholder={driverOption?.label ?? "Instance label"}
                spellCheck={false}
              />
            </div>
          }
        />
      </SettingsSection>

      {setup || environmentFields.length > 0 ? (
        <SettingsSection title="Setup">
          {setup}
          {environmentFields.length > 0 ? (
            <div
              inert={readOnly}
              aria-disabled={readOnly || undefined}
              className={readOnly ? "opacity-50 select-none" : undefined}
            >
              {environmentFields.map((field) => (
                <ProviderEnvironmentFieldRow
                  key={field.name}
                  field={field}
                  variable={readProviderEnvironmentVariable(instance.environment, field.name)}
                  idPrefix={`provider-instance-${instanceId}`}
                  onCommit={updateEnvironmentField}
                  onRemove={removeEnvironmentField}
                />
              ))}
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

      {instance.driver === "codex" && readCodexSetupMode(instance.config) === "managed" ? (
        <div
          inert={readOnly}
          aria-disabled={readOnly || undefined}
          className={readOnly ? "opacity-50 select-none" : undefined}
        >
          <FoldedSettingsSection
            key={instanceId}
            id={`provider-instance-${instanceId}-runtime`}
            title="Runtime"
            headerPlacement="outside"
          >
            {runtime ?? runtimeFields}
          </FoldedSettingsSection>
        </div>
      ) : !driverOption || deriveProviderSettingsFields(driverOption).length > 0 ? (
        <SettingsSection
          title="Runtime"
          inert={readOnly}
          aria-disabled={readOnly || undefined}
          className={readOnly ? "opacity-50 select-none" : undefined}
        >
          {runtimeFields}
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Environment"
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        className={readOnly ? "opacity-50 select-none" : undefined}
      >
        <ProviderEnvironmentSection
          environment={genericEnvironment}
          onChange={updateGenericEnvironment}
        />
      </SettingsSection>
      {environmentId !== undefined && liveProvider?.driver === "acpRegistry" ? (
        <AcpSessionManagementSection
          environmentId={environmentId}
          instanceId={instanceId}
          provider={liveProvider}
          projects={acpProjects}
          readOnly={readOnly}
        />
      ) : null}

      <SettingsSection
        title="Usage"
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        className={readOnly ? "opacity-50 select-none" : undefined}
      >
        <div className="px-3 py-3 sm:px-4">
          <ProviderUsageSourceSection
            usageSource={instance.usageSource}
            onChange={updateUsageSource}
          />
        </div>
      </SettingsSection>

      {driverOption !== undefined ? (
        <SettingsSection title="Models">
          <div className="px-3 py-3 sm:px-4">
            <p className="mb-3 text-xs text-muted-foreground">
              Model preferences and custom models are saved on the selected environment and shared
              across connected devices.
            </p>
            <ProviderModelsSection
              canManageCustomModels={!readOnly}
              instanceId={instanceId}
              driverKind={driverKind}
              models={modelsForDisplay}
              customModels={customModels}
              customModelIcons={customModelIcons}
              hiddenModels={hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelOrder}
              onChange={updateCustomModels}
              onCustomModelIconChange={updateCustomModelIcon}
              onHiddenModelsChange={onHiddenModelsChange}
              onFavoriteModelsChange={onFavoriteModelsChange}
              onToggleFavorite={onToggleFavorite}
              onModelOrderChange={onModelOrderChange}
            />
          </div>
        </SettingsSection>
      ) : null}
    </>
  );
}
