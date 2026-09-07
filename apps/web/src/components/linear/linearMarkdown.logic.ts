import { LINEAR_ISSUE_NUMBER_SOURCE } from "@t3tools/contracts";

import {
  findAndReplaceText,
  type MarkdownNode,
  type TextMatch,
} from "~/vendor/mdast-find-and-replace";

/**
 * Characters that, adjacent to a candidate, make it part of a path, tag, slug, or word. The
 * trailing set includes `-` and `/` so `SP-123-fix-login` and `SP-123/notes` stay prose.
 */
const AUTOLINK_BEFORE_PATTERN = /[\w/#-]/u;
const AUTOLINK_AFTER_PATTERN = /[\w/-]/u;
const AUTOLINK_IGNORED_TYPES = new Set(["link", "linkReference", "inlineCode", "code"]);

/** The workspace-less form Linear redirects; the panel opens it without a status read. */
export function linearIssueUrl(identifier: string): string {
  return `https://linear.app/issue/${identifier}`;
}

/**
 * Bare `SP-123` references in prose become Linear issue links, but only for the team keys the
 * user listed, so `ISO-8601` or `RFC-2616` never match. Never inside code or authored links.
 */
export function remarkLinearAutolinks(options: { readonly teamKeys: ReadonlyArray<string> }) {
  if (options.teamKeys.length === 0) return () => {};
  const keys = [...options.teamKeys].sort((a, b) => b.length - a.length).join("|");
  const pattern = new RegExp(`\\b(?:${keys})-${LINEAR_ISSUE_NUMBER_SOURCE}\\b`, "gu");
  return (tree: MarkdownNode) => {
    findAndReplaceText(
      tree,
      pattern,
      (matched: string, match: TextMatch) => {
        const before = match.input[match.index - 1];
        const after = match.input[match.index + matched.length];
        if (
          (before !== undefined && AUTOLINK_BEFORE_PATTERN.test(before)) ||
          (after !== undefined && AUTOLINK_AFTER_PATTERN.test(after))
        ) {
          return false;
        }
        return {
          type: "link",
          url: linearIssueUrl(matched),
          data: { hProperties: { dataLinearAutolink: "reference" } },
          children: [{ type: "text", value: matched }],
        };
      },
      AUTOLINK_IGNORED_TYPES,
    );
  };
}
