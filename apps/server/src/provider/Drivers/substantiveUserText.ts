/**
 * `<command-*>` blocks the CLI wraps a slash command invocation in. They are
 * matched individually rather than as one fixed sequence because the tag order
 * and the set of tags present both vary between CLI versions.
 */
const COMMAND_WRAPPER_BLOCK_PATTERN = /<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g;
const COMMAND_ARGS_BLOCK_PATTERN = /<command-args>([\s\S]*?)<\/command-args>/g;

/**
 * A lone slash command, optionally with arguments. The command name may not
 * contain a slash, so multi-segment absolute paths such as `/Users/x/y` read as
 * prose. A single-segment opener such as `/tmp is full, clean it up` still
 * matches and is treated as a command.
 */
const SLASH_COMMAND_ONLY_PATTERN = /^\/[A-Za-z][\w:-]*(?:[ \t]+[^\r\n]*)?$/;

/** Extract visible conversation text from a user message wrapped as a CLI command. */
export function extractSubstantiveUserText(text: string): string | null {
  const commandArgs = [...text.matchAll(COMMAND_ARGS_BLOCK_PATTERN)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => value.length > 0);
  const remainder = text.replace(COMMAND_WRAPPER_BLOCK_PATTERN, "").trim();
  const combined = [remainder, ...commandArgs]
    .filter((value) => value.length > 0)
    .join(" ")
    .trim();
  return combined.length === 0 || SLASH_COMMAND_ONLY_PATTERN.test(combined) ? null : combined;
}
