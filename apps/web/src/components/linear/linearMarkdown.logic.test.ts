import type { ElementContent, Properties, Root, RootContent } from "hast";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast } from "~/markdown/wordsHast";
import { linearAutolinkText } from "./linearMarkdown.logic";

const text = (value: string): ElementContent => ({ type: "text", value });

function linkUrls(nodes: ReadonlyArray<ElementContent> | null) {
  return (nodes ?? []).flatMap((node) =>
    node.type === "element" && node.tagName === "a" ? [node.properties.href] : [],
  );
}

describe("linearAutolinkText", () => {
  it("links identifiers for configured team keys only", () => {
    expect(linearAutolinkText("See SP-123 and ISO-8601, also OP-7.", ["SP", "OP"])).toEqual([
      text("See "),
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://linear.app/issue/SP-123", dataLinearAutolink: "reference" },
        children: [text("SP-123")],
      },
      text(" and ISO-8601, also "),
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://linear.app/issue/OP-7", dataLinearAutolink: "reference" },
        children: [text("OP-7")],
      },
      text("."),
    ]);
  });

  it("is word-boundary safe on both sides", () => {
    const nodes = linearAutolinkText(
      "feat/SP-12-slug #SP-12 SP-12a XSP-12 SP-0 SP-12345678 SP-13-fix-login SP-14/notes (SP-9) SP-15.",
      ["SP"],
    );
    expect(linkUrls(nodes)).toEqual([
      "https://linear.app/issue/SP-9",
      "https://linear.app/issue/SP-15",
    ]);
  });

  it("matches the longer of two keys that share a prefix", () => {
    expect(linkUrls(linearAutolinkText("SPX-1 and SP-2", ["SP", "SPX"]))).toEqual([
      "https://linear.app/issue/SPX-1",
      "https://linear.app/issue/SP-2",
    ]);
  });

  it("does nothing without team keys or matches", () => {
    expect(linearAutolinkText("SP-1", [])).toBeNull();
    expect(linearAutolinkText("ISO-8601", ["SP"])).toBeNull();
  });

  it("links prose in chat Markdown but skips code and authored links", () => {
    const tree = wordsHast("`SP-1` [SP-2](https://example.com) SP-3", {
      math: false,
      breaks: false,
      escapeHtml: false,
      insights: false,
      extensions: { linearTeamKeys: ["SP"] },
    });
    const anchors: Properties[] = [];
    const visit = (node: Root | RootContent) => {
      if (node.type === "element" && node.tagName === "a") anchors.push(node.properties);
      if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
    expect(anchors).toEqual([
      expect.objectContaining({ href: "https://example.com" }),
      expect.objectContaining({
        href: "https://linear.app/issue/SP-3",
        dataLinearAutolink: "reference",
      }),
    ]);
  });
});
