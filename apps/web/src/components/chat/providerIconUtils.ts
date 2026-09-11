import { isProviderDriverKind, ProviderDriverKind } from "@t3tools/contracts";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  GrokIcon,
  HermesIcon,
  Icon,
  OpenAI,
  OpenCodeIcon,
  ZaiIcon,
} from "../Icons";

export type ProviderPickerKind = ProviderDriverKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  /** Shown on the model picker sidebar when relevant */
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("grok"),
    label: "Grok",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("hermes"),
    label: "Hermes",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    available: true,
    pickerSidebarBadge: "new",
  },
];

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("hermes")]: HermesIcon,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
};

/**
 * Model-family glyphs with no provider driver behind them (e.g. Z.ai's GLM
 * models served through a gateway). Ids share the `customModelIcons` slot
 * with driver kinds, so they must never collide with a driver kind.
 */
const EXTRA_MODEL_ICONS = {
  zai: { label: "Z.ai", Icon: ZaiIcon },
} satisfies Readonly<Record<string, { readonly label: string; readonly Icon: Icon }>>;

export const EXTRA_MODEL_ICON_IDS: ReadonlyArray<string> = Object.keys(EXTRA_MODEL_ICONS);

/**
 * Resolve a per-model icon override to its glyph component. Icon ids are
 * provider driver kinds ("codex", "claudeAgent", …) or an extra model-family
 * id ("zai") so a custom model served through a gateway (e.g. a Codex model
 * behind the Claude provider) can carry the icon of the model's real family.
 * Unknown ids resolve to `null` and
 * callers fall back to the instance's driver icon. The `Object.hasOwn` guard
 * matters: ids come from a user-editable settings blob, and a value like
 * "constructor" passes the open slug check but must not resolve to an
 * inherited `Object.prototype` member.
 */
export function getModelIconComponent(icon: string | null | undefined): Icon | null {
  if (!icon) return null;
  if (isProviderDriverKind(icon) && Object.hasOwn(PROVIDER_ICON_BY_PROVIDER, icon)) {
    return PROVIDER_ICON_BY_PROVIDER[icon] ?? null;
  }
  return Object.hasOwn(EXTRA_MODEL_ICONS, icon)
    ? EXTRA_MODEL_ICONS[icon as keyof typeof EXTRA_MODEL_ICONS].Icon
    : null;
}

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

/**
 * Selectable icon choices for custom models — one per available provider
 * glyph, then the extra model-family glyphs. Rendered by the Settings icon
 * picker; the stored id is consumed by {@link getModelIconComponent}.
 */
export const MODEL_ICON_OPTIONS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly Icon: Icon;
}> = [
  ...AVAILABLE_PROVIDER_OPTIONS.flatMap((option) => {
    const IconComponent = PROVIDER_ICON_BY_PROVIDER[option.value];
    return IconComponent ? [{ id: option.value, label: option.label, Icon: IconComponent }] : [];
  }),
  ...Object.entries(EXTRA_MODEL_ICONS).map(([id, { label, Icon }]) => ({ id, label, Icon })),
];

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  /** Per-model icon override (a model icon id); see {@link getModelIconComponent}. */
  icon?: string | undefined;
  isUnavailable?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
