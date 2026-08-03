"use client";

import {
  ArrowUpCircleIcon,
  ChevronDownIcon,
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
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DriverOption } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
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

function ProviderAuthEmail(props: {
  readonly email: string | undefined;
  readonly prefix?: string;
  readonly separator?: boolean;
}) {
  const trimmed = props.email?.trim();
  if (!trimmed) return null;

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {props.separator ? <span aria-hidden>·</span> : null}
      {props.prefix ? <span className="text-muted-foreground/80">{props.prefix}</span> : null}
      <RedactedSensitiveText
        value={trimmed}
        ariaLabel="Toggle account email visibility"
        revealTooltip="Click to reveal email"
        hideTooltip="Click to hide email"
      />
    </span>
  );
}

function ProviderEnvironmentSection(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const [rows, setRows] = useState<ReadonlyArray<EnvironmentDraftRow>>(() =>
    props.environment.map(makeEnvironmentDraftRow),
  );

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
  readonly isExpanded: boolean;
  readonly onExpandedChange: (open: boolean) => void;
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
 * A single configured provider-instance row in the Providers settings
 * section. Used for every row — both the built-in default instance for a
 * driver (rendered with `onDelete` omitted) and user-authored custom
 * instances (`onDelete` supplied). The only UI difference between the two
 * is whether the trash button is visible; every other field (display
 * name, config fields, models) behaves identically.
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
 *     field; the server's registry consults this at `entry.enabled ?? true`
 *     before materializing the instance, and the probe also checks its
 *     driver-specific `config.enabled`. We treat the envelope flag as the
 *     single source of truth from the UI — built-in cards used to write
 *     the inner flag, but on the promotion-to-instance path every edit
 *     flows through the envelope.
 */
export function ProviderInstanceCard({
  instanceId,
  instance,
  driverOption,
  liveProvider,
  isExpanded,
  onExpandedChange,
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
  const enabled = instance.enabled ?? true;
  // The server-reported status wins when present; otherwise fall back to
  // "disabled"/"warning" based on the local `enabled` flag so the dot
  // reflects the persisted intent even before the first probe completes.
  const statusKey: ProviderStatusKey =
    (liveProvider?.status as ProviderStatusKey | undefined) ?? (enabled ? "warning" : "disabled");
  const statusStyle = PROVIDER_STATUS_STYLES[statusKey];
  const rawSummary = getProviderSummary(liveProvider);
  const authEmail = liveProvider?.auth.email;
  const hasAuthenticatedEmail =
    liveProvider?.auth.status === "authenticated" && Boolean(authEmail?.trim());
  const authenticatedDetail = hasAuthenticatedEmail
    ? (liveProvider?.auth.label ?? liveProvider?.auth.type ?? null)
    : null;
  const summary = rawSummary;
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
  // card therefore bases on the last *written* envelope. The pending ref is
  // only cleared when an echo structurally matches it: an intermediate echo
  // (of an older write, or a foreign edit) must not make a newer in-flight
  // write invisible to the next edit. Environment writes are compared with
  // the server-normalized fields masked (see withComparableSecrets) so
  // their redacted echoes still acknowledge. Remaining caveat, bounded to
  // this card's mount lifetime: a server-rejected write (abnormal —
  // payloads are schema-valid) keeps serving as the base, resubmitted by
  // the next write.
  const pendingInstanceRef = useRef<ProviderInstanceConfig | null>(null);
  useEffect(() => {
    if (
      pendingInstanceRef.current !== null &&
      configsEqual(
        withComparableSecrets(pendingInstanceRef.current),
        withComparableSecrets(instance),
      )
    ) {
      pendingInstanceRef.current = null;
    }
  }, [instance]);
  const baseInstance = () => pendingInstanceRef.current ?? instance;
  const baseConfig = () => baseInstance().config;
  const commitInstance = (next: ProviderInstanceConfig) => {
    pendingInstanceRef.current = next;
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
        next = { ...(next ?? {}), [key]: baseValue };
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
    const managementUrl =
      "managementUrl" in patch ? patch.managementUrl : (base.managementUrl ?? undefined);
    // A newly entered key is unredacted; the server redacts it on echo.
    const keyFields =
      patch.managementKey !== undefined
        ? { managementKey: patch.managementKey, managementKeyRedacted: false }
        : {
            managementKey: base.managementKey,
            ...(base.managementKeyRedacted !== undefined
              ? { managementKeyRedacted: base.managementKeyRedacted }
              : {}),
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
      statusDotClassName={statusStyle.dot}
      indicatorBackground="var(--card)"
      className="size-5"
      iconClassName="size-4 text-foreground/80"
      badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]"
    />
  ) : FallbackIconComponent ? (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <FallbackIconComponent className="size-4 text-foreground/80" aria-hidden />
      <span
        className={cn(
          "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card",
          statusStyle.dot,
        )}
        aria-hidden
      />
    </span>
  ) : (
    <span className={cn("size-2 shrink-0 rounded-full", statusStyle.dot)} />
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
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-destructive"
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

  const authRowNode = (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-[13px] leading-[1.45] text-muted-foreground/80">
      {hasAuthenticatedEmail ? (
        <>
          <span>Authenticated as</span>
          <ProviderAuthEmail email={authEmail} />
          {authenticatedDetail ? <span>· {authenticatedDetail}</span> : null}
        </>
      ) : (
        <>
          <span>{summary.headline}</span>
          <ProviderAuthEmail email={authEmail} separator prefix="Email" />
        </>
      )}
      {summary.detail ? <span>- {summary.detail}</span> : null}
    </p>
  );

  const versionCodeNode = versionLabel ? (
    <code className="text-xs text-muted-foreground">{versionLabel}</code>
  ) : null;

  return (
    <div className="rounded-xl transition-colors hover:bg-muted/20">
      <div className="px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {titleHeadNode}
              {versionCodeNode}
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
                            : "text-primary hover:text-primary",
                        )}
                        aria-label="Update available — view details"
                      >
                        <ArrowUpCircleIcon className="size-3.5 [animation:bounce_2.4s_ease-in-out_infinite] motion-reduce:animate-none" />
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
            </div>
            {authRowNode}
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onExpandedChange(!isExpanded)}
              aria-label={`Toggle ${displayName} details`}
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
              />
            </Button>
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => updateEnabled(Boolean(checked))}
              aria-label={`Enable ${displayName}`}
            />
          </div>
        </div>
      </div>

      <Collapsible open={isExpanded} onOpenChange={onExpandedChange}>
        <CollapsibleContent>
          <div className="space-y-5 px-3 pb-4 pt-2 sm:px-4">
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

            {driverOption !== undefined ? (
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
            ) : (
              <div>
                <p className="text-xs text-muted-foreground">
                  This instance uses a driver (
                  <code className="text-foreground">{String(instance.driver)}</code>) that is not
                  shipped with the current build. Configuration values are preserved but cannot be
                  edited from this surface.
                </p>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
