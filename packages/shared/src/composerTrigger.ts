export type ComposerTriggerKind = "path" | "pull-request" | "slash-command" | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

function composerFileLinkBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

// Emphasis markers too: `__init__.py` would otherwise render as bold "init.py",
// which no longer matches the path, so the label shows beside the chip.
function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/[\\[\]*_]/g, "\\$&");
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

/** A second slash or backslash makes the whole word a path, even when the caret precedes it. */
export function isPathWord(
  text: string,
  wordStart: number,
  cursor: number,
  isWhitespaceChar: (char: string) => boolean,
): boolean {
  let wordEnd = cursor;
  while (wordEnd < text.length && !isWhitespaceChar(text[wordEnd] ?? "")) {
    wordEnd += 1;
  }
  return /[/\\]/.test(text.slice(wordStart + 1, wordEnd));
}

/**
 * `$5`, `€9.99` and `$10k` are money, not skills. Matches the amounts the inline skill
 * token regexes already refuse to render as skills, plus the punctuation prose puts after
 * one (`$10k.`, `($5)`).
 */
export function isCurrencyAmountQuery(query: string): boolean {
  return /^\.?[0-9][0-9,._]*(?:[kKmMbBtT]|[eE][0-9]+)?[.,;:!?)]*$/.test(query);
}

export function detectComposerPullRequestTrigger(token: string, cursor: number) {
  if (/^[@\p{Sc}]/u.test(token)) return null;
  const match = /(?:^|\p{Ps})#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (!match) return null;
  const query = match[1] ?? "";
  return {
    kind: "pull-request" as const,
    query,
    rangeStart: cursor - query.length - 1,
    rangeEnd: cursor,
  };
}

export function detectComposerTrigger(
  text: string,
  cursorInput: number,
  isWhitespaceChar?: (char: string) => boolean,
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const wsCheck = isWhitespaceChar ?? isWhitespace;
  let tokenIdx = cursor - 1;
  while (tokenIdx >= 0 && !wsCheck(text[tokenIdx] ?? "")) {
    tokenIdx -= 1;
  }
  const tokenStart = tokenIdx + 1;

  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("/")) {
    if (isPathWord(text, tokenStart, cursor, wsCheck)) return null;
    return {
      kind: "slash-command",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const pullRequestTrigger = detectComposerPullRequestTrigger(token, cursor);
  if (pullRequestTrigger) return pullRequestTrigger;
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    if (isCurrencyAmountQuery(token.slice(skillPrefix[0].length))) return null;
    return {
      kind: "skill",
      query: token.slice(skillPrefix[0].length),
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
const LEADING_EMOJI_REGEX = new RegExp(`^${EMOJI_GRAPHEME_PATTERN}[ \\t]*`, "u");
const FORK_MARKER = "(🔱)";
const LEGACY_FORK_MARKER = "🔱";

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

/** `/clear` as the whole message arms a fresh session instead of sending. */
export function isClearComposerCommand(text: string): boolean {
  return /^\/clear\s*$/i.test(text.trim());
}

/** `/side [prompt]`, or its alias `/btw [prompt]`, as the whole message. */
export function parseSideChatCommand(text: string): { prompt: string } | null {
  const match = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { prompt: match[1]?.trim() ?? "" } : null;
}
