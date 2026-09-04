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
} from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

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
 * Resolve a per-model icon override to its glyph component. Icon ids are
 * provider driver kinds ("codex", "claudeAgent", …) so a custom model served
 * through a gateway (e.g. a Codex model behind the Claude provider) can carry
 * the icon of the model's real family. Unknown ids resolve to `null` and
 * callers fall back to the instance's driver icon. The `Object.hasOwn` guard
 * matters: ids come from a user-editable settings blob, and a value like
 * "constructor" passes the open slug check but must not resolve to an
 * inherited `Object.prototype` member.
 */
export function getModelIconComponent(icon: string | null | undefined): Icon | null {
  if (!icon || !isProviderDriverKind(icon) || !Object.hasOwn(PROVIDER_ICON_BY_PROVIDER, icon)) {
    return null;
  }
  return PROVIDER_ICON_BY_PROVIDER[icon] ?? null;
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
 * glyph. Rendered by the Settings icon picker; the stored id is the driver
 * kind string consumed by {@link getModelIconComponent}.
 */
export const MODEL_ICON_OPTIONS: ReadonlyArray<{
  readonly id: ProviderDriverKind;
  readonly label: string;
  readonly Icon: Icon;
}> = AVAILABLE_PROVIDER_OPTIONS.flatMap((option) => {
  const IconComponent = PROVIDER_ICON_BY_PROVIDER[option.value];
  return IconComponent ? [{ id: option.value, label: option.label, Icon: IconComponent }] : [];
});

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  /** Per-model icon override (a driver-kind id); see {@link getModelIconComponent}. */
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
