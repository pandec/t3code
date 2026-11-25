import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import type { Nodes } from "hast";

import { markdownTree } from "~/markdown/wordsHast";

// Elements whose children run together; every other element is separated by a space.
const INLINE_PARENTS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "td",
  "th",
  "em",
  "strong",
  "del",
  "a",
  "code",
  "span",
  "sup",
  "sub",
]);

function markdownNodeText(node: Nodes): string {
  if (node.type === "text") return node.value;
  if (node.type === "element" && node.tagName === "br") return " ";
  if (node.type === "element" && node.tagName === "img") return String(node.properties.alt ?? "");
  if (node.type !== "element" && node.type !== "root") return "";
  const separator = node.type === "element" && INLINE_PARENTS.has(node.tagName) ? "" : " ";
  const text = node.children.map(markdownNodeText).join(separator);
  // A thread autolink's only text is its URL.
  return node.type === "element" && node.tagName === "a" && parseThreadLinkHref(text) !== null
    ? "a thread"
    : text;
}

/** Markdown as one line of the text it renders, without markup or link targets. */
export function markdownPlainText(markdown: string): string {
  return markdownNodeText(markdownTree(markdown)).replace(/\s+/g, " ").trim();
}
