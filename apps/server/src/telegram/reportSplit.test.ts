import { describe, expect, it } from "vite-plus/test";

import { splitTelegramReport } from "./reportSplit.ts";

describe("splitTelegramReport", () => {
  it("keeps a report that fits as one part without a footer", () => {
    expect(splitTelegramReport("# Title\n\nBody.\n")).toEqual(["# Title\n\nBody."]);
  });

  it("splits at the last heading within the limit and numbers the parts", () => {
    const section = (name: string) => `## ${name}\n\n${"word ".repeat(30).trim()}\n`;
    const report = [section("One"), section("Two"), section("Three")].join("\n");
    const parts = splitTelegramReport(report, 300);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((part, index) => {
      expect(part.endsWith(`_(${index + 1}/${parts.length})_`)).toBe(true);
    });
    expect(parts[1]!.startsWith("## ")).toBe(true);
    // Nothing is lost apart from the footers and the whitespace at the cuts.
    const rejoined = parts.map((part) => part.replace(/\n\n_\(\d+\/\d+\)_$/, "")).join("");
    expect(rejoined.replace(/\s+/g, "")).toEqual(report.replace(/\s+/g, ""));
  });

  it("does not cut inside a code fence when a boundary outside it exists", () => {
    const fence = ["```ts", ...Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`), "```"];
    const report = ["Intro paragraph.", "", ...fence, "", "Outro."].join("\n");
    const parts = splitTelegramReport(report, report.length - 10);
    expect(parts[0]!.startsWith("Intro paragraph.")).toBe(true);
    expect(parts[0]).not.toContain("```");
    expect(parts[1]!.startsWith("```ts")).toBe(true);
  });
});
