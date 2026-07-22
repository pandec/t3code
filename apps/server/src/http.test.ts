import { describe, expect, it } from "vite-plus/test";

import { isLoopbackHostname, parseSingleByteRange, resolveDevRedirectUrl } from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("parseSingleByteRange", () => {
  it("parses bounded, open-ended, and suffix ranges", () => {
    expect(parseSingleByteRange("bytes=10-19", 100)).toEqual({
      _tag: "Range",
      start: 10,
      end: 19,
    });
    expect(parseSingleByteRange("bytes=90-", 100)).toEqual({
      _tag: "Range",
      start: 90,
      end: 99,
    });
    expect(parseSingleByteRange("bytes=-10", 100)).toEqual({
      _tag: "Range",
      start: 90,
      end: 99,
    });
  });

  it("clamps ranges and rejects unsupported or unsatisfiable requests", () => {
    expect(parseSingleByteRange("bytes=90-199", 100)).toEqual({
      _tag: "Range",
      start: 90,
      end: 99,
    });
    expect(parseSingleByteRange("bytes=100-", 100)).toEqual({ _tag: "Unsatisfiable" });
    expect(parseSingleByteRange("bytes=20-10", 100)).toEqual({ _tag: "Unsatisfiable" });
    expect(parseSingleByteRange("items=0-10", 100)).toEqual({ _tag: "Invalid" });
    expect(parseSingleByteRange("bytes=0-1,4-5", 100)).toEqual({ _tag: "Invalid" });
  });
});
