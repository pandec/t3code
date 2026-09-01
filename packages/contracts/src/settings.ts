import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ThreadEnvMode } from "./environment.ts";
import {
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  ProviderOptionSelections,
} from "./model.ts";
import { ModelSelection } from "./orchestration.ts";
import {
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  FILL_PREVIEW_VIEWPORT,
  PreviewAppearancePreference,
  PreviewViewportSetting,
  PreviewZoomFactor,
} from "./preview.ts";
import {
  ProviderInstanceConfig,
  ProviderInstanceId,
  type ProviderDriverKind,
} from "./providerInstance.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarThreadProviderIconVisibility = Schema.Literals(["hover", "always", "never"]);
export type SidebarThreadProviderIconVisibility = typeof SidebarThreadProviderIconVisibility.Type;
export const DEFAULT_SIDEBAR_THREAD_PROVIDER_ICON_VISIBILITY: SidebarThreadProviderIconVisibility =
  "hover";

export const SidebarProjectAccentColor = Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i));
export type SidebarProjectAccentColor = typeof SidebarProjectAccentColor.Type;

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
export const SidebarThreadPreviewCount = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
);
export type SidebarThreadPreviewCount = typeof SidebarThreadPreviewCount.Type;
export const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT: SidebarThreadPreviewCount = 6;
export const MIN_ARCHIVED_SECTION_VISIBLE_COUNT = 1;
export const MAX_ARCHIVED_SECTION_VISIBLE_COUNT = 50;
export const ArchivedSectionVisibleCount = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_ARCHIVED_SECTION_VISIBLE_COUNT,
    maximum: MAX_ARCHIVED_SECTION_VISIBLE_COUNT,
  }),
);
export type ArchivedSectionVisibleCount = typeof ArchivedSectionVisibleCount.Type;
export const DEFAULT_ARCHIVED_SECTION_VISIBLE_COUNT: ArchivedSectionVisibleCount = 10;
export function clampArchivedSectionVisibleCount(value: number): ArchivedSectionVisibleCount {
  return clampSettingNumber({
    value,
    minimum: MIN_ARCHIVED_SECTION_VISIBLE_COUNT,
    maximum: MAX_ARCHIVED_SECTION_VISIBLE_COUNT,
    fallback: DEFAULT_ARCHIVED_SECTION_VISIBLE_COUNT,
    integer: true,
  }) as ArchivedSectionVisibleCount;
}
/**
 * How long a thread must go without activity before the sidebar files it
 * under "Older". Deliberately wider than the auto-settle window: Older is a
 * display grouping for threads the user wants to keep indefinitely, not a
 * lifecycle state, so a year-long threshold is a legitimate choice.
 */
export const MIN_SIDEBAR_OLDER_SECTION_AFTER_DAYS = 1;
export const MAX_SIDEBAR_OLDER_SECTION_AFTER_DAYS = 365;
export const SidebarOlderSectionAfterDays = Schema.Number.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_OLDER_SECTION_AFTER_DAYS,
    maximum: MAX_SIDEBAR_OLDER_SECTION_AFTER_DAYS,
  }),
);
export type SidebarOlderSectionAfterDays = typeof SidebarOlderSectionAfterDays.Type;
export const DEFAULT_SIDEBAR_OLDER_SECTION_AFTER_DAYS: SidebarOlderSectionAfterDays = 7;
export function clampSidebarOlderSectionAfterDays(value: number): SidebarOlderSectionAfterDays {
  return clampSettingNumber({
    value,
    minimum: MIN_SIDEBAR_OLDER_SECTION_AFTER_DAYS,
    maximum: MAX_SIDEBAR_OLDER_SECTION_AFTER_DAYS,
    fallback: DEFAULT_SIDEBAR_OLDER_SECTION_AFTER_DAYS,
    integer: true,
  }) as SidebarOlderSectionAfterDays;
}
export const MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 1;
export const MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 90;
export const SidebarAutoSettleAfterDays = Schema.Number.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
    maximum: MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  }),
);
export type SidebarAutoSettleAfterDays = typeof SidebarAutoSettleAfterDays.Type;
export const DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS: SidebarAutoSettleAfterDays = 3;
export const MIN_GLASS_OPACITY = 40;
export const MAX_GLASS_OPACITY = 100;
export const GlassOpacity = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_GLASS_OPACITY,
    maximum: MAX_GLASS_OPACITY,
  }),
);
export type GlassOpacity = typeof GlassOpacity.Type;
export const DEFAULT_GLASS_OPACITY: GlassOpacity = 80;

export const MIN_APPEARANCE_CONTRAST = 50;
export const MAX_APPEARANCE_CONTRAST = 200;
export const AppearanceContrast = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_APPEARANCE_CONTRAST, maximum: MAX_APPEARANCE_CONTRAST }),
);
export type AppearanceContrast = typeof AppearanceContrast.Type;
export const DEFAULT_APPEARANCE_CONTRAST: AppearanceContrast = 100;
/**
 * Font size preferences, in CSS pixels. The ranges are deliberately narrow:
 * the interface size scales every rem-based dimension in the app, so the
 * bounds keep layouts intact rather than offering unusable extremes.
 */
export const MIN_INTERFACE_FONT_SIZE = 12;
export const MAX_INTERFACE_FONT_SIZE = 20;
export const InterfaceFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_INTERFACE_FONT_SIZE, maximum: MAX_INTERFACE_FONT_SIZE }),
);
export type InterfaceFontSize = typeof InterfaceFontSize.Type;
export const DEFAULT_INTERFACE_FONT_SIZE: InterfaceFontSize = 16;

export const MIN_PROMPT_FONT_SIZE = 12;
export const MAX_PROMPT_FONT_SIZE = 20;
export const PromptFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_PROMPT_FONT_SIZE, maximum: MAX_PROMPT_FONT_SIZE }),
);
export type PromptFontSize = typeof PromptFontSize.Type;
export const DEFAULT_PROMPT_FONT_SIZE: PromptFontSize = 14;

export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 18;
export const CodeFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_CODE_FONT_SIZE, maximum: MAX_CODE_FONT_SIZE }),
);
export type CodeFontSize = typeof CodeFontSize.Type;
export const DEFAULT_CODE_FONT_SIZE: CodeFontSize = 13;

export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 20;
export const TerminalFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_TERMINAL_FONT_SIZE, maximum: MAX_TERMINAL_FONT_SIZE }),
);
export type TerminalFontSize = typeof TerminalFontSize.Type;
export const DEFAULT_TERMINAL_FONT_SIZE: TerminalFontSize = 12;

export const EnvironmentIdentificationMode = Schema.Literals(["artwork", "pill", "none"]);
export type EnvironmentIdentificationMode = typeof EnvironmentIdentificationMode.Type;
export const DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE: EnvironmentIdentificationMode = "artwork";

/**
 * Clamp helper shared by every numeric client setting below.
 *
 * Client settings are persisted as one blob and rehydrated by spreading over
 * the defaults rather than by decoding, so a hand-edited or downgraded store
 * can hand a consumer any number at all. Every read site therefore clamps.
 */
function clampSettingNumber(input: {
  readonly value: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly fallback: number;
  readonly integer: boolean;
}): number {
  if (!Number.isFinite(input.value)) {
    return input.fallback;
  }
  const bounded = Math.min(input.maximum, Math.max(input.minimum, input.value));
  return input.integer ? Math.round(bounded) : bounded;
}

export const MIN_STEER_GRACE_WINDOW_MS = 0;
export const MAX_STEER_GRACE_WINDOW_MS = 15_000;
export const SteerGraceWindowMs = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_STEER_GRACE_WINDOW_MS,
    maximum: MAX_STEER_GRACE_WINDOW_MS,
  }),
);
export type SteerGraceWindowMs = typeof SteerGraceWindowMs.Type;
export const DEFAULT_STEER_GRACE_WINDOW_MS: SteerGraceWindowMs = 5_000;
export function clampSteerGraceWindowMs(value: number): SteerGraceWindowMs {
  return clampSettingNumber({
    value,
    minimum: MIN_STEER_GRACE_WINDOW_MS,
    maximum: MAX_STEER_GRACE_WINDOW_MS,
    fallback: DEFAULT_STEER_GRACE_WINDOW_MS,
    integer: true,
  }) as SteerGraceWindowMs;
}

export const MIN_PROVIDER_USAGE_ALERT_PERCENT = 1;
export const MAX_PROVIDER_USAGE_ALERT_PERCENT = 100;
export const ProviderUsageAlertPercent = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_PROVIDER_USAGE_ALERT_PERCENT,
    maximum: MAX_PROVIDER_USAGE_ALERT_PERCENT,
  }),
);
export type ProviderUsageAlertPercent = typeof ProviderUsageAlertPercent.Type;
export const DEFAULT_PROVIDER_USAGE_WARNING_PERCENT: ProviderUsageAlertPercent = 80;
export const DEFAULT_PROVIDER_USAGE_CRITICAL_PERCENT: ProviderUsageAlertPercent = 95;
export function clampProviderUsageAlertPercent(
  value: number,
  fallback: ProviderUsageAlertPercent,
): ProviderUsageAlertPercent {
  return clampSettingNumber({
    value,
    minimum: MIN_PROVIDER_USAGE_ALERT_PERCENT,
    maximum: MAX_PROVIDER_USAGE_ALERT_PERCENT,
    fallback,
    integer: true,
  }) as ProviderUsageAlertPercent;
}

export const MIN_ACCENT_TINT_INTENSITY_PERCENT = 4;
export const MAX_ACCENT_TINT_INTENSITY_PERCENT = 30;
export const AccentTintIntensityPercent = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_ACCENT_TINT_INTENSITY_PERCENT,
    maximum: MAX_ACCENT_TINT_INTENSITY_PERCENT,
  }),
);
export type AccentTintIntensityPercent = typeof AccentTintIntensityPercent.Type;
export const DEFAULT_ACCENT_TINT_INTENSITY_PERCENT: AccentTintIntensityPercent = 12;
export function clampAccentTintIntensityPercent(value: number): AccentTintIntensityPercent {
  return clampSettingNumber({
    value,
    minimum: MIN_ACCENT_TINT_INTENSITY_PERCENT,
    maximum: MAX_ACCENT_TINT_INTENSITY_PERCENT,
    fallback: DEFAULT_ACCENT_TINT_INTENSITY_PERCENT,
    integer: true,
  }) as AccentTintIntensityPercent;
}

export const MIN_TURN_COMPLETION_MIN_DURATION_SECONDS = 0;
export const MAX_TURN_COMPLETION_MIN_DURATION_SECONDS = 3_600;
export const TurnCompletionMinDurationSeconds = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_TURN_COMPLETION_MIN_DURATION_SECONDS,
    maximum: MAX_TURN_COMPLETION_MIN_DURATION_SECONDS,
  }),
);
export type TurnCompletionMinDurationSeconds = typeof TurnCompletionMinDurationSeconds.Type;
export const DEFAULT_TURN_COMPLETION_MIN_DURATION_SECONDS: TurnCompletionMinDurationSeconds = 0;
export function clampTurnCompletionMinDurationSeconds(
  value: number,
): TurnCompletionMinDurationSeconds {
  return clampSettingNumber({
    value,
    minimum: MIN_TURN_COMPLETION_MIN_DURATION_SECONDS,
    maximum: MAX_TURN_COMPLETION_MIN_DURATION_SECONDS,
    fallback: DEFAULT_TURN_COMPLETION_MIN_DURATION_SECONDS,
    integer: true,
  }) as TurnCompletionMinDurationSeconds;
}

/**
 * A user-chosen font family (a single name or a comma-separated list). Empty
 * means "use the app default"; clients compose their own fallback stacks.
 */
export const FontFamilyPreference = Schema.String.check(Schema.isMaxLength(200));
export type FontFamilyPreference = typeof FontFamilyPreference.Type;

/**
 * The environment's theme, set with `t3 theme set <id>`. Each client applies
 * it once per value — live when connected, on its next connect otherwise — so
 * setting it switches every client, while a theme a user picks in Settings
 * afterwards sticks until the next set. Empty means "no environment theme",
 * which is also how it is cleared.
 */
export const DefaultThemePreference = Schema.String.check(Schema.isMaxLength(64));
// Deliberately absent from ServerSettingsPatch: `t3 theme set` checks that an
// id is syntactically valid and actually resolvable, and a generic RPC patch
// would let a client write a theme no client can resolve, bypassing both.
export type DefaultThemePreference = typeof DefaultThemePreference.Type;

/**
 * Defaults for the in-app preview browser, applied whenever a tab is opened
 * without an explicit viewport/zoom/appearance — by the user opening a browser
 * tab, or by an agent calling `preview_open` with no size. Recording quality is
 * client-local for the same reason: the Chromium guest being captured belongs
 * to the desktop app.
 */
export const DEFAULT_BROWSER_VIEWPORT: PreviewViewportSetting = FILL_PREVIEW_VIEWPORT;
export const DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW = true;
export const BROWSER_RECORDING_FRAME_RATES = [30, 60] as const;
export const BrowserRecordingFrameRate = Schema.Literals(BROWSER_RECORDING_FRAME_RATES);
export type BrowserRecordingFrameRate = typeof BrowserRecordingFrameRate.Type;
export const DEFAULT_BROWSER_RECORDING_FRAME_RATE: BrowserRecordingFrameRate = 30;

export const ClientSettingsSchema = Schema.Struct({
  appearanceContrast: AppearanceContrast.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_APPEARANCE_CONTRAST)),
  ),
  archivedSectionVisibleCount: ArchivedSectionVisibleCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ARCHIVED_SECTION_VISIBLE_COUNT)),
  ),
  /**
   * Web-only: whether project accent colors tint the surfaces that carry them
   * (today the sidebar v2 thread rows and new-thread project choices). Off
   * leaves the per-project color picker fully functional — the color still
   * shows as a dot, it just stops washing over rows.
   */
  accentTintsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Alpha, in percent, of the web accent tint overlay. */
  accentTintIntensityPercent: AccentTintIntensityPercent.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ACCENT_TINT_INTENSITY_PERCENT)),
  ),
  browserDefaultViewport: PreviewViewportSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_VIEWPORT)),
  ),
  browserDefaultZoomFactor: PreviewZoomFactor.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PREVIEW_ZOOM_FACTOR)),
  ),
  browserDefaultAppearance: PreviewAppearancePreference.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PREVIEW_APPEARANCE)),
  ),
  browserRecordingFrameRate: BrowserRecordingFrameRate.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_RECORDING_FRAME_RATE)),
  ),
  /**
   * Whether an agent opening a preview pops the floating mini player into
   * view. Only applies when the agent didn't ask either way — an explicit
   * `open`/`show` on `preview_open` still wins, since that is the agent
   * deliberately showing or hiding its work.
   */
  browserAutoShowFloatingPreview: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW)),
  ),
  // Desktop-only: require holding the quit shortcut (Cmd/Ctrl+Q) before the
  // app quits; a quick tap only shows a hint. Browser clients ignore it.
  confirmQuit: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Whether closing a single terminal asks first. Auto-exit cleanup and bulk
  // tab closes never prompt regardless.
  confirmTerminalClose: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  confirmThreadUnpin: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  dismissedProviderUpdateNotificationKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  enableTurnCompletionToasts: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  enableTurnCompletionSystemNotifications: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  enableRateLimitAlerts: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  environmentIdentificationMode: EnvironmentIdentificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE)),
  ),
  glassOpacity: GlassOpacity.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GLASS_OPACITY)),
  ),
  fontSizeInterface: InterfaceFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_INTERFACE_FONT_SIZE)),
  ),
  fontSizePrompt: PromptFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROMPT_FONT_SIZE)),
  ),
  fontSizeCode: CodeFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CODE_FONT_SIZE)),
  ),
  fontSizeTerminal: TerminalFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TERMINAL_FONT_SIZE)),
  ),
  fontFamilyCode: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilyComposer: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilySans: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilyTerminal: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  // Grayscale `-webkit-font-smoothing: antialiased` (thinner strokes);
  // disabling restores the platform's heavier default. No effect off macOS.
  fontSmoothing: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Model favorites. Historically keyed by provider kind, now
  // widened to `ProviderInstanceId` so users can favorite a specific model
  // on a custom provider instance (e.g. "Codex Personal · gpt-5") without
  // the UI collapsing it into the same bucket as the default Codex. The
  // widening is backward-compatible by construction: prior provider-kind
  // strings satisfy the `ProviderInstanceId` slug schema, so previously
  // persisted favorites decode unchanged and continue to point at the
  // default instance for their kind (because `defaultInstanceIdForDriver(kind)`
  // uses the same slug). The field name is kept as `provider` for storage
  // stability; new call sites should treat the value as an instance id.
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * Usage percentages at which the provider quota meter turns amber and red,
   * and at which rate-limit alerts fire. Only web reads these; mobile keeps
   * the defaults because it does not sync client settings.
   */
  providerUsageWarningPercent: ProviderUsageAlertPercent.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_USAGE_WARNING_PERCENT)),
  ),
  providerUsageCriticalPercent: ProviderUsageAlertPercent.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_USAGE_CRITICAL_PERCENT)),
  ),
  /** Web-only: obscure provider account emails in the usage meter. */
  maskProviderUsageEmails: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Web-only: show the OpenRouter credit balance in the usage meter popover.
   * Needs an OpenRouter API key configured on the environment (Settings →
   * Extras) for the balance to actually appear.
   */
  showOpenRouterCredits: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  threadAutoSettleEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Legacy plan mode. The composer's Build/Plan toggle was removed from the
  // default UI; this beta flag restores it (plus the /plan and /default slash
  // commands) for users who still rely on the old workflow.
  planModeEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  showSkillsInSlashMenu: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Legacy sidebar (the original per-project tree). Deliberately a fresh key
  // (was `sidebarV2Enabled` + `sidebarV2ConfiguredByUser`): decoding drops the
  // old keys, so everyone, including prior beta opt-outs, resets to the new
  // default sidebar.
  legacySidebarEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sidebarAutoSettleAfterDays: Schema.NullOr(SidebarAutoSettleAfterDays).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS)),
  ),
  sidebarAutoSettleOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * @deprecated Superseded by `ServerSettings.projectAccentColors`, which is
   * machine-independent and therefore reaches mobile and other clients. Kept in
   * the schema (not dropped) so the one-shot client-side migration can still
   * read pre-migration entries — clients that never reconnect an environment
   * keep their colors here until that environment is seen again. Nothing writes
   * new entries to this map.
   *
   * Keys are `${environmentId}:${normalizedWorkspacePath}`.
   */
  sidebarProjectAccentColors: Schema.Record(TrimmedNonEmptyString, SidebarProjectAccentColor).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  sidebarThreadProviderIconVisibility: SidebarThreadProviderIconVisibility.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PROVIDER_ICON_VISIBILITY)),
  ),
  sidebarThreadPreviewCount: SidebarThreadPreviewCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT)),
  ),
  sidebarV2CompactCards: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sidebarAlwaysShowPinnedInAttention: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  sidebarV2SortActiveByLatestUserMessage: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  sidebarV2NewThreadButtonInProjectRow: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /**
   * Files quiet-but-still-active threads under a foldable "Older" section
   * instead of leaving them in the inbox. Opt-in: with it off the sidebar
   * partitions exactly as before.
   */
  sidebarOlderSectionEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  sidebarOlderSectionAfterDays: SidebarOlderSectionAfterDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_OLDER_SECTION_AFTER_DAYS)),
  ),
  /**
   * The shelf's starting state. Only the default: once the shelf is toggled
   * by hand, that per-device choice sticks until it is toggled again.
   */
  sidebarOlderSectionCollapsedByDefault: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /**
   * How long a steer rests in the outbox before delivery. 0 sends immediately;
   * mobile is unaffected (it keeps the model's built-in default).
   */
  steerGraceWindowMs: SteerGraceWindowMs.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_STEER_GRACE_WINDOW_MS)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  /**
   * Turns shorter than this announce nothing — neither toast nor system
   * notification. 0 (the default) announces every completed turn.
   */
  turnCompletionMinDurationSeconds: TurnCompletionMinDurationSeconds.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TURN_COMPLETION_MIN_DURATION_SECONDS)),
  ),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

// Moved to environment.ts so orchestration contracts can use it without an
// import cycle; re-exported here for compatibility with deep imports.
export { ThreadEnvMode } from "./environment.ts";

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch";

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to codex app-server on session start.",
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath", "launchArgs"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

// Empty, or an integer from 100,000 to 1,000,000. Shared by the full
// Claude settings schema and its patch so an out-of-range value fails at
// the update that introduced it.
const CLAUDE_AUTO_COMPACT_WINDOW_PATTERN = /^(?:|[1-9]\d{5}|1000000)$/;

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CLAUDE_CONFIG_DIR path",
        description:
          "Shared Claude config dir for this instance. Used directly as CLAUDE_CONFIG_DIR unless a shadow config dir is set below.",
        providerSettingsForm: { placeholder: "~/.claude", clearWhenEmpty: "omit" },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow config dir path",
        description:
          "Account-specific config dir used as CLAUDE_CONFIG_DIR for this instance; sessions, skills, and settings are shared from the dir above via symlinks. Log in to it separately: CLAUDE_CONFIG_DIR=<this dir> claude, then /login.",
        providerSettingsForm: {
          placeholder: "~/.claude-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    autoCompactWindow: TrimmedString.check(
      Schema.isPattern(CLAUDE_AUTO_COMPACT_WINDOW_PATTERN),
    ).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Auto-compact after",
        description:
          "Compact after 100,000 to 1,000,000 tokens. Leave empty to use Claude's default.",
        providerSettingsForm: {
          placeholder: "e.g. 300000",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath", "autoCompactWindow", "launchArgs"],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CursorSettings = makeProviderSettingsSchema(
  {
    // Off by default like Grok and OpenCode. Users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("cursor-agent").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Cursor agent binary.",
        providerSettingsForm: { placeholder: "cursor-agent", clearWhenEmpty: "omit" },
      }),
    ),
    apiEndpoint: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API endpoint",
        description: "Override the Cursor API endpoint for this instance.",
        providerSettingsForm: {
          placeholder: "https://...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "apiEndpoint"],
  },
);
export type CursorSettings = typeof CursorSettings.Type;

export const GrokSettings = makeProviderSettingsSchema(
  {
    // Off by default (like Cursor and OpenCode): the binding is not yet
    // stable enough to probe on every install. Users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("grok").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Grok CLI binary.",
        providerSettingsForm: { placeholder: "grok", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);
export type GrokSettings = typeof GrokSettings.Type;

export const HermesSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("hermes").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Hermes CLI binary.",
        providerSettingsForm: { placeholder: "hermes", clearWhenEmpty: "omit" },
      }),
    ),
    authMethodId: Schema.optionalKey(
      TrimmedString.pipe(
        Schema.annotateKey({
          title: "Authentication method",
          description:
            "Optional Hermes ACP authentication method override. By default T3 uses the method advertised by Hermes.",
          providerSettingsForm: {
            placeholder: "Automatic",
            clearWhenEmpty: "omit",
          },
        }),
      ),
    ),
    requireGateway: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Require local gateway",
        description:
          "When enabled, only make Hermes available while its gateway is running on this machine.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "authMethodId", "requireGateway"],
  },
);
export type HermesSettings = typeof HermesSettings.Type;

export const OpenCodeSettings = makeProviderSettingsSchema(
  {
    // Off by default (like Cursor and Grok): the binding is not yet stable
    // enough to probe on every install. Users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OpenCode binary.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server URL",
        description: "Leave blank to let T3 Code spawn the server when needed.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:4096",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverPassword: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server password",
        description: "Stored in plain text on disk.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "serverUrl", "serverPassword"],
  },
);
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

/**
 * Text-to-speech overrides for message playback. Empty means "unset": the
 * server falls back to its `ELEVENLABS_TTS_*` environment variables and then
 * to its built-in defaults, so an untouched install behaves exactly as before.
 */
export const VoiceSettings = Schema.Struct({
  ttsModelId: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  ttsVoiceId: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  // Exposes the voice_reply MCP tool to agent sessions so they can answer
  // with a staged recording. Only effective while the server has an
  // ELEVENLABS_API_KEY; defaults to on so setting the key is enough.
  enableAgentVoiceReplies: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type VoiceSettings = typeof VoiceSettings.Type;

export const SourceControlWritingStyleMode = Schema.Literals([
  "repo_conventions",
  "conventional_commits",
  "custom",
]);
export type SourceControlWritingStyleMode = typeof SourceControlWritingStyleMode.Type;

export const SourceControlWritingStyleSettings = Schema.Struct({
  mode: SourceControlWritingStyleMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("repo_conventions" as const)),
  ),
  customInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  followChangeRequestTemplates: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});
export type SourceControlWritingStyleSettings = typeof SourceControlWritingStyleSettings.Type;

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);
export const DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL = Duration.minutes(5);

export const BackgroundActivityProfile = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
]);
export type BackgroundActivityProfile = typeof BackgroundActivityProfile.Type;
export const DEFAULT_BACKGROUND_ACTIVITY_PROFILE: BackgroundActivityProfile = "balanced";

export const BackgroundActivityProfileSelection = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
  "custom",
]);
export type BackgroundActivityProfileSelection = typeof BackgroundActivityProfileSelection.Type;

export const BackgroundActivityOverrides = Schema.Struct({
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorActiveInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorIdleInterval: Schema.optionalKey(Schema.DurationFromMillis),
  idleClientTtl: Schema.optionalKey(Schema.DurationFromMillis),
  pauseWhenHostLocked: Schema.optionalKey(Schema.Boolean),
  pauseWhenHostLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenClientLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenOnBattery: Schema.optionalKey(Schema.Boolean),
});
export type BackgroundActivityOverrides = typeof BackgroundActivityOverrides.Type;

export const BackgroundActivitySettings = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  profile: BackgroundActivityProfileSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  baseProfile: Schema.optionalKey(BackgroundActivityProfile),
  overrides: BackgroundActivityOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type BackgroundActivitySettings = typeof BackgroundActivitySettings.Type;

export const SavedPrompt = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  content: TrimmedNonEmptyString,
});
export type SavedPrompt = typeof SavedPrompt.Type;

/**
 * A user's reusable prompt library, one atomic value with a library-level
 * last-write-wins stamp (epoch ms).
 *
 * Unlike `projectAccentColors` (a per-key map merged with owner precedence),
 * the library syncs wholesale: clients read the newest stamp among connected
 * environments, stamp and fan writes out to every environment that advertises
 * `savedPrompts`, and push the newest library to stale environments on
 * connect. Whole-library LWW keeps deletion trivial — a per-prompt merge
 * would resurrect deleted prompts from any environment that was offline
 * during the delete.
 */
export const SavedPromptLibrary = Schema.Struct({
  // Deliberately strict (no inner decoding defaults): a partial library in a
  // replacement patch would silently decode as "delete everything". The
  // persisted settings field below defaults only when the KEY is absent.
  updatedAt: Schema.Number,
  prompts: Schema.Array(SavedPrompt),
});
export type SavedPromptLibrary = typeof SavedPromptLibrary.Type;

export const EMPTY_SAVED_PROMPT_LIBRARY: SavedPromptLibrary = { updatedAt: 0, prompts: [] };

export const ServerSettings = Schema.Struct({
  // Legacy token-by-token assistant output. Deliberately a fresh key (was
  // `enableAssistantStreaming`): decoding drops the old key, so everyone,
  // including prior opt-ins, resets to the buffered default.
  enableLegacyTokenStreaming: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Whether agents may drive the in-app preview browser. Turning this off
   * withholds the MCP credential, so the `t3-code` server (and with it every
   * `preview_*` tool) is never attached to a provider session, and the prompt
   * text describing those tools is dropped along with them. The user's own
   * browser panel is unaffected — this gates agent access only.
   *
   * Server-authoritative rather than client-local: tool injection and prompt
   * construction both happen on the server, and the answer must not differ
   * between a desktop window and a phone attached to the same server.
   */
  enableAgentBrowserAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  backgroundActivity: BackgroundActivitySettings,
  // Legacy flat fields retained for old settings files and old clients. New
  // consumers should resolve `backgroundActivity` instead.
  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  providerHealthRefreshInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL)),
    ),
  ),
  backgroundActivityProfile: BackgroundActivityProfile.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  defaultTheme: DefaultThemePreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * When the environment's theme was last set, so clients can tell a re-set
   * of the same value from one they already applied: `t3 theme set` must act
   * even when it names the theme it named before. Empty on environments
   * provisioned by builds that predate it, where clients fall back to
   * applying once per value.
   */
  defaultThemeSetAt: Schema.String.check(Schema.isMaxLength(64)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_TEXT_GENERATION_MODEL,
        options: [
          {
            id: "reasoningEffort",
            value: DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
          },
        ],
      }),
    ),
  ),
  sourceControlWritingStyle: SourceControlWritingStyleSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sourceControlWriterModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    grok: GrokSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    hermes: HermesSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  voice: VoiceSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * Per-project accent colors, shared by every client connected to this
   * server (sidebar v2 on web/desktop, the mobile thread list).
   *
   * Keys are machine-independent on purpose — the repository canonical key
   * when the project has a git remote, otherwise the normalized workspace
   * path — because this map is persisted per environment in that server's
   * `settings.json`. An environmentId in the key would make the entry
   * meaningless the moment another client read it. All worktrees/checkouts
   * of one repository therefore share a single color.
   *
   * Clients merge across every connected environment on read and fan the
   * write out to each environment owning a member of the project group, so
   * the color survives on each machine independently.
   */
  projectAccentColors: Schema.Record(TrimmedNonEmptyString, SidebarProjectAccentColor).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  savedPromptLibrary: SavedPromptLibrary.pipe(
    Schema.withDecodingDefault(Effect.succeed(EMPTY_SAVED_PROMPT_LIBRARY)),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

/**
 * Read the legacy `enabled` flag embedded in a provider instance config
 * blob. The envelope-level `ProviderInstanceConfig.enabled` is the single
 * flag going forward; this reader exists for legacy `providers.<kind>`
 * blobs and old settings files that still carry the flag in-config.
 */
export const providerInstanceConfigEnabledFlag = (config: unknown): boolean | undefined => {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const enabled = (config as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

/**
 * Default enabled state for a built-in driver when neither the envelope nor
 * the config blob carries a flag. Derived from the driver's settings schema
 * through `DEFAULT_SERVER_SETTINGS`, so the schema's decoding default stays
 * the single source of truth. Unknown (fork) drivers default to enabled.
 */
export const defaultEnabledForDriver = (driver: ProviderDriverKind): boolean => {
  const legacyDefaults = DEFAULT_SERVER_SETTINGS.providers as Record<
    string,
    { readonly enabled?: boolean } | undefined
  >;
  return legacyDefaults[driver]?.enabled ?? true;
};

/**
 * Resolve whether a configured provider instance is enabled. An explicit
 * false on either the envelope or the in-config flag wins (most
 * restrictive), so a user's disable is never silently undone by the other
 * flag. Otherwise: envelope, then config, then the driver's default.
 */
export const resolveProviderInstanceEnabled = (
  instance: Pick<ProviderInstanceConfig, "driver" | "enabled" | "config">,
): boolean => {
  const configEnabled = providerInstanceConfigEnabledFlag(instance.config);
  if (instance.enabled === false || configEnabled === false) {
    return false;
  }
  return instance.enabled ?? configEnabled ?? defaultEnabledForDriver(instance.driver);
};

export const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "read-file",
  "read-provider-history",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "write-secret",
  "write-file",
  "prepare-directory",
]);
export type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;
    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;
    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}.`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  shadowHomePath: Schema.optionalKey(TrimmedString),
  launchArgs: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  shadowHomePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(TrimmedString),
  // Validated at the patch boundary so a typo fails the one update with a
  // schema error instead of a generic whole-settings failure.
  autoCompactWindow: Schema.optionalKey(
    TrimmedString.check(Schema.isPattern(CLAUDE_AUTO_COMPACT_WINDOW_PATTERN)),
  ),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  apiEndpoint: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const GrokSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const HermesSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  authMethodId: Schema.optionalKey(TrimmedString),
  requireGateway: Schema.optionalKey(Schema.Boolean),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  serverUrl: Schema.optionalKey(TrimmedString),
  serverPassword: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  // Server settings
  enableLegacyTokenStreaming: Schema.optionalKey(Schema.Boolean),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  backgroundActivity: Schema.optionalKey(
    Schema.Struct({
      schemaVersion: Schema.optionalKey(Schema.Literal(1)),
      profile: Schema.optionalKey(BackgroundActivityProfileSelection),
      baseProfile: Schema.optionalKey(BackgroundActivityProfile),
      overrides: Schema.optionalKey(BackgroundActivityOverrides),
    }),
  ),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  backgroundActivityProfile: Schema.optionalKey(BackgroundActivityProfile),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  sourceControlWritingStyle: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(SourceControlWritingStyleMode),
      customInstructions: Schema.optionalKey(TrimmedString),
      followChangeRequestTemplates: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  voice: Schema.optionalKey(
    Schema.Struct({
      ttsModelId: Schema.optionalKey(TrimmedString),
      ttsVoiceId: Schema.optionalKey(TrimmedString),
      enableAgentVoiceReplies: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      grok: Schema.optionalKey(GrokSettingsPatch),
      hermes: Schema.optionalKey(HermesSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  // Whole-map replacement, like `providerInstances`: clearing a project's
  // accent removes its key, and a deep merge could never express a removal.
  projectAccentColors: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectAccentColor),
  ),
  // Migration-only fill: the server applies each entry iff its key is absent
  // inside the serialized settings write. This keeps a legacy client value
  // from racing with and overwriting an authoritative server-side choice.
  projectAccentColorsFill: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectAccentColor),
  ),
  // Whole-library replacement, like `providerInstances`: the LWW stamp covers
  // the whole value, and a deep merge could never express a prompt removal.
  savedPromptLibrary: Schema.optionalKey(SavedPromptLibrary),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ClientSettingsPatch = Schema.Struct({
  appearanceContrast: Schema.optionalKey(AppearanceContrast),
  archivedSectionVisibleCount: Schema.optionalKey(ArchivedSectionVisibleCount),
  accentTintsEnabled: Schema.optionalKey(Schema.Boolean),
  accentTintIntensityPercent: Schema.optionalKey(AccentTintIntensityPercent),
  browserDefaultViewport: Schema.optionalKey(PreviewViewportSetting),
  browserDefaultZoomFactor: Schema.optionalKey(PreviewZoomFactor),
  browserDefaultAppearance: Schema.optionalKey(PreviewAppearancePreference),
  browserRecordingFrameRate: Schema.optionalKey(BrowserRecordingFrameRate),
  browserAutoShowFloatingPreview: Schema.optionalKey(Schema.Boolean),
  confirmQuit: Schema.optionalKey(Schema.Boolean),
  confirmTerminalClose: Schema.optionalKey(Schema.Boolean),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  confirmThreadUnpin: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  enableTurnCompletionToasts: Schema.optionalKey(Schema.Boolean),
  enableTurnCompletionSystemNotifications: Schema.optionalKey(Schema.Boolean),
  enableRateLimitAlerts: Schema.optionalKey(Schema.Boolean),
  environmentIdentificationMode: Schema.optionalKey(EnvironmentIdentificationMode),
  glassOpacity: Schema.optionalKey(GlassOpacity),
  fontSizeInterface: Schema.optionalKey(InterfaceFontSize),
  fontSizePrompt: Schema.optionalKey(PromptFontSize),
  fontSizeCode: Schema.optionalKey(CodeFontSize),
  fontSizeTerminal: Schema.optionalKey(TerminalFontSize),
  fontFamilyCode: Schema.optionalKey(FontFamilyPreference),
  fontFamilyComposer: Schema.optionalKey(FontFamilyPreference),
  fontFamilySans: Schema.optionalKey(FontFamilyPreference),
  fontFamilyTerminal: Schema.optionalKey(FontFamilyPreference),
  fontSmoothing: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: ProviderInstanceId,
        model: TrimmedNonEmptyString,
      }),
    ),
  ),
  providerModelPreferences: Schema.optionalKey(
    Schema.Record(
      ProviderInstanceId,
      Schema.Struct({
        hiddenModels: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
        modelOrder: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
      }),
    ),
  ),
  providerUsageWarningPercent: Schema.optionalKey(ProviderUsageAlertPercent),
  providerUsageCriticalPercent: Schema.optionalKey(ProviderUsageAlertPercent),
  maskProviderUsageEmails: Schema.optionalKey(Schema.Boolean),
  showOpenRouterCredits: Schema.optionalKey(Schema.Boolean),
  threadAutoSettleEnabled: Schema.optionalKey(Schema.Boolean),
  planModeEnabled: Schema.optionalKey(Schema.Boolean),
  showSkillsInSlashMenu: Schema.optionalKey(Schema.Boolean),
  legacySidebarEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(SidebarAutoSettleAfterDays)),
  sidebarAutoSettleOnMerge: Schema.optionalKey(Schema.Boolean),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectAccentColors: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectAccentColor),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadProviderIconVisibility: Schema.optionalKey(SidebarThreadProviderIconVisibility),
  sidebarThreadPreviewCount: Schema.optionalKey(SidebarThreadPreviewCount),
  sidebarV2CompactCards: Schema.optionalKey(Schema.Boolean),
  sidebarAlwaysShowPinnedInAttention: Schema.optionalKey(Schema.Boolean),
  sidebarV2SortActiveByLatestUserMessage: Schema.optionalKey(Schema.Boolean),
  sidebarV2NewThreadButtonInProjectRow: Schema.optionalKey(Schema.Boolean),
  sidebarOlderSectionEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarOlderSectionAfterDays: Schema.optionalKey(SidebarOlderSectionAfterDays),
  sidebarOlderSectionCollapsedByDefault: Schema.optionalKey(Schema.Boolean),
  steerGraceWindowMs: Schema.optionalKey(SteerGraceWindowMs),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  turnCompletionMinDurationSeconds: Schema.optionalKey(TurnCompletionMinDurationSeconds),
  wordWrap: Schema.optionalKey(Schema.Boolean),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
