export type ComposerTriggerKind =
  | "path"
  | "pull-request"
  | "slash-command"
  | "slash-model"
  | "skill";
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
 * A slash word with a second slash, such as `/tmp/build.sh`, is a path, not a
 * command. The whole word counts, so a caret before the second slash still sees it.
 */
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
  return text.slice(wordStart + 1, wordEnd).includes("/");
}

/**
 * `$5`, `€9.99` and `$10k` are money, not skills. Matches the amounts the inline skill
 * token regexes already refuse to render as skills, plus the punctuation prose puts after
 * one (`$10k.`, `($5)`).
 */
export function isCurrencyAmountQuery(query: string): boolean {
  return /^\.?[0-9][0-9,._]*(?:[kKmMbBtT]|[eE][0-9]+)?[.,;:!?)]*$/.test(query);
}

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
    if (commandMatch && isPathWord(text, lineStart, cursor, isWhitespaceChar ?? isWhitespace)) {
      return null;
    }
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
  if (token.startsWith("/")) {
    if (isPathWord(text, tokenStart, cursor, wsCheck)) return null;
    return {
      kind: "slash-command",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const pullRequestMatch = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (pullRequestMatch)
    return {
      kind: "pull-request",
      query: pullRequestMatch[1] ?? "",
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
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

/**
 * Matches standalone archive commands so ordinary prompts remain provider input.
 * The bare command toggles a pending archive; `cancel` is kept as an explicit alias.
 */
export function parseComposerArchiveCommand(
  text: string,
): { action: "toggle" | "cancel" | null } | null {
  const match = /^\/t3-archive(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const argument = match[1]?.trim().toLowerCase() ?? "";
  return { action: argument === "" ? "toggle" : argument === "cancel" ? "cancel" : null };
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
