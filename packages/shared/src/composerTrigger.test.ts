import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  parseComposerArchiveCommand,
  applyThreadStatusEmoji,
  buildThreadTitleComposerText,
  formatForkedThreadTitle,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
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

describe("buildThreadTitleComposerText", () => {
  it("prefills /t3-name with the current title", () => {
    expect(buildThreadTitleComposerText("t3-name", "  Current title  ")).toBe(
      "/t3-name Current title",
    );
  });

  it("leaves /t3-rename empty for a replacement title", () => {
    expect(buildThreadTitleComposerText("t3-rename", "Current title")).toBe("/t3-rename ");
  });

  it("leaves /t3-name empty when the current title is blank", () => {
    expect(buildThreadTitleComposerText("t3-name", "  ")).toBe("/t3-name ");
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

describe("applyThreadStatusEmoji", () => {
  it("keeps current and legacy fork markers when setting status", () => {
    expect(applyThreadStatusEmoji("(🔱) Source", "💡")).toBe("💡 (🔱) Source");
    expect(applyThreadStatusEmoji("🔱 Source", "💡")).toBe("💡 (🔱) Source");
  });

  it("normalizes a legacy fork marker that follows the replaced status emoji", () => {
    expect(applyThreadStatusEmoji("💡 🔱 Source", "🎯")).toBe("🎯 (🔱) Source");
  });
});

describe("parseComposerArchiveCommand", () => {
  it.each(["/t3-archive", "  /T3-ARCHIVE \n"])("schedules %s", (text) => {
    expect(parseComposerArchiveCommand(text)).toEqual({ action: "schedule" });
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
