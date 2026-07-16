/**
 * ClaudeSessionImport — discovery and parsing of Claude Code CLI sessions
 * persisted under `<home>/.claude/projects/<escaped-cwd>/<uuid>.jsonl`.
 *
 * The JSONL format is not a public interchange contract. Parsing is
 * deliberately strict: known-benign record types are skipped, but an
 * unrecognized record type fails the whole parse so format drift surfaces
 * loudly instead of silently dropping history.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class ClaudeTranscriptParseError extends Schema.TaggedErrorClass<ClaudeTranscriptParseError>()(
  "ClaudeTranscriptParseError",
  {
    sessionId: Schema.String,
    line: Schema.Number,
    detail: Schema.String,
  },
) {}

/** Record types that carry no conversation content and are safe to skip. */
const BENIGN_RECORD_TYPES = new Set([
  "summary",
  "queue-operation",
  "file-history-snapshot",
  "file-history-delta",
  "checkpoint",
  "system",
  "progress",
  "attachment",
  "todo",
  "diagnostic",
  "last-prompt",
  "compact-boundary",
  "mode",
  "bridge-session",
  "permission-mode",
  "custom-title",
  "agent-name",
  "ai-title",
  "pr-link",
  "worktree-state",
  "relocated",
  "started",
  "result",
  "fork-context-ref",
  "frame-link",
]);
const SYNTHETIC_MODEL_SENTINEL = "<synthetic>";

export interface ClaudeTranscriptMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface ClaudeParsedTranscript {
  readonly sessionId: string;
  readonly messages: ReadonlyArray<ClaudeTranscriptMessage>;
  readonly model: string | null;
  readonly lastTimestamp: string | null;
}

const decodeJsonLine = Schema.decodeEffect(Schema.UnknownFromJsonString);

interface ChainEntry {
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: string;
  readonly model: string | null;
  readonly hasTextContent: boolean;
}

function extractTextContent(content: unknown): { text: string; hasText: boolean } {
  if (typeof content === "string") {
    return { text: content, hasText: content.length > 0 };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasText: false };
  }
  const parts: Array<string> = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return { text: parts.join("\n"), hasText: parts.length > 0 };
}

const parseChainEntry = Effect.fn("parseChainEntry")(function* (
  record: Record<string, unknown>,
  line: number,
  sessionId: string,
): Effect.fn.Return<ChainEntry | undefined, ClaudeTranscriptParseError> {
  const type = record.type;
  if (type !== "user" && type !== "assistant") {
    return undefined;
  }
  if (record.isSidechain === true) {
    return undefined;
  }
  // Harness-injected content (skill expansions, command scaffolding) is
  // marked isMeta and is not part of the visible conversation.
  if (record.isMeta === true) {
    return undefined;
  }
  const message = record.message;
  if (message === null || typeof message !== "object") {
    return yield* new ClaudeTranscriptParseError({
      sessionId,
      line,
      detail: `Entry of type '${type}' has no message object.`,
    });
  }
  const role = (message as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant") {
    return yield* new ClaudeTranscriptParseError({
      sessionId,
      line,
      detail: `Entry of type '${type}' has unsupported message role '${String(role)}'.`,
    });
  }
  const uuid = record.uuid;
  const timestamp = record.timestamp;
  if (typeof uuid !== "string" || typeof timestamp !== "string") {
    return yield* new ClaudeTranscriptParseError({
      sessionId,
      line,
      detail: `Entry of type '${type}' is missing uuid or timestamp.`,
    });
  }
  const { text, hasText } = extractTextContent((message as { content?: unknown }).content);
  const model = (message as { model?: unknown }).model;
  return {
    uuid,
    parentUuid: typeof record.parentUuid === "string" ? record.parentUuid : null,
    role,
    text,
    timestamp,
    model: typeof model === "string" ? model : null,
    hasTextContent: hasText,
  } satisfies ChainEntry;
});

/**
 * Parse a full Claude session transcript into ordered user/assistant text
 * messages, following the active `parentUuid` ancestry chain from the last
 * main-chain entry so branches abandoned by rewinds/edits are excluded.
 */
export const parseClaudeTranscript = Effect.fn("parseClaudeTranscript")(function* (input: {
  readonly sessionId: string;
  readonly lines: ReadonlyArray<string>;
}) {
  // Ancestry linkage spans EVERY record kind: benign records (attachments,
  // mode changes, …) carry uuid/parentUuid and sit between messages in the
  // chain, so parent links are tracked for all records while only
  // user/assistant records contribute messages.
  const parentByUuid = new Map<string, string | null>();
  const messagesByUuid = new Map<string, ChainEntry>();
  let activeLeaf: ChainEntry | undefined;

  for (let index = 0; index < input.lines.length; index += 1) {
    const raw = input.lines[index]?.trim();
    if (!raw) continue;
    const lineNumber = index + 1;
    const record: unknown = yield* decodeJsonLine(raw).pipe(
      Effect.mapError(
        () =>
          new ClaudeTranscriptParseError({
            sessionId: input.sessionId,
            line: lineNumber,
            detail: "Line is not valid JSON.",
          }),
      ),
    );
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      return yield* new ClaudeTranscriptParseError({
        sessionId: input.sessionId,
        line: lineNumber,
        detail: "Line is not a JSON object.",
      });
    }
    const objectRecord = record as Record<string, unknown>;
    const type = objectRecord.type;
    if (typeof type !== "string") {
      return yield* new ClaudeTranscriptParseError({
        sessionId: input.sessionId,
        line: lineNumber,
        detail: "Record has no string 'type' field.",
      });
    }
    if (typeof objectRecord.uuid === "string") {
      parentByUuid.set(
        objectRecord.uuid,
        typeof objectRecord.parentUuid === "string" ? objectRecord.parentUuid : null,
      );
    }
    if (type === "user" || type === "assistant") {
      const parsed = yield* parseChainEntry(objectRecord, lineNumber, input.sessionId);
      if (parsed !== undefined) {
        messagesByUuid.set(parsed.uuid, parsed);
        activeLeaf = parsed;
      }
      continue;
    }
    if (BENIGN_RECORD_TYPES.has(type)) {
      continue;
    }
    return yield* new ClaudeTranscriptParseError({
      sessionId: input.sessionId,
      line: lineNumber,
      detail: `Unrecognized record type '${type}'. The Claude session format may have changed; update the import parser.`,
    });
  }

  // Walk the active ancestry chain from the leaf back to the root, passing
  // through non-message records, collecting the message entries on the way.
  const chain: Array<ChainEntry> = [];
  const seen = new Set<string>();
  let cursorUuid: string | null | undefined = activeLeaf?.uuid;
  while (cursorUuid !== null && cursorUuid !== undefined && !seen.has(cursorUuid)) {
    seen.add(cursorUuid);
    const message = messagesByUuid.get(cursorUuid);
    if (message !== undefined) {
      chain.push(message);
    }
    cursorUuid = parentByUuid.get(cursorUuid);
  }
  chain.reverse();

  let model: string | null = null;
  const messages: Array<ClaudeTranscriptMessage> = [];
  for (const entry of chain) {
    if (
      entry.role === "assistant" &&
      entry.model !== null &&
      entry.model !== SYNTHETIC_MODEL_SENTINEL
    ) {
      model = entry.model;
    }
    // Entries whose content is exclusively tool_use/tool_result blocks carry
    // no conversational text and are omitted from the imported transcript.
    if (!entry.hasTextContent || entry.text.trim().length === 0) {
      continue;
    }
    messages.push({
      role: entry.role,
      text: entry.text,
      createdAt: entry.timestamp,
    });
  }

  return {
    sessionId: input.sessionId,
    messages,
    model,
    lastTimestamp: activeLeaf?.timestamp ?? null,
  } satisfies ClaudeParsedTranscript;
});

/**
 * Directory name Claude Code uses for a project's sessions: the canonical
 * cwd with every non-alphanumeric character replaced by `-`.
 */
export function claudeProjectDirectoryName(canonicalCwd: string): string {
  return canonicalCwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export class ClaudeSessionImportIoError extends Schema.TaggedErrorClass<ClaudeSessionImportIoError>()(
  "ClaudeSessionImportIoError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const SESSION_ID_PATTERN_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_ID_PATTERN = new RegExp(`^${SESSION_ID_PATTERN_SOURCE}$`);
const SESSION_FILE_PATTERN = new RegExp(`^(${SESSION_ID_PATTERN_SOURCE})\\.jsonl$`);
const MAX_SESSION_FILE_BYTES = 256 * 1024 * 1024;
const PREVIEW_MAX_CHARS = 120;

export interface ClaudeImportableSessionSummary {
  readonly sessionId: string;
  readonly preview: string;
  readonly messageCount: number;
  readonly updatedAt: string;
}

function sessionsDirectory(path: Path.Path, homePath: string, canonicalCwd: string) {
  return path.join(homePath, ".claude", "projects", claudeProjectDirectoryName(canonicalCwd));
}

const readTranscriptLines = Effect.fn("readTranscriptLines")(function* (input: {
  readonly filePath: string;
  readonly sessionId: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(input.filePath).pipe(
    Effect.mapError(
      (cause) =>
        new ClaudeSessionImportIoError({
          detail: `Failed to stat Claude session file '${input.filePath}'.`,
          cause,
        }),
    ),
  );
  if (info.size > MAX_SESSION_FILE_BYTES) {
    return yield* new ClaudeSessionImportIoError({
      detail: `Claude session file '${input.filePath}' exceeds the ${MAX_SESSION_FILE_BYTES} byte import limit.`,
    });
  }
  const content = yield* fileSystem.readFileString(input.filePath).pipe(
    Effect.mapError(
      (cause) =>
        new ClaudeSessionImportIoError({
          detail: `Failed to read Claude session file '${input.filePath}'.`,
          cause,
        }),
    ),
  );
  return content.split("\n");
});

/**
 * Parse one persisted Claude session by id from a project's session home.
 */
export const readClaudeSessionTranscript = Effect.fn("readClaudeSessionTranscript")(
  function* (input: {
    readonly homePath: string;
    readonly canonicalCwd: string;
    readonly sessionId: string;
  }) {
    if (!SESSION_ID_PATTERN.test(input.sessionId)) {
      return yield* new ClaudeSessionImportIoError({
        detail: `Claude session id '${input.sessionId}' is not a valid persisted session UUID.`,
      });
    }
    const path = yield* Path.Path;
    const filePath = path.join(
      sessionsDirectory(path, input.homePath, input.canonicalCwd),
      `${input.sessionId}.jsonl`,
    );
    const lines = yield* readTranscriptLines({ filePath, sessionId: input.sessionId });
    return yield* parseClaudeTranscript({ sessionId: input.sessionId, lines });
  },
);

/**
 * List persisted Claude sessions for a workspace root. Parsing is strict on
 * purpose: one undecodable session file fails the listing so format drift is
 * announced instead of sessions silently disappearing from the picker.
 */
export const listClaudeSessionTranscripts = Effect.fn("listClaudeSessionTranscripts")(
  function* (input: { readonly homePath: string; readonly canonicalCwd: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = sessionsDirectory(path, input.homePath, input.canonicalCwd);
    const directoryExists = yield* fileSystem.exists(directory).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeSessionImportIoError({
            detail: `Failed to check the Claude sessions directory '${directory}'.`,
            cause,
          }),
      ),
    );
    if (!directoryExists) {
      return [] as ReadonlyArray<ClaudeImportableSessionSummary>;
    }
    const entries = yield* fileSystem.readDirectory(directory).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeSessionImportIoError({
            detail: `Failed to read the Claude sessions directory '${directory}'.`,
            cause,
          }),
      ),
    );
    const summaries: Array<ClaudeImportableSessionSummary> = [];
    for (const entry of entries) {
      const match = SESSION_FILE_PATTERN.exec(entry);
      if (match === null) continue;
      const sessionId = match[1]!;
      const transcript = yield* readClaudeSessionTranscript({
        homePath: input.homePath,
        canonicalCwd: input.canonicalCwd,
        sessionId,
      });
      if (transcript.messages.length === 0) continue;
      const firstUserText = transcript.messages.find((message) => message.role === "user")?.text;
      summaries.push({
        sessionId,
        preview: (firstUserText ?? transcript.messages[0]!.text).slice(0, PREVIEW_MAX_CHARS),
        messageCount: transcript.messages.length,
        updatedAt: transcript.lastTimestamp ?? transcript.messages.at(-1)!.createdAt,
      });
    }
    summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return summaries as ReadonlyArray<ClaudeImportableSessionSummary>;
  },
);
