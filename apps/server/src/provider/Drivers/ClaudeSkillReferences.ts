/**
 * ClaudeSkillReferences — turn `$skill` composer tokens into something Claude
 * can act on when the skill is user-invocable only.
 *
 * A skill whose frontmatter sets `disable-model-invocation: true` never reaches
 * Claude's skill tool, so a bare `$name` in the prompt is just text the model
 * cannot act on. Claude Code will only parse `/name` as a command at the very
 * start of a message, which rules out referencing such a skill mid-sentence —
 * the whole point of the `$` picker.
 *
 * So the outgoing prompt (never the stored message) rewrites those tokens to
 * `/name [Read: /abs/path/SKILL.md]`: the slash form carries the user's intent
 * and the pointer lets the model load the instructions itself. Only the
 * pointer is passed, not the file's contents — an unused reference then costs
 * nothing.
 *
 * Skills the model can already invoke are left untouched; rewriting those
 * would push the model toward reading files instead of using its skill tool.
 *
 * @module provider/Drivers/ClaudeSkillReferences
 */
import {
  type ComposerInlineToken,
  collectComposerInlineTokens,
} from "@t3tools/shared/composerInlineTokens";

const UNREPRESENTABLE_POINTER_PATH_PATTERN = /[\]\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Keep the pointer on one unambiguous line and inside its closing bracket.
 * Escaping would no longer name the literal filesystem path, so an unsafe path
 * declines the rewrite instead.
 */
function isRepresentablePointerPath(path: string): boolean {
  return path.length > 0 && !UNREPRESENTABLE_POINTER_PATH_PATTERN.test(path);
}

/**
 * The composer's token pattern requires trailing whitespace, so a reference
 * that ends the message only matches once a newline follows it. Offsets stay
 * valid for the original text because a token never extends into the suffix.
 *
 * A `$name` can also sit inside an `@mention`'s label — a file link for
 * `my $review notes.md` serialises to `[my $review notes.md](...)`, whose
 * label matches the skill pattern. The composer renders that whole span as
 * one file chip, so the earliest token claims its span and any reference
 * nested inside it is ignored, mirroring how the editor splits the same text
 * into segments. Rewriting there would corrupt the user's path.
 */
function collectSkillTokens(text: string): ReadonlyArray<ComposerInlineToken> {
  const tokens = [...collectComposerInlineTokens(`${text}\n`)].sort(
    (left, right) => left.start - right.start,
  );

  const skillTokens: ComposerInlineToken[] = [];
  let claimedUntil = 0;
  for (const token of tokens) {
    if (token.start < claimedUntil) {
      continue;
    }
    claimedUntil = token.end;
    if (token.type === "skill") {
      skillTokens.push(token);
    }
  }
  return skillTokens;
}

/** Lowercased names of every `$skill` reference in the text. */
export function collectClaudeSkillReferenceNames(text: string): ReadonlySet<string> {
  return new Set(collectSkillTokens(text).map((token) => token.value.toLowerCase()));
}

/**
 * Rewrite `$name` to `/name [Read: <path>]` for every reference the resolver
 * supplies a path for. References the resolver declines are left exactly as
 * the user typed them.
 */
export function applyClaudeSkillReferencePointers(
  text: string,
  resolveSkillPath: (name: string) => string | undefined,
): string {
  const tokens = collectSkillTokens(text);
  if (tokens.length === 0) {
    return text;
  }

  let rewritten = "";
  let cursor = 0;
  for (const token of tokens) {
    // Collection already drops overlaps; this only keeps a future regression
    // from splicing the same span twice and duplicating the user's text.
    if (token.start < cursor) {
      continue;
    }
    const skillPath = resolveSkillPath(token.value);
    if (skillPath === undefined || !isRepresentablePointerPath(skillPath)) {
      continue;
    }
    rewritten += text.slice(cursor, token.start);
    rewritten += `/${token.value} [Read: ${skillPath}]`;
    cursor = token.end;
  }

  return cursor === 0 ? text : rewritten + text.slice(cursor);
}
