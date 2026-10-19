import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  parseComposerArchiveCommand,
  formatForkedThreadTitle,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it.each([
    ["Run /tmp/build.sh", "Run /tmp/build.sh".length],
    ["/etc/hosts", "/etc/hosts".length],
    ["Use /etc/hosts now", "Use /et".length],
  ])("keeps the path in %j out of the slash menu", (text, cursor) => {
    expect(detectComposerTrigger(text, cursor)).toBeNull();
  });

  it("keeps a slash in the line-leading model picker query", () => {
    expect(detectComposerTrigger("/model openai/gpt", 17)).toMatchObject({
      kind: "slash-model",
      query: "openai/gpt",
    });
  });

  it.each(["Use ", "Use\t", "Use\n  "])("detects inline slash skills after %j", (prefix) => {
    const text = `${prefix}/skill:review later`;
    const cursor = `${prefix}/skill:review`.length;
    expect(detectComposerTrigger(text, cursor)).toEqual({
      kind: "slash-command",
      query: "skill:review",
      rangeStart: prefix.length,
      rangeEnd: cursor,
    });
  });

  it.each(["Use /", "Use /review"])("detects the inline slash token in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: text.slice(5),
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %s skill prefixes and their source range",
    (prefix) => {
      const text = `Use ${prefix}review`;
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "skill",
        query: "review",
        rangeStart: 4,
        rangeEnd: text.length,
      });
    },
  );
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("formatForkedThreadTitle", () => {
  it("adds the parenthesized fork marker before an unstyled title", () => {
    expect(formatForkedThreadTitle("Source")).toBe("(🔱) Source");
  });

  it("places the fork marker after a leading status emoji", () => {
    expect(formatForkedThreadTitle("💡 Source")).toBe("💡 (🔱) Source");
    expect(formatForkedThreadTitle("👍🏽 Source")).toBe("👍🏽 (🔱) Source");
  });

  it("does not stack an existing fork marker", () => {
    expect(formatForkedThreadTitle("(🔱) Source")).toBe("(🔱) Source");
    expect(formatForkedThreadTitle("💡 (🔱) Source")).toBe("💡 (🔱) Source");
  });

  it("normalizes the legacy fork prefix", () => {
    expect(formatForkedThreadTitle("🔱 Source")).toBe("(🔱) Source");
    expect(formatForkedThreadTitle("💡 🔱 Source")).toBe("💡 (🔱) Source");
  });
});

describe("parseComposerArchiveCommand", () => {
  it.each(["/t3-archive", "  /T3-ARCHIVE \n"])("toggles %s", (text) => {
    expect(parseComposerArchiveCommand(text)).toEqual({ action: "toggle" });
  });

  it("accepts cancellation and rejects unsupported arguments", () => {
    expect(parseComposerArchiveCommand(" /t3-archive CANCEL ")).toEqual({ action: "cancel" });
    expect(parseComposerArchiveCommand("/t3-archive now")).toEqual({ action: null });
    expect(parseComposerArchiveCommand("/t3-archive cancel extra")).toEqual({ action: null });
  });

  it.each(["Discuss /t3-archive", "/t3-archivex", "/archive", "/t3-archive/cancel"])(
    "leaves ordinary prompt %s alone",
    (text) => expect(parseComposerArchiveCommand(text)).toBeNull(),
  );
});
