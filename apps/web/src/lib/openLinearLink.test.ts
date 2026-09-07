import { describe, expect, it } from "vite-plus/test";

import { parseLinearIssueUrl } from "./openLinearLink";

describe("parseLinearIssueUrl", () => {
  it("accepts issue urls with optional slug, query, and hash", () => {
    expect(parseLinearIssueUrl("https://linear.app/acme/issue/SP-123")).toEqual({
      identifier: "SP-123",
    });
    expect(parseLinearIssueUrl("https://linear.app/acme/issue/SP-123/fix-login?x=1#c")).toEqual({
      identifier: "SP-123",
    });
    expect(parseLinearIssueUrl("https://LINEAR.APP/acme/issue/sp-7/")).toEqual({
      identifier: "SP-7",
    });
  });

  it("accepts the workspace-less form the autolinker writes before the workspace is known", () => {
    expect(parseLinearIssueUrl("https://linear.app/issue/ENG-1")).toEqual({ identifier: "ENG-1" });
  });

  it("rejects anything that is not a linear.app issue url", () => {
    for (const url of [
      "https://linear.app/acme/project/abc",
      "https://linear.app/acme/issue/ENG-0",
      "https://linear.app/acme/issue/ENG-",
      "https://linear.app/acme/issue/ENG-12345678",
      "https://linear.app/acme/nested/issue/ENG-1",
      "https://linear.app.evil/acme/issue/ENG-1",
      "https://evil.com/linear.app/acme/issue/ENG-1",
      "http://linear.app/acme/issue/ENG-1",
      "not a url",
    ]) {
      expect(parseLinearIssueUrl(url), url).toBeNull();
    }
  });
});
