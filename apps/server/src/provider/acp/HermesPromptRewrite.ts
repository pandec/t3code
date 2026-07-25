const LEADING_SKILL = /^\s*\$([a-zA-Z][\w:-]*)(?=\s|$)/u;

export function rewriteHermesPrompt(input: string): string {
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
