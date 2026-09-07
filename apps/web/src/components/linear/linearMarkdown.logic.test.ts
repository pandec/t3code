import { describe, expect, it } from "vite-plus/test";

import type { MarkdownNode } from "~/vendor/mdast-find-and-replace";
import { remarkLinearAutolinks } from "./linearMarkdown.logic";

function paragraph(...children: MarkdownNode[]): MarkdownNode {
  return { type: "root", children: [{ type: "paragraph", children }] };
}

function text(value: string): MarkdownNode {
  return { type: "text", value };
}

function run(tree: MarkdownNode, teamKeys: ReadonlyArray<string>) {
  remarkLinearAutolinks({ teamKeys })(tree);
  return tree.children![0]!.children!;
}

function linkUrls(nodes: ReadonlyArray<MarkdownNode>) {
  return nodes.filter((node) => node.type === "link").map((node) => node.url);
}

describe("remarkLinearAutolinks", () => {
  it("links identifiers for configured team keys only", () => {
    const nodes = run(paragraph(text("See SP-123 and ISO-8601, also OP-7.")), ["SP", "OP"]);
    expect(nodes).toEqual([
      text("See "),
      {
        type: "link",
        url: "https://linear.app/issue/SP-123",
        data: { hProperties: { dataLinearAutolink: "reference" } },
        children: [text("SP-123")],
      },
      text(" and ISO-8601, also "),
      {
        type: "link",
        url: "https://linear.app/issue/OP-7",
        data: { hProperties: { dataLinearAutolink: "reference" } },
        children: [text("OP-7")],
      },
      text("."),
    ]);
  });

  it("is word-boundary safe on both sides", () => {
    const nodes = run(
      paragraph(
        text(
          "feat/SP-12-slug #SP-12 SP-12a XSP-12 SP-0 SP-12345678 SP-13-fix-login SP-14/notes (SP-9) SP-15.",
        ),
      ),
      ["SP"],
    );
    expect(linkUrls(nodes)).toEqual([
      "https://linear.app/issue/SP-9",
      "https://linear.app/issue/SP-15",
    ]);
  });

  it("matches the longer of two keys that share a prefix", () => {
    const nodes = run(paragraph(text("SPX-1 and SP-2")), ["SP", "SPX"]);
    expect(linkUrls(nodes)).toEqual([
      "https://linear.app/issue/SPX-1",
      "https://linear.app/issue/SP-2",
    ]);
  });

  it("skips code and authored links", () => {
    const tree = paragraph(
      { type: "inlineCode", value: "SP-1" },
      { type: "link", url: "https://example.com", children: [text("SP-2")] },
      text(" SP-3"),
    );
    const nodes = run(tree, ["SP"]);
    expect(nodes[0]).toEqual({ type: "inlineCode", value: "SP-1" });
    expect(nodes[1]!.children).toEqual([text("SP-2")]);
    expect(nodes[3]!.type).toBe("link");
  });

  it("does nothing without team keys", () => {
    expect(run(paragraph(text("SP-1")), [])).toEqual([text("SP-1")]);
  });
});
