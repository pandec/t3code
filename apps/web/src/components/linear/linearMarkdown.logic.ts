import { LINEAR_ISSUE_NUMBER_SOURCE } from "@t3tools/contracts";
import type { ElementContent } from "hast";

/**
 * Characters that, adjacent to a candidate, make it part of a path, tag, slug, or word. The
 * trailing set includes `-` and `/` so `SP-123-fix-login` and `SP-123/notes` stay prose.
 */
const AUTOLINK_BEFORE_PATTERN = /[\w/#-]/u;
const AUTOLINK_AFTER_PATTERN = /[\w/-]/u;

/** The workspace-less form Linear redirects; the panel opens it without a status read. */
export function linearIssueUrl(identifier: string): string {
  return `https://linear.app/issue/${identifier}`;
}

const patterns = new WeakMap<ReadonlyArray<string>, RegExp>();

function teamKeyPattern(teamKeys: ReadonlyArray<string>): RegExp {
  let pattern = patterns.get(teamKeys);
  if (!pattern) {
    const keys = [...teamKeys].sort((a, b) => b.length - a.length).join("|");
    pattern = new RegExp(`\\b(?:${keys})-${LINEAR_ISSUE_NUMBER_SOURCE}\\b`, "gu");
    patterns.set(teamKeys, pattern);
  }
  return pattern;
}

/**
 * Bare `SP-123` references in a prose text node become Linear issue links, but only for the team
 * keys the user listed, so `ISO-8601` or `RFC-2616` never match. Callers skip code and links.
 * Returns null when nothing links.
 */
export function linearAutolinkText(
  value: string,
  teamKeys: ReadonlyArray<string>,
): ElementContent[] | null {
  if (teamKeys.length === 0) return null;
  const parts: ElementContent[] = [];
  let offset = 0;
  for (const match of value.matchAll(teamKeyPattern(teamKeys))) {
    const [matched] = match;
    const before = value[match.index - 1];
    const after = value[match.index + matched.length];
    if (
      (before !== undefined && AUTOLINK_BEFORE_PATTERN.test(before)) ||
      (after !== undefined && AUTOLINK_AFTER_PATTERN.test(after))
    ) {
      continue;
    }
    if (match.index > offset) parts.push({ type: "text", value: value.slice(offset, match.index) });
    parts.push({
      type: "element",
      tagName: "a",
      properties: { href: linearIssueUrl(matched), dataLinearAutolink: "reference" },
      children: [{ type: "text", value: matched }],
    });
    offset = match.index + matched.length;
  }
  if (offset === 0) return null;
  if (offset < value.length) parts.push({ type: "text", value: value.slice(offset) });
  return parts;
}
