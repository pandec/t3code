import { describe, expect, it } from "vite-plus/test";

import { rewriteHermesPrompt } from "./HermesPromptRewrite.ts";

describe("rewriteHermesPrompt", () => {
  it.each([
    ["$review", "/review"],
    ["  $review src/app.ts", "/review src/app.ts"],
    ["\n\t$code:review --fast", "/code:review --fast"],
    ["$name:with-colons argument", "/name:with-colons argument"],
    ["$skill-name\nkeep this", "/skill-name\nkeep this"],
    [" \r\n$multi-line\r\nkeep this", "/multi-line\r\nkeep this"],
  ])("rewrites a leading skill token at byte zero", (input, expected) => {
    expect(rewriteHermesPrompt(input)).toBe(expected);
  });

  it.each([
    ["please use $review", "please use $review"],
    ["plain text", "plain text"],
    ["$1invalid argument", "$1invalid argument"],
    ["$$double", "$$double"],
    ["$", "$"],
    [" \n\t", " \n\t"],
  ])("without a known-skill set, leaves non-leading input unchanged", (input, expected) => {
    expect(rewriteHermesPrompt(input)).toBe(expected);
  });

  describe("with a known-skill set", () => {
    const knownSkills = new Set(["review", "dotfiles-sync", "code:review", "apple-notes"]);

    it("rewrites a reference mid-sentence", () => {
      expect(rewriteHermesPrompt("please use $review on this", knownSkills)).toBe(
        "please use /review on this",
      );
    });

    it("rewrites a reference that ends the message", () => {
      expect(rewriteHermesPrompt("then run $dotfiles-sync", knownSkills)).toBe(
        "then run /dotfiles-sync",
      );
    });

    it("rewrites every known reference in one message", () => {
      expect(rewriteHermesPrompt("$review then $apple-notes please", knownSkills)).toBe(
        "/review then /apple-notes please",
      );
    });

    it("matches names case-insensitively", () => {
      expect(rewriteHermesPrompt("use $Review here", knownSkills)).toBe("use /Review here");
    });

    it("leaves shell variables and unknown names alone", () => {
      // The whole point of gating on the snapshot: ordinary prose must survive.
      expect(rewriteHermesPrompt("echo $PATH and $HOME now", knownSkills)).toBe(
        "echo $PATH and $HOME now",
      );
      expect(rewriteHermesPrompt("mention $not-a-skill here", knownSkills)).toBe(
        "mention $not-a-skill here",
      );
    });

    it("does not rewrite a reference nested in a file mention", () => {
      // A file link's label carries the basename, so `$review` inside it is
      // part of the user's path, not a skill reference.
      const input = "see [my $review notes.md](docs/my%20$review%20notes.md) ok";
      expect(rewriteHermesPrompt(input, knownSkills)).toBe(input);
    });

    it("still rewrites a leading token that is not a known skill", () => {
      // Hermes' built-in ACP commands are not skills, and a leading token has
      // always been rewritten unconditionally.
      expect(rewriteHermesPrompt("$help me", knownSkills)).toBe("/help me");
    });

    it("does not rewrite the leading token twice", () => {
      expect(rewriteHermesPrompt("$review the code", knownSkills)).toBe("/review the code");
    });

    it("treats an empty set as an unavailable snapshot", () => {
      expect(rewriteHermesPrompt("please use $review", new Set())).toBe("please use $review");
    });
  });
});
