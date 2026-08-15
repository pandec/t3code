import type { EnvironmentId } from "@t3tools/contracts";
import type { SavedPromptLibrary } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSavedPromptSyncPatches,
  resolveSavedPromptLibrary,
  stampSavedPromptLibrary,
} from "./savedPrompts.ts";

const environmentId = (value: string): EnvironmentId => value as EnvironmentId;

const LOCAL = environmentId("environment-local");
const REMOTE = environmentId("environment-remote");
const THIRD = environmentId("environment-third");

function library(updatedAt: number, ...titles: string[]): SavedPromptLibrary {
  return {
    updatedAt,
    prompts: titles.map((title) => ({ id: `id-${title}`, title, content: `content ${title}` })),
  };
}

describe("resolveSavedPromptLibrary", () => {
  it("returns the empty default when no environment is connected", () => {
    const resolved = resolveSavedPromptLibrary(new Map());
    expect(resolved.library.prompts).toEqual([]);
    expect(resolved.sourceEnvironmentId).toBeNull();
  });

  it("returns the empty default when every copy is unset", () => {
    const resolved = resolveSavedPromptLibrary(
      new Map([
        [LOCAL, library(0)],
        [REMOTE, library(0)],
      ]),
    );
    expect(resolved.sourceEnvironmentId).toBeNull();
  });

  it("picks the newest stamp", () => {
    const resolved = resolveSavedPromptLibrary(
      new Map([
        [LOCAL, library(100, "older")],
        [REMOTE, library(200, "newer")],
      ]),
    );
    expect(resolved.library.prompts[0]?.title).toBe("newer");
    expect(resolved.sourceEnvironmentId).toBe(REMOTE);
  });

  it("breaks stamp ties by environmentId order, regardless of map order", () => {
    const forward = resolveSavedPromptLibrary(
      new Map([
        [LOCAL, library(100, "local")],
        [REMOTE, library(100, "remote")],
      ]),
    );
    const reversed = resolveSavedPromptLibrary(
      new Map([
        [REMOTE, library(100, "remote")],
        [LOCAL, library(100, "local")],
      ]),
    );
    expect(forward.sourceEnvironmentId).toBe(LOCAL);
    expect(reversed.sourceEnvironmentId).toBe(LOCAL);
  });
});

describe("buildSavedPromptSyncPatches", () => {
  it("returns nothing when every copy is unset", () => {
    expect(
      buildSavedPromptSyncPatches({
        librariesByEnvironment: new Map([
          [LOCAL, library(0)],
          [REMOTE, library(0)],
        ]),
        writableEnvironmentIds: new Set([LOCAL, REMOTE]),
      }),
    ).toEqual([]);
  });

  it("pushes the newest library to strictly older writable environments only", () => {
    const newest = library(300, "kept");
    const patches = buildSavedPromptSyncPatches({
      librariesByEnvironment: new Map([
        [LOCAL, library(100)],
        [REMOTE, newest],
        [THIRD, library(300, "kept")],
      ]),
      writableEnvironmentIds: new Set([LOCAL, REMOTE, THIRD]),
    });
    expect(patches).toEqual([{ environmentId: LOCAL, savedPromptLibrary: newest }]);
  });

  it("never targets environments without the capability", () => {
    expect(
      buildSavedPromptSyncPatches({
        librariesByEnvironment: new Map([
          [LOCAL, library(100)],
          [REMOTE, library(300, "newer")],
        ]),
        writableEnvironmentIds: new Set([REMOTE]),
      }),
    ).toEqual([]);
  });

  it("is a no-op on the converged steady state", () => {
    expect(
      buildSavedPromptSyncPatches({
        librariesByEnvironment: new Map([
          [LOCAL, library(300, "same")],
          [REMOTE, library(300, "same")],
        ]),
        writableEnvironmentIds: new Set([LOCAL, REMOTE]),
      }),
    ).toEqual([]);
  });
});

describe("stampSavedPromptLibrary", () => {
  it("stamps with the wall clock when it is ahead", () => {
    const next = stampSavedPromptLibrary(library(100, "old"), [], 500);
    expect(next).toEqual({ updatedAt: 500, prompts: [] });
  });

  it("stays monotonic when the wall clock is behind the current stamp", () => {
    const next = stampSavedPromptLibrary(library(1_000, "old"), [], 500);
    expect(next.updatedAt).toBe(1_001);
  });
});
