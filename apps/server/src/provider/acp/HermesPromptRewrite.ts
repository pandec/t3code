/**
 * HermesPromptRewrite — turn composer `$skill` tokens into the `/skill` form
 * Hermes understands, in the outgoing prompt only.
 *
 * Hermes indexes every skill in its system prompt and loads one on demand via
 * `skill_view(name)`, so a reference resolves semantically rather than by
 * position: its ACP adapter does not dispatch skill slash-commands at all, and
 * an unrecognised `/name` simply reaches the model as text. Position therefore
 * carries no meaning, and a reference mid-sentence is just as actionable as
 * one that leads the message.
 *
 * Two rules, kept separate on purpose:
 *
 *  - A token at the very start is rewritten unconditionally. That has always
 *    been the behaviour, and it also covers Hermes' built-in ACP commands
 *    (`/help`, `/model`, …), which are not skills and so are absent from the
 *    known-skill set.
 *  - A token anywhere else is rewritten only when it names a known skill.
 *    Without that check `$PATH`, `$HOME`, or a shell snippet in ordinary prose
 *    would be mangled into `/PATH`, `/HOME`, …
 *
 * @module provider/acp/HermesPromptRewrite
 */
import { collectComposerSkillTokens } from "@t3tools/shared/composerInlineTokens";

const LEADING_SKILL = /^\s*\$([a-zA-Z][\w:-]*)(?=\s|$)/u;

function rewriteLeadingSkillToken(input: string): string {
  const match = LEADING_SKILL.exec(input);
  if (!match) {
    return input;
  }
  const skillName = match[1];
  if (!skillName) {
    return input;
  }
  return `/${skillName}${input.slice(match[0].length)}`;
}

function rewriteKnownSkillTokens(input: string, knownSkillNames: ReadonlySet<string>): string {
  let rewritten = "";
  let cursor = 0;
  for (const token of collectComposerSkillTokens(input)) {
    if (token.start < cursor || !knownSkillNames.has(token.value.toLowerCase())) {
      continue;
    }
    rewritten += input.slice(cursor, token.start);
    rewritten += `/${token.value}`;
    cursor = token.end;
  }

  return cursor === 0 ? input : rewritten + input.slice(cursor);
}

/**
 * Rewrite `$skill` references for Hermes.
 *
 * `knownSkillNames` holds the lowercased command names of the enabled skills
 * reported by the workspace's snapshot. Omit it — or pass an empty set — when
 * the snapshot could not be read, and only the leading token is rewritten,
 * exactly as before.
 */
export function rewriteHermesPrompt(input: string, knownSkillNames?: ReadonlySet<string>): string {
  // Runs first, so the leading token is already `/name` by the time the
  // known-skill pass looks at the text and cannot be rewritten twice.
  const withLeadingRewrite = rewriteLeadingSkillToken(input);
  if (knownSkillNames === undefined || knownSkillNames.size === 0) {
    return withLeadingRewrite;
  }
  return rewriteKnownSkillTokens(withLeadingRewrite, knownSkillNames);
}
