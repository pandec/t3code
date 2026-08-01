import { describe, expect, it, vi } from "vite-plus/test";

import type { MobileDiagnosticEvent } from "./events";
import {
  appendMobileDiagnosticEvents,
  MOBILE_DIAGNOSTICS_MAX_FILE_BYTES,
  serializeMobileDiagnosticEvents,
  shouldRotateMobileDiagnostics,
} from "./persistence";

const fakeFiles = vi.hoisted(() => new Map<string, string>());

// Mirrors expo-file-system's native contract, including the detail that matters
// for rotation: `move` rewrites the moved path's own uri (ios/FileSystemPath.swift
// assigns `url = destinationUrl` on the source), while the destination handle is
// left untouched.
vi.mock("expo-file-system", () => {
  const join = (parts: ReadonlyArray<string | { readonly uri: string }>) =>
    parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");

  class FakeDirectory {
    uri: string;
    constructor(...parts: (string | { readonly uri: string })[]) {
      this.uri = join(parts);
    }
    create() {}
  }

  class FakeFile {
    uri: string;
    constructor(...parts: (string | { readonly uri: string })[]) {
      this.uri = join(parts);
    }
    get exists() {
      return fakeFiles.has(this.uri);
    }
    get size() {
      return Buffer.byteLength(fakeFiles.get(this.uri) ?? "");
    }
    create() {
      if (!fakeFiles.has(this.uri)) fakeFiles.set(this.uri, "");
    }
    delete() {
      fakeFiles.delete(this.uri);
    }
    write(content: string, options?: { readonly append?: boolean }) {
      const existing = options?.append === true ? (fakeFiles.get(this.uri) ?? "") : "";
      fakeFiles.set(this.uri, existing + content);
    }
    moveSync(destination: { readonly uri: string }, options?: { readonly overwrite?: boolean }) {
      if (fakeFiles.has(destination.uri) && options?.overwrite !== true) {
        throw new Error(`destination already exists: ${destination.uri}`);
      }
      fakeFiles.set(destination.uri, fakeFiles.get(this.uri) ?? "");
      fakeFiles.delete(this.uri);
      this.uri = destination.uri;
    }
  }

  return { Directory: FakeDirectory, File: FakeFile, Paths: { document: "file:///documents" } };
});

function generationEvent(marker: string): MobileDiagnosticEvent {
  // Two of these overflow the per-file budget, so each append after the first rotates.
  return { t: 1, m: 1, k: marker, d: { pad: "x".repeat(600_000) } };
}

/** The event kinds retained in each generation, so failures stay readable. */
function journalGenerations() {
  const kinds = (name: string) => {
    const contents = fakeFiles.get(`file:///documents/mobile-diagnostics/${name}`);
    if (contents === undefined) return null;
    return contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as MobileDiagnosticEvent).k);
  };
  return {
    current: kinds("events.ndjson"),
    previous: kinds("events.1.ndjson"),
    oldest: kinds("events.2.ndjson"),
  };
}

describe("mobile diagnostic persistence", () => {
  it("serializes one JSON object per line", () => {
    expect(
      serializeMobileDiagnosticEvents([{ t: 10, m: 5, k: "app", d: { state: "active" } }]),
    ).toBe('{"t":10,"m":5,"k":"app","d":{"state":"active"}}\n');
  });

  it("rotates only a non-empty file that would exceed the budget", () => {
    expect(shouldRotateMobileDiagnostics(0, MOBILE_DIAGNOSTICS_MAX_FILE_BYTES + 1)).toBe(false);
    expect(shouldRotateMobileDiagnostics(MOBILE_DIAGNOSTICS_MAX_FILE_BYTES - 10, 10)).toBe(false);
    expect(shouldRotateMobileDiagnostics(MOBILE_DIAGNOSTICS_MAX_FILE_BYTES - 10, 11)).toBe(true);
  });

  it("retains three generations across repeated rotations", async () => {
    fakeFiles.clear();

    await appendMobileDiagnosticEvents([generationEvent("first")]);
    expect(journalGenerations()).toEqual({ current: ["first"], previous: null, oldest: null });

    await appendMobileDiagnosticEvents([generationEvent("second")]);
    expect(journalGenerations()).toEqual({
      current: ["second"],
      previous: ["first"],
      oldest: null,
    });

    // The second rotation is where a reused destination handle would aim at the
    // oldest slot and overwrite the generation just moved there.
    await appendMobileDiagnosticEvents([generationEvent("third")]);
    expect(journalGenerations()).toEqual({
      current: ["third"],
      previous: ["second"],
      oldest: ["first"],
    });

    await appendMobileDiagnosticEvents([generationEvent("fourth")]);
    expect(journalGenerations()).toEqual({
      current: ["fourth"],
      previous: ["third"],
      oldest: ["second"],
    });
  });
});
