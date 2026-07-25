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
  ])("leaves non-leading skill input unchanged", (input, expected) => {
    expect(rewriteHermesPrompt(input)).toBe(expected);
  });
});
