"use client";

import {
  ArrowUpCircleIcon,
  CopyIcon,
  DownloadIcon,
  LoaderIcon,
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
import { Checkbox } from "../ui/checkbox";
import { DraftInput } from "../ui/draft-input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DriverOption } from "./providerDriverMeta";
import { providerSettingsTabClassName } from "./providerSettingsTabs";
import { ProviderSettingsForm } from "./ProviderSettingsForm";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { ProviderInstanceIcon, providerInstanceInitials } from "../chat/ProviderInstanceIcon";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
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

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">Environment variables</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() =>
            setRows([
              ...rows,
              {
                id: nextEnvironmentVariableDraftId(),
                name: "",
                value: "",
                sensitive: true,
              },
            ])
          }
        >
          <PlusIcon className="size-3" />
          Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Add variables to pass API keys, base URLs, or other per-instance CLI settings.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border/70">
          <Table>
            <TableHeader className="bg-muted/25 text-[11px] text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                <TableHead>Variable</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="w-20">Sensitive</TableHead>
                <TableHead className="w-12 text-right">
                  <span className="sr-only">Options</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((variable, index) => (
                <TableRow
                  key={variable.id}
                  className="border-border/60 odd:bg-muted/20 even:bg-background/20"
                >
                  <TableCell>
                    <DraftInput
                      value={variable.name}
                      onCommit={(name) => updateVariable(variable.id, { name: name.trim() })}
                      placeholder="VARIABLE_NAME"
                      spellCheck={false}
                      aria-label={`Environment variable name ${index + 1}`}
                    />
                  </TableCell>
                  <TableCell>
                    <DraftInput
                      value={variable.valueRedacted ? "" : variable.value}
                      onCommit={(value) => updateVariable(variable.id, { value })}
                      type={variable.sensitive ? "password" : undefined}
                      autoComplete="off"
                      placeholder={
                        variable.valueRedacted
                          ? "Stored secret - enter a new value to replace"
                          : "Value"
                      }
                      spellCheck={false}
                      aria-label={`Environment variable value ${index + 1}`}
                    />
                  </TableCell>
                  <TableCell className="w-20">
                    <div className="flex h-8 items-center justify-center">
                      <Checkbox
                        checked={variable.sensitive}
                        onCheckedChange={(checked) => {
                          const sensitive = Boolean(checked);
                          updateVariable(variable.id, {
                            sensitive,
                            ...(sensitive && variable.valueRedacted === undefined
                              ? {}
                              : { valueRedacted: sensitive ? variable.valueRedacted : false }),
                          });
                        }}
                        aria-label={`Mark environment variable ${variable.name || index + 1} as sensitive`}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="w-12">
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        onClick={() => removeVariable(variable.id)}
                        aria-label={`Remove environment variable ${variable.name || index + 1}`}
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <span className="text-xs text-muted-foreground">
        Sensitive values are stored separately and are not returned to the app after saving.
      </span>
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
   * Pass `undefined` to hide the delete button entirely. Built-in default
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
  hiddenModels,
  favoriteModels,
  modelOrder,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
  onRunUpdate,
  isUpdating = false,
}: ProviderInstanceCardProps) {
  const [activeTab, setActiveTab] = useState<"configuration" | "models">("configuration");
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
  // The editor header folds the account email into the status line —
  // "Authenticated as <email> · <plan>" — with the email redacted until its
  // reveal toggle is clicked.
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
  const visibleTab = driverOption === undefined ? "configuration" : activeTab;

  const customModels = readConfigCustomModels(instance.config);
  const customModelIcons = readConfigStringRecord(instance.config, "customModelIcons");
  // Server-returned models may lag behind settings writes. Treat probe
  // models as the source for built-ins only; custom rows come directly
  // from the current instance config so add/remove reflects immediately.
  const modelsForDisplay = deriveProviderModelsForDisplay({
    liveModels: liveProvider?.models,
    customModels,
  });

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

  const updateDisplayName = (value: string) => {
    const trimmed = value.trim();
    const { displayName: _omit, ...rest } = baseInstance();
    commitInstance(
      trimmed.length > 0
        ? ({ ...rest, displayName: trimmed } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateEnabled = (value: boolean) => {
    commitInstance({ ...baseInstance(), enabled: value });
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

  const titleHeadNode = (
    <>
      {titleIconNode}
      <h3 className="truncate text-sm font-medium tracking-[-0.005em] text-foreground">
        {displayName}
      </h3>
      {String(instanceId) !== String(instance.driver) ? (
        <code className="truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
          {instanceId}
        </code>
      ) : null}
      {driverOption?.badgeLabel ? (
        <Badge variant="warning" size="sm" className="shrink-0">
          {driverOption.badgeLabel}
        </Badge>
      ) : null}
    </>
  );

  const titleTailNode = (
    <>
      {headerAction ? (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          {headerAction}
        </span>
      ) : null}
      {onDelete ? (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={onDelete}
                  aria-label={`Delete provider instance ${instanceId}`}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              }
            />
            <TooltipPopup side="top">Delete instance</TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
    </>
  );

  const versionCodeNode = versionLabel ? (
    <code className="text-xs text-muted-foreground">{versionLabel}</code>
  ) : null;

  // Healthy and disabled rows read fine from their text; only trouble gets a dot.
  const statusDotNode =
    statusKey === "warning" || statusKey === "error" ? (
      <span className={cn("size-1.5 shrink-0 rounded-full", statusStyle.dot)} aria-hidden />
    ) : null;
  const statusHeadlineNode = <span>{summary.headline}</span>;
  // Trouble states carry the server's explanation (a failed probe, a shadow
  // home entry that is not a symlink, a missing binary). Show it wherever the
  // headline shows so the user can act without opening the editor.
  const needsAttention = statusKey === "warning" || statusKey === "error";
  const statusLineClassName =
    "flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] leading-[1.45] text-muted-foreground/80";

  if (mode === "list") {
    return (
      <div
        className={cn(
          // Sidebar-style selection with a fixed row height so the list stays
          // even; the status line clamps to two lines instead of growing.
          "group flex h-19 items-start gap-3 rounded-md px-3 py-2 transition-colors",
          // Foreground-alpha tint so the fill reads the same in light and dark themes.
          selected ? "bg-foreground/8" : "hover:bg-foreground/4",
        )}
      >
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-sm text-left outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring",
            !enabled && !selected && "opacity-60 group-hover:opacity-100",
          )}
          onClick={onSelect}
          aria-pressed={selected}
        >
          {titleIconNode}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
              {String(instanceId) !== String(instance.driver) ? (
                <code className="min-w-0 truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
                  {instanceId}
                </code>
              ) : null}
              {versionCodeNode}
              {versionAdvisory ? (
                <span role="img" aria-label="Update available" className="inline-flex shrink-0">
                  <ArrowUpCircleIcon className="size-3.5 text-update-foreground" />
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 flex items-start gap-1.5 text-[13px] leading-[1.45] text-muted-foreground/80">
              {statusDotNode ? (
                <span className="flex h-[1.45em] shrink-0 items-center">{statusDotNode}</span>
              ) : null}
              <span className="line-clamp-2 [overflow-wrap:anywhere]">
                {summary.headline}
                {needsAttention && summary.detail ? ` · ${summary.detail}` : null}
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

  return (
    <div className="min-w-0 lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <div className="flex min-h-16 shrink-0 items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {titleHeadNode}
            {versionCodeNode}
            {/*
              Only the write actions go inert on read-only sessions; the
              status line below keeps its email reveal clickable.
            */}
            <span
              inert={readOnly}
              aria-disabled={readOnly || undefined}
              className={cn("inline-flex items-center gap-2", readOnly && "opacity-50")}
            >
              {versionAdvisory ? (
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className={cn(
                          "size-5 rounded-sm p-0",
                          versionAdvisory.emphasis === "strong"
                            ? "text-warning hover:text-warning"
                            : "text-update-foreground hover:text-update-foreground",
                        )}
                        aria-label="Update available — view details"
                      >
                        <ArrowUpCircleIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <PopoverPopup
                    side="bottom"
                    align="start"
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
                          variant="default"
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
                          <ScrollArea scrollFade className="h-8 min-w-0 flex-1 rounded-none">
                            <code className="flex h-full w-max items-center whitespace-nowrap pr-3 font-mono text-[11px] text-foreground">
                              {updateCommand}
                            </code>
                          </ScrollArea>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  size="icon-xs"
                                  variant="ghost"
                                  className="size-6 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                                  onClick={() =>
                                    copyToClipboard(updateCommand, {
                                      providerName: displayName,
                                    })
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
            </span>
          </div>
          <p className={statusLineClassName}>
            {statusDotNode}
            {isAuthenticated && authEmail ? (
              <>
                <span>Authenticated as</span>
                <ProviderAuthEmail email={authEmail} />
                {authLabel ? <span>· {authLabel}</span> : null}
              </>
            ) : (
              statusHeadlineNode
            )}
            {summary.detail && !needsAttention ? <span>· {summary.detail}</span> : null}
          </p>
          {summary.detail && needsAttention ? (
            <p className="text-[13px] leading-[1.45] text-muted-foreground/80 [overflow-wrap:anywhere]">
              {summary.detail}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex h-11 shrink-0 border-b border-border/70 px-1">
        <button
          type="button"
          aria-pressed={visibleTab === "configuration"}
          className={providerSettingsTabClassName(visibleTab === "configuration")}
          onClick={() => setActiveTab("configuration")}
        >
          Configuration
        </button>
        {driverOption !== undefined ? (
          <button
            type="button"
            aria-pressed={visibleTab === "models"}
            className={providerSettingsTabClassName(visibleTab === "models")}
            onClick={() => setActiveTab("models")}
          >
            Models
          </button>
        ) : null}
      </div>

      <div className="lg:min-h-0 lg:flex-1">
        <ScrollArea
          scrollFade
          chainVerticalScroll
          className="lg:h-full"
          hidden={visibleTab !== "configuration"}
        >
          <div
            inert={readOnly}
            aria-disabled={readOnly || undefined}
            className={cn("space-y-5 px-4 py-5", readOnly && "opacity-50 select-none")}
          >
            <div>
              <label htmlFor={`provider-instance-${instanceId}-display-name`} className="block">
                <span className="text-xs font-medium text-foreground">Display name</span>
                <DraftInput
                  id={`provider-instance-${instanceId}-display-name`}
                  className="mt-1.5"
                  value={instance.displayName ?? ""}
                  onCommit={updateDisplayName}
                  placeholder={driverOption?.label ?? "Instance label"}
                  spellCheck={false}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  Optional label shown in the provider list.
                </span>
              </label>
            </div>

            <div>
              <ProviderAccentColorPicker
                displayName={displayName}
                value={accentColor}
                onCommit={updateAccentColor}
                commitDelayMs={120}
                description="Used to distinguish this instance in picker rails and model lists."
              />
            </div>

            {failoverOptions !== undefined &&
            (failoverOptions.length > 0 || failoverInstanceId !== undefined) ? (
              <div>
                <span className="text-xs font-medium text-foreground">Failover instance</span>
                <div className="mt-1.5">
                  <Select
                    value={failoverInstanceId !== undefined ? String(failoverInstanceId) : ""}
                    onValueChange={(value) => updateFailoverInstanceId(value ?? "")}
                  >
                    <SelectTrigger
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
                </div>
                <span className="mt-1 block text-xs text-muted-foreground">
                  When this instance hits its usage limit, turns route to the selected instance
                  until the limit lifts. Both instances must share their session state — the same
                  config dir, differing only by shadow config dir.
                </span>
                {failoverWarning ? (
                  <span className="mt-1 block text-xs text-amber-600 dark:text-amber-500">
                    {failoverWarning}
                  </span>
                ) : null}
              </div>
            ) : null}

            <div>
              <ProviderEnvironmentSection
                environment={instance.environment ?? []}
                onChange={updateEnvironment}
              />
            </div>

            <div>
              <ProviderUsageSourceSection
                usageSource={instance.usageSource}
                onChange={updateUsageSource}
              />
            </div>

            {driverOption ? (
              <ProviderSettingsForm
                definition={driverOption}
                value={instance.config}
                idPrefix={`provider-instance-${instanceId}`}
                variant="card"
                onChange={updateConfig}
              />
            ) : null}

            {driverOption === undefined ? (
              <div>
                <p className="text-xs text-muted-foreground">
                  This instance uses a driver (
                  <code className="text-foreground">{String(instance.driver)}</code>) that is not
                  shipped with the current build. Configuration values are preserved but cannot be
                  edited from this surface.
                </p>
              </div>
            ) : null}
          </div>
        </ScrollArea>
        {driverOption !== undefined ? (
          <div
            inert={readOnly}
            aria-disabled={readOnly || undefined}
            className={cn("px-4 py-5 lg:h-full lg:min-h-0", readOnly && "opacity-50 select-none")}
            hidden={visibleTab !== "models"}
          >
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
        ) : null}
      </div>
    </div>
  );
}
