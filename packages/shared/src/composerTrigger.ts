export type ComposerTriggerKind = "path" | "slash-command" | "slash-model" | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default";
export type ThreadTitleComposerCommand = "t3-name" | "t3-rename";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

const SIMPLE_MENTION_PATH_REGEX = /^[^\s@"\\]+$/;

export function serializeComposerMentionPath(path: string): string {
  if (SIMPLE_MENTION_PATH_REGEX.test(path)) {
    return path;
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function composerFileLinkBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function encodeMarkdownLinkDestination(path: string): string {
  return encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
}

export function serializeComposerFileLink(path: string): string {
  const label = escapeMarkdownLinkLabel(composerFileLinkBasename(path));
  return `[${label}](${encodeMarkdownLinkDestination(path)})`;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

/**
 * Detect an active trigger (@path, $skill, /command) at the cursor position.
 *
 * Accepts an optional `isWhitespaceChar` override so callers with inline
 * placeholder characters (e.g. terminal context chips on web) can treat
 * those as token boundaries.
 */
export function detectComposerTrigger(
  text: string,
  cursorInput: number,
  isWhitespaceChar?: (char: string) => boolean,
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      if (commandQuery.toLowerCase() === "model") {
        return {
          kind: "slash-model",
          query: "",
          rangeStart: lineStart,
          rangeEnd: cursor,
        };
      }
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/.exec(linePrefix);
    if (modelMatch) {
      return {
        kind: "slash-model",
        query: (modelMatch[1] ?? "").trim(),
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const wsCheck = isWhitespaceChar ?? isWhitespace;
  let tokenIdx = cursor - 1;
  while (tokenIdx >= 0 && !wsCheck(text[tokenIdx] ?? "")) {
    tokenIdx -= 1;
  }
  const tokenStart = tokenIdx + 1;

  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("$")) {
    return {
      kind: "skill",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function parseStandaloneComposerSlashCommand(
  text: string,
): Exclude<ComposerSlashCommand, "model"> | null {
  const match = /^\/(plan|default)\s*$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = match[1]?.toLowerCase();
  if (command === "plan") return "plan";
  return "default";
}

export function parseComposerRenameCommand(text: string): { title: string | null } | null {
  const match = /^\/t3-(?:name|rename)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const title = match[1]?.trim() ?? "";
  return { title: title.length > 0 ? title : null };
}

// The three RGI subdivision flags: England, Scotland, and Wales.
const SUBDIVISION_FLAG_PATTERN =
  "\\u{1F3F4}\\u{E0067}\\u{E0062}(?:\\u{E0065}\\u{E006E}\\u{E0067}|\\u{E0073}\\u{E0063}\\u{E0074}|\\u{E0077}\\u{E006C}\\u{E0073})\\u{E007F}";
const PICTOGRAPH_COMPONENT_PATTERN =
  "(?:(?:\\p{Emoji_Modifier_Base}\\uFE0F?\\p{Emoji_Modifier})|(?:\\p{Extended_Pictographic}\\uFE0F?))";

// One emoji grapheme: a regional-indicator or subdivision flag, a keycap, or
// a pictographic base with at most one variation selector / valid skin tone,
// optionally chained into a ZWJ sequence (e.g. 👨‍👩‍👧). Kept as a `u`-flag
// pattern because Hermes lacks the `v` flag and Intl.Segmenter.
const EMOJI_GRAPHEME_PATTERN = `(?:\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3|${SUBDIVISION_FLAG_PATTERN}|${PICTOGRAPH_COMPONENT_PATTERN}(?:\\u200D${PICTOGRAPH_COMPONENT_PATTERN})*)`;
const SINGLE_EMOJI_REGEX = new RegExp(`^${EMOJI_GRAPHEME_PATTERN}$`, "u");
const LEADING_EMOJI_REGEX = new RegExp(`^${EMOJI_GRAPHEME_PATTERN}[ \\t]*`, "u");
const FORK_MARKER = "(🔱)";
const LEGACY_FORK_MARKER = "🔱";

export function buildThreadTitleComposerText(
  command: ThreadTitleComposerCommand,
  currentTitle: string | null | undefined,
): string {
  const title = currentTitle?.trim() ?? "";
  return command === "t3-name" && title.length > 0 ? `/t3-name ${title}` : `/${command} `;
}

function hasForkMarker(title: string): boolean {
  return title === FORK_MARKER || title.startsWith(`${FORK_MARKER} `);
}

function normalizeLegacyForkMarker(title: string): string {
  if (title === LEGACY_FORK_MARKER) {
    return FORK_MARKER;
  }
  if (title.startsWith(`${LEGACY_FORK_MARKER} `)) {
    return `${FORK_MARKER} ${title.slice(LEGACY_FORK_MARKER.length).trimStart()}`;
  }
  return title;
}

export function formatForkedThreadTitle(title: string): string {
  const trimmed = title.trim();
  const leadingEmoji = LEADING_EMOJI_REGEX.exec(trimmed);
  if (!leadingEmoji) {
    const normalized = normalizeLegacyForkMarker(trimmed);
    if (hasForkMarker(normalized)) {
      return normalized;
    }
    return normalized.length > 0 ? `${FORK_MARKER} ${normalized}` : FORK_MARKER;
  }

  const statusEmoji = leadingEmoji[0].trimEnd();
  const rest = trimmed.slice(leadingEmoji[0].length);
  if (statusEmoji === LEGACY_FORK_MARKER) {
    return rest.length > 0 ? `${FORK_MARKER} ${rest}` : FORK_MARKER;
  }

  const normalizedRest = normalizeLegacyForkMarker(rest);
  if (hasForkMarker(normalizedRest)) {
    return `${statusEmoji} ${normalizedRest}`;
  }
  return normalizedRest.length > 0
    ? `${statusEmoji} ${FORK_MARKER} ${normalizedRest}`
    : `${statusEmoji} ${FORK_MARKER}`;
}

export function parseComposerStatusCommand(text: string): { emoji: string | null } | null {
  const match = /^\/t3-status(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const value = match[1]?.trim() ?? "";
  return { emoji: SINGLE_EMOJI_REGEX.test(value) ? value : null };
}

export function applyThreadStatusEmoji(title: string, emoji: string): string {
  const trimmed = title.trim();
  const leadingEmoji = LEADING_EMOJI_REGEX.exec(trimmed);
  if (leadingEmoji?.[0].trimEnd() === LEGACY_FORK_MARKER) {
    const rest = trimmed.slice(leadingEmoji[0].length);
    return rest.length > 0 ? `${emoji} ${FORK_MARKER} ${rest}` : `${emoji} ${FORK_MARKER}`;
  }
  const rest = leadingEmoji ? trimmed.slice(leadingEmoji[0].length) : trimmed;
  return rest.length > 0 ? `${emoji} ${rest}` : emoji;
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
