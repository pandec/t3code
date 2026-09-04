"use client";

import {
  ArrowUpCircleIcon,
  CopyIcon,
  DownloadIcon,
  LoaderIcon,
  LockIcon,
  LockOpenIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  isProviderDriverKind,
  PROVIDER_USAGE_SOURCE_CLIPROXYAPI,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ProviderInstanceUsageSource,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { parseCustomModelEntry } from "@t3tools/shared/model";

import { cn } from "../../lib/utils";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DriverOption } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { ProviderInstanceIcon, providerInstanceInitials } from "../chat/ProviderInstanceIcon";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  getProviderVersionAdvisoryPresentation,
  PROVIDER_STATUS_STYLES,
  getProviderSummary,
  getProviderVersionLabel,
  type ProviderStatusKey,
} from "./providerStatus";

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

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

/**
 * Read a string[] at `key` from the opaque config blob, filtering out
 * non-string entries. Used for `customModels`, which is always typed as
 * `string[]` by the concrete driver schemas but arrives here as
 * `Schema.Unknown`.
 */
function readConfigStringArray(config: unknown, key: string): ReadonlyArray<string> {
  if (config === null || typeof config !== "object") return [];
  const value = (config as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Read a string-to-string record at `key` from the opaque config blob,
 * filtering out non-string values and trimming keys and values. Used for
 * `customModelIcons` (custom model slug → driver-kind icon id). Returns a
 * null-prototype record so user-authored keys like "constructor" miss
 * cleanly instead of resolving to `Object.prototype` members.
 */
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

/**
 * Read the custom-model entry list (`slug` or `slug=Label`) from the config
 * blob: entries are trimmed, invalid ones dropped, and duplicates (by
 * parsed slug) collapse to the first occurrence. Keying everything by the
 * parsed slug keeps Settings-side consumers (display rows, icon lookups,
 * pruning) consistent with the trimmed `customModelIcons` record and with
 * the normalized slugs the model picker resolves — a hand-edited
 * `" gpt-5.6-sol "` heals to its trimmed form on the next write instead of
 * splitting into two identities.
 */
function readConfigCustomModels(config: unknown): ReadonlyArray<string> {
  const entriesBySlug = new Map<string, string>();
  for (const rawEntry of readConfigStringArray(config, "customModels")) {
    const parsed = parseCustomModelEntry(rawEntry);
    if (parsed !== null && !entriesBySlug.has(parsed.slug)) {
      entriesBySlug.set(parsed.slug, rawEntry.trim());
    }
  }
  return [...entriesBySlug.values()];
}

/**
 * Structural equality for config blobs (JSON-shaped data, key order
 * ignored). Used to decide whether a server echo corresponds to the latest
 * pending local write.
 */
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

/**
 * Project an envelope to the shape the server echoes back. The server
 * normalizes secret-bearing fields on write — a sensitive environment value
 * is stored out of band and echoed as `value: ""` with `valueRedacted: true`
 * (and a client-sent `valueRedacted: false` is dropped), and a usage
 * source's `managementKey` is redacted the same way — so a pending envelope
 * can never match its echo byte-for-byte after such a write, which would
 * leave it pending forever and let later local edits overwrite newer remote
 * changes. Masking those fields on both sides lets such echoes acknowledge
 * the pending write. A concurrent foreign edit differing only in masked
 * fields can acknowledge one write early; that merely reverts this card to
 * prop-based behavior, and the local write's own echo still lands.
 */
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

/**
 * Set `key` to an arbitrary value on the opaque config blob. Unlike
 * provider settings field updates, does not drop empty-looking values — the
 * caller is responsible for deciding whether an empty array / empty
 * object should be stored explicitly (e.g. `customModels: []` is a
 * meaningful "user cleared their custom list" state distinct from
 * "driver default").
 */
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
  readonly customModels: ReadonlyArray<string>;
}): ReadonlyArray<ServerProviderModel> {
  const liveCustomModelsBySlug = new Map(
    Arr.filterMap(input.liveModels ?? [], (model) =>
      model.isCustom ? Result.succeed([model.slug, model] as const) : Result.failVoid,
    ),
  );
  const serverModels = input.liveModels?.filter((model) => !model.isCustom) ?? [];
  const seen = new Set<string>();
  const customModels = Arr.filterMap(input.customModels, (entry) => {
    const parsed = parseCustomModelEntry(entry);
    if (!parsed || seen.has(parsed.slug)) {
      return Result.failVoid;
    }
    seen.add(parsed.slug);
    return Result.succeed(
      liveCustomModelsBySlug.get(parsed.slug) ?? {
        slug: parsed.slug,
        name: parsed.name,
        isCustom: true,
        capabilities: null,
      },
    );
  });
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

function ProviderEnvironmentSection(props: {
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
    <div className="mt-3 min-w-0 space-y-2">
      {rows.map((variable, index) => (
        <div key={variable.id} className="flex min-w-0 items-center gap-1.5">
          <DraftInput
            size="sm"
            className="w-44 shrink-0 font-mono"
            value={variable.name}
            onCommit={(name) => updateVariable(variable.id, { name: name.trim() })}
            placeholder="VARIABLE_NAME"
            spellCheck={false}
            aria-label={`Environment variable name ${index + 1}`}
          />
          <span className="text-xs text-muted-foreground" aria-hidden>
            =
          </span>
          <DraftInput
            size="sm"
            className="min-w-0 flex-1 font-mono"
            value={variable.valueRedacted ? "" : variable.value}
            onCommit={(value) => updateVariable(variable.id, { value })}
            type={variable.sensitive ? "password" : undefined}
            autoComplete="off"
            placeholder={
              variable.valueRedacted ? "Stored secret, enter a new value to replace" : "value"
            }
            spellCheck={false}
            aria-label={`Environment variable value ${index + 1}`}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className={cn(
                    "[--control-icon-color:currentColor]",
                    variable.sensitive && "text-foreground",
                  )}
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
                  {variable.sensitive ? (
                    <LockIcon className="size-3" />
                  ) : (
                    <LockOpenIcon className="size-3" />
                  )}
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
            variant="ghost-muted"
            className="[--control-icon-color:currentColor] hover:text-destructive"
            onClick={() => removeVariable(variable.id)}
            aria-label={`Remove environment variable ${variable.name || index + 1}`}
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      ))}
      <div className="flex min-h-[1.875rem] flex-wrap items-center justify-end gap-x-3 gap-y-1">
        {rows.length > 0 ? (
          <span className="mr-auto text-xs text-muted-foreground">
            Sensitive values are stored separately and never returned to the app.
          </span>
        ) : null}
        <Button type="button" size="xs" variant="ghost-muted" onClick={addVariable}>
          <PlusIcon className="size-3" />
          Add variable
        </Button>
      </div>
    </div>
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
            placeholder="Management URL — defaults to the ANTHROPIC_BASE_URL origin"
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

interface ProviderInstanceCardProps {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driverOption: DriverOption | undefined;
  readonly liveProvider: ServerProvider | undefined;
  /** Shared by the list row and editor mount for this environment. */
  readonly pendingInstancesRef: {
    current: Map<ProviderInstanceId, ProviderInstanceConfig>;
  };
  readonly mode: "list" | "editor";
  readonly selected?: boolean | undefined;
  readonly onSelect?: (() => void) | undefined;
  readonly readOnly?: boolean | undefined;
  readonly onUpdate: (nextInstance: ProviderInstanceConfig) => void;
  /**
   * Pass `undefined` to hide the delete footer entirely. Built-in default
   * instance slots use `undefined` — they can't be deleted without losing
   * the slot, and their "reset to defaults" affordance lives on an outer
   * reset button instead. Explicit `| undefined` in the type accommodates
   * `exactOptionalPropertyTypes: true`, where an absent key and
   * `{ onDelete: undefined }` are treated as distinct shapes.
   */
  readonly onDelete?: (() => void) | undefined;
  /**
   * Optional outer reset button rendered next to the driver icon. Built-in
   * default slots supply a reset-to-factory control here; custom instances
   * omit it.
   */
  readonly headerAction?: ReactNode | undefined;
  /**
   * Same-driver sibling instances offered as rate-limit failover targets.
   * Empty (or absent) hides the failover control — with a single instance
   * of a driver there is nothing to fail over to.
   */
  readonly failoverOptions?: ReadonlyArray<{
    readonly id: ProviderInstanceId;
    readonly label: string;
    /**
     * False when the server would refuse to route to this target — disabled,
     * or in a different continuation group (no shared session state). Such a
     * target is still selectable, but the card warns that failover will not
     * run, since the server only logs the refusal.
     */
    readonly compatible: boolean;
  }>;
  readonly setup?: ReactNode;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly onRunUpdate?: (() => void) | undefined;
  readonly isUpdating?: boolean | undefined;
}

/**
 * Renders one provider instance as either a compact selectable list row or
 * the full editor shown beside that list. Both modes use the same enabled
 * state and provider metadata.
 *
 * Behavior notes:
 *   - `liveProvider` is matched by the caller via `instanceId`; when no
 *     match is available (e.g. the server hasn't probed yet, or the
 *     driver is not shipped by the current build) the card still renders
 *     with a neutral "checking" summary.
 *   - Unknown drivers (`driverOption === undefined`) get a read-only
 *     notice instead of editable fields, so fork instances round-trip
 *     without accidentally destroying their config.
 *   - The enabled Switch writes to the envelope's `instance.enabled`
 *     field, which is the single enabled flag: the server folds any legacy
 *     driver-specific `config.enabled` into the envelope on load and both
 *     sides resolve through `resolveProviderInstanceEnabled` (an explicit
 *     false wins, then envelope, then config, then the driver default).
 */
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
  onUpdate,
  onDelete,
  headerAction,
  failoverOptions,
  setup,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
  onRunUpdate,
  isUpdating = false,
}: ProviderInstanceCardProps) {
  const enabled = resolveProviderInstanceEnabled(instance);
  // A locally disabled provider reads "Disabled" with a muted dot even if its
  // last server status is stale. Enabled providers use the server status.
  const statusKey: ProviderStatusKey = enabled
    ? ((liveProvider?.status as ProviderStatusKey | undefined) ?? "warning")
    : "disabled";
  const statusStyle = PROVIDER_STATUS_STYLES[statusKey];
  const summary = enabled
    ? getProviderSummary(liveProvider)
    : { headline: "Disabled", detail: null };
  const authEmail = liveProvider?.auth.email?.trim();
  const isAuthenticated = enabled && liveProvider?.auth.status === "authenticated";
  const authLabel =
    enabled && liveProvider?.auth.status === "authenticated"
      ? (liveProvider.auth.label ?? liveProvider.auth.type ?? null)
      : null;
  const versionLabel = getProviderVersionLabel(liveProvider?.version);
  const versionAdvisory = getProviderVersionAdvisoryPresentation(liveProvider?.versionAdvisory);
  const updateCommand = versionAdvisory?.updateCommand ?? null;
  const FallbackIconComponent = driverOption?.icon;
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

  // Narrow `instance.driver` for callers that key on the closed
  // `ProviderDriverKind` union (e.g. `normalizeModelSlug`'s alias table). Custom
  // fork drivers pass through as `null` and those callers fall back to
  // verbatim behaviour.
  const driverKind: ProviderDriverKind | null = isProviderDriverKind(instance.driver)
    ? instance.driver
    : null;
  // Settings writes have no optimistic local patch (the `instance` prop only
  // updates once the server echoes the new envelope back), and the whole
  // `providerInstances` map is replaced per write. A second edit computed
  // from the still-stale prop would therefore silently drop an in-flight
  // first one — add two models back to back, add a model and immediately
  // pick its icon, or pick an icon and then toggle Enabled (the envelope
  // spread carries the stale config, and vice versa). Every mutator in this
  // card therefore bases on the last *written* envelope. The pending map is
  // owned by the panel so the list and editor mounts share one envelope and
  // selecting another provider cannot discard it. An entry is only cleared
  // when an echo structurally matches it: an intermediate echo (of an older
  // write, or a foreign edit) must not make a newer in-flight write invisible
  // to the next edit. Secret-bearing fields use the server-normalized shape
  // from withComparableSecrets so redacted echoes still acknowledge.
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
    commitInstance({ ...baseInstance(), enabled: value });
  };

  if (mode === "list") {
    const listTitleIconNode = driverKind ? (
      <ProviderInstanceIcon
        driverKind={driverKind}
        displayName={displayName}
        accentColor={accentColor}
        showBadge={Boolean(accentColor)}
        className="size-5"
        iconClassName="size-4 text-foreground/80"
        badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]"
      />
    ) : FallbackIconComponent ? (
      <span className="inline-flex size-5 shrink-0 items-center justify-center">
        <FallbackIconComponent className="size-4 text-foreground/80" aria-hidden />
      </span>
    ) : (
      <span
        className="inline-flex size-5 shrink-0 items-center justify-center text-[10px] font-semibold leading-none text-foreground/80"
        aria-hidden
      >
        {providerInstanceInitials(displayName)}
      </span>
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
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-md text-left outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring",
            !enabled && !selected && "opacity-60 group-hover:opacity-100",
          )}
          onClick={onSelect}
          aria-pressed={selected}
        >
          {listTitleIconNode}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
              {String(instanceId) !== String(instance.driver) ? (
                <code className="min-w-0 truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
                  {instanceId}
                </code>
              ) : null}
              {listVersionCodeNode}
              {versionAdvisory ? (
                <span role="img" aria-label="Update available" className="inline-flex shrink-0">
                  <ArrowUpCircleIcon className="size-3.5 text-muted-foreground" />
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 flex items-start gap-1.5 text-[13px] leading-[1.45] text-muted-foreground/80">
              {listStatusDotNode ? (
                <span className="flex h-[1.45em] shrink-0 items-center">{listStatusDotNode}</span>
              ) : null}
              <span className="line-clamp-2 [overflow-wrap:anywhere]">
                {summary.headline}
                {listNeedsAttention && summary.detail ? ` · ${summary.detail}` : null}
              </span>
            </span>
          </span>
        </button>
        <span className="flex h-5 shrink-0 items-center">
          <Switch
            checked={enabled}
            disabled={readOnly}
            onCheckedChange={(checked) => updateEnabled(Boolean(checked))}
            aria-label={`Enable ${displayName}`}
          />
        </span>
      </div>
    );
  }

  const customModels =
    instance.driver === "antigravity" ? [] : readConfigCustomModels(instance.config);
  const customModelIcons =
    instance.driver === "antigravity"
      ? EMPTY_STRING_RECORD
      : readConfigStringRecord(instance.config, "customModelIcons");
  // Server-returned models may lag behind settings writes. Treat probe
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
    // The form computes a complete replacement blob from its rendered
    // `value` prop, which may predate an in-flight models/icons write. The
    // form never edits the models-section keys, so re-overlay those from
    // the latest base instead of letting the stale form snapshot clobber
    // them (or resurrect ones the base deleted).
    const base = baseConfig();
    const baseObject =
      base !== null && typeof base === "object" ? (base as Record<string, unknown>) : undefined;
    let next = formConfig;
    for (const key of MODEL_SECTION_CONFIG_KEYS) {
      const baseValue = baseObject?.[key];
      if (baseValue !== undefined) {
        next = { ...next, [key]: baseValue };
      } else if (next !== undefined && Object.hasOwn(next, key)) {
        const { [key]: _drop, ...rest } = next;
        next = rest;
      }
    }
    commitConfig(next);
  };

  const addCustomModel = (entry: string) => {
    const base = baseConfig();
    const entries = readConfigCustomModels(base);
    const slug = parseCustomModelEntry(entry)?.slug;
    if (slug === undefined) return;
    // Authoritative dedupe by parsed slug: the section validates against
    // its rendered list, which may lag behind an in-flight add of the same
    // slug (possibly under a different label).
    if (entries.some((existing) => parseCustomModelEntry(existing)?.slug === slug)) return;
    commitConfig(nextConfigBlobWithValue(base, "customModels", [...entries, entry.trim()]));
  };

  const removeCustomModel = (slug: string) => {
    const base = baseConfig();
    const entries = readConfigCustomModels(base).filter(
      (entry) => parseCustomModelEntry(entry)?.slug !== slug,
    );
    const nextConfig = nextConfigBlobWithValue(base, "customModels", [...entries]);
    // Prune icon overrides for removed slugs in the same write — a separate
    // icons write here would start from the same base and lose the
    // model-list change. Icons are keyed by the parsed slug, not the raw
    // labeled entry.
    const remainingSlugs = new Set(
      Arr.filterMap(entries, (entry) => {
        const parsed = parseCustomModelEntry(entry);
        return parsed !== null ? Result.succeed(parsed.slug) : Result.failVoid;
      }),
    );
    const keptIcons = Object.fromEntries(
      Object.entries(readConfigStringRecord(base, "customModelIcons")).filter(([iconSlug]) =>
        remainingSlugs.has(iconSlug),
      ),
    );
    if (Object.keys(keptIcons).length > 0) {
      nextConfig.customModelIcons = keptIcons;
    } else {
      delete nextConfig.customModelIcons;
    }
    commitConfig(nextConfig);
  };

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

  const failoverInstanceId = instance.failoverInstanceId;
  const selectedFailoverOption =
    failoverInstanceId !== undefined
      ? (failoverOptions?.find((option) => option.id === failoverInstanceId) ?? {
          id: failoverInstanceId,
          label: String(failoverInstanceId),
          // Not in the options list at all: the referenced instance no longer
          // exists (renamed or deleted elsewhere).
          compatible: false,
        })
      : undefined;
  const failoverWarning =
    selectedFailoverOption === undefined || selectedFailoverOption.compatible
      ? null
      : failoverOptions?.some((option) => option.id === selectedFailoverOption.id)
        ? "This instance does not share session state with the one above (or is disabled), so failover will not run. Give both instances the same config dir — differing only by shadow config dir — or pick another instance."
        : "This instance no longer exists. Failover will not run until you pick another instance.";
  const updateFailoverInstanceId = (value: string) => {
    // Map the select's string back to the branded id; "None" and stale
    // values both clear the field.
    const target = failoverOptions?.find((option) => String(option.id) === value)?.id;
    const { failoverInstanceId: _omit, ...rest } = baseInstance();
    commitInstance(
      target !== undefined
        ? ({ ...rest, failoverInstanceId: target } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateEnvironment = (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => {
    const cleaned = environment.filter((variable) => variable.name.trim().length > 0);
    const { environment: _omit, ...rest } = baseInstance();
    commitInstance(
      cleaned.length > 0
        ? ({ ...rest, environment: cleaned } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
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

  const titleIconNode = driverKind ? (
    <ProviderInstanceIcon
      driverKind={driverKind}
      displayName={displayName}
      accentColor={accentColor}
      showBadge={Boolean(accentColor)}
      className="size-5"
      iconClassName="size-4 text-foreground/80"
      badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]"
    />
  ) : FallbackIconComponent ? (
    <span className="inline-flex size-5 shrink-0 items-center justify-center">
      <FallbackIconComponent className="size-4 text-foreground/80" aria-hidden />
    </span>
  ) : (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center text-[10px] font-semibold leading-none text-foreground/80"
      aria-hidden
    >
      {providerInstanceInitials(displayName)}
    </span>
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
  // Trouble states carry the server's explanation (a failed probe, a shadow
  // home entry that is not a symlink, a missing binary). Show it wherever the
  // headline shows so the user can act without opening the editor.
  const needsAttention = statusKey === "warning" || statusKey === "error";
  const editorStatusNode =
    isAuthenticated && authEmail ? (
      <>
        {needsAttention ? statusDotNode : null}
        <span>Authenticated as</span>
        <ProviderAuthEmail email={authEmail} />
        {authLabel ? <span>· {authLabel}</span> : null}
        {summary.detail ? (
          <span className="min-w-0 [overflow-wrap:anywhere]">· {summary.detail}</span>
        ) : null}
      </>
    ) : (
      <>
        {statusDotNode}
        <span>{summary.headline}</span>
        {summary.detail ? (
          <span className="min-w-0 [overflow-wrap:anywhere]">· {summary.detail}</span>
        ) : null}
      </>
    );
  const editorHeaderAction = (
    <div className="flex min-w-0 items-center gap-1.5">
      {driverOption?.badgeLabel ? (
        <Badge variant="warning" size="sm" className="shrink-0">
          {driverOption.badgeLabel}
        </Badge>
      ) : null}
      {versionCodeNode}
      <span
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        className={cn("inline-flex items-center gap-1", readOnly && "opacity-50")}
      >
        {versionAdvisory ? (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost"
                  className={cn(
                    "[--control-icon-color:currentColor]",
                    versionAdvisory.emphasis === "strong"
                      ? "text-warning hover:text-warning"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  aria-label="Update available — view details"
                >
                  <ArrowUpCircleIcon className="size-3.5" />
                </Button>
              }
            />
            <PopoverPopup
              side="bottom"
              align="end"
              className="w-[min(21rem,calc(100vw-1.5rem))] [--popup-width:min(21rem,calc(100vw-1.5rem))]"
            >
              <div className="grid min-w-0 gap-3">
                <div className="grid gap-0.5">
                  <p className="text-[13px] font-semibold leading-tight text-foreground">
                    Update available
                  </p>
                  <p
                    className={cn(
                      "text-xs leading-snug",
                      versionAdvisory.emphasis === "strong"
                        ? "text-warning"
                        : "text-muted-foreground",
                    )}
                  >
                    {versionAdvisory.detail}
                  </p>
                </div>
                {onRunUpdate ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="w-full"
                    disabled={isUpdating}
                    onClick={onRunUpdate}
                  >
                    {isUpdating ? <LoaderIcon className="animate-spin" /> : <DownloadIcon />}
                    {isUpdating ? "Updating" : "Update now"}
                  </Button>
                ) : null}
                {onRunUpdate && updateCommand ? (
                  <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    <span aria-hidden className="h-px flex-1 bg-border" />
                    or, update manually using
                    <span aria-hidden className="h-px flex-1 bg-border" />
                  </div>
                ) : null}
                {updateCommand ? (
                  <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                      {updateCommand}
                    </code>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                            onClick={() =>
                              copyToClipboard(updateCommand, { providerName: displayName })
                            }
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
        ) : null}
        {titleTailNode}
        {onDelete ? (
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            disabled={readOnly}
            className="[--control-icon-color:currentColor] hover:text-destructive"
            onClick={onDelete}
            aria-label={`Delete instance ${instanceId}`}
          >
            <Trash2Icon className="size-3" />
          </Button>
        ) : null}
      </span>
    </div>
  );

  return (
    <>
      <SettingsSection
        title={displayName}
        description={editorStatusNode}
        icon={titleIconNode}
        headerAction={editorHeaderAction}
      >
        <SettingsRow
          title="Display name"
          control={
            <div
              inert={readOnly}
              aria-disabled={readOnly || undefined}
              className={cn(
                "flex w-full items-center justify-end gap-2 sm:w-auto",
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
                className="min-w-0 flex-1 sm:w-56 sm:flex-none"
                value={instance.displayName ?? ""}
                onCommit={updateDisplayName}
                placeholder={driverOption?.label ?? "Instance label"}
                spellCheck={false}
              />
            </div>
          }
        />
      </SettingsSection>

      {setup ? (
        <SettingsSection title="Setup">
          <div className="px-3 py-3 sm:px-4">{setup}</div>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Runtime"
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        className={readOnly ? "opacity-50 select-none" : undefined}
      >
        {driverOption ? (
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
                This instance uses{" "}
                <code className="text-foreground">{String(instance.driver)}</code>, which is not
                available in this build. Its configuration is preserved.
              </span>
            }
          />
        )}
      </SettingsSection>

      {failoverOptions !== undefined &&
      (failoverOptions.length > 0 || failoverInstanceId !== undefined) ? (
        <SettingsSection
          title="Failover"
          inert={readOnly}
          aria-disabled={readOnly || undefined}
          className={readOnly ? "opacity-50 select-none" : undefined}
        >
          <SettingsRow
            title="Failover instance"
            description="When this instance hits its usage limit, turns route to the selected instance until the limit lifts. Both instances must share session state."
            status={
              failoverWarning ? (
                <span className="text-amber-600 dark:text-amber-500">{failoverWarning}</span>
              ) : null
            }
            control={
              <Select
                value={failoverInstanceId !== undefined ? String(failoverInstanceId) : ""}
                onValueChange={(value) => updateFailoverInstanceId(value ?? "")}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-64"
                  aria-label={`Failover instance for ${displayName}`}
                >
                  <SelectValue>{selectedFailoverOption?.label ?? "None"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="">
                    None
                  </SelectItem>
                  {failoverOptions.map((option) => (
                    <SelectItem hideIndicator key={option.id} value={String(option.id)}>
                      {option.compatible ? option.label : `${option.label} — no shared session`}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Environment"
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        className={readOnly ? "opacity-50 select-none" : undefined}
      >
        <SettingsRow
          title="Variables"
          description="API keys, base URLs, and other per-instance CLI settings."
        >
          <ProviderEnvironmentSection
            environment={instance.environment ?? []}
            onChange={updateEnvironment}
          />
        </SettingsRow>
      </SettingsSection>

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
        <SettingsSection
          title="Models"
          inert={readOnly}
          aria-disabled={readOnly || undefined}
          className={readOnly ? "opacity-50 select-none" : undefined}
        >
          <div className="px-3 py-3 sm:px-4">
            <ProviderModelsSection
              instanceId={instanceId}
              driverKind={driverKind}
              models={modelsForDisplay}
              customModels={customModels}
              customModelIcons={customModelIcons}
              hiddenModels={hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelOrder}
              onAddCustomModel={addCustomModel}
              onRemoveCustomModel={removeCustomModel}
              onCustomModelIconChange={updateCustomModelIcon}
              onHiddenModelsChange={onHiddenModelsChange}
              onFavoriteModelsChange={onFavoriteModelsChange}
              onModelOrderChange={onModelOrderChange}
            />
          </div>
        </SettingsSection>
      ) : null}
    </>
  );
}
