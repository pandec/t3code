import type { EnvironmentId } from "@t3tools/contracts";
import type { SidebarProjectAccentColor } from "@t3tools/contracts/settings";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  __resetProjectAccentColorWriteQueueForTests,
  enqueueProjectAccentColorWrite,
} from "./projectAccentColorWriteQueue";

const ENVIRONMENT = "environment-local" as EnvironmentId;
const color = (value: string) => value as SidebarProjectAccentColor;

beforeEach(__resetProjectAccentColorWriteQueueForTests);

describe("enqueueProjectAccentColorWrite", () => {
  it("builds a queued whole-map update from the prior server response", async () => {
    const persisted: Array<Record<string, SidebarProjectAccentColor>> = [];
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstPersisted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const persist = async (projectAccentColors: Record<string, SidebarProjectAccentColor>) => {
      persisted.push(projectAccentColors);
      if (persisted.length === 1) {
        markFirstStarted?.();
        await firstPersisted;
      }
      return projectAccentColors;
    };
    const add = (key: string, value: SidebarProjectAccentColor) =>
      enqueueProjectAccentColorWrite({
        environmentId: ENVIRONMENT,
        fallbackMap: {},
        readCurrentMap: () => ({}),
        update: (current) => ({
          next: { ...current, [key]: value },
          changed: current[key] !== value,
        }),
        persist,
      });

    const first = add("repo/a", color("#111111"));
    const second = add("repo/b", color("#222222"));
    await firstStarted;
    expect(persisted).toEqual([{ "repo/a": "#111111" }]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(persisted[1]).toEqual({
      "repo/a": "#111111",
      "repo/b": "#222222",
    });
  });

  it("rebuilds from the current rendered map after a failed write", async () => {
    let attempts = 0;
    const persisted: Array<Record<string, SidebarProjectAccentColor>> = [];
    const persist = async (projectAccentColors: Record<string, SidebarProjectAccentColor>) => {
      persisted.push(projectAccentColors);
      attempts += 1;
      return attempts === 1 ? null : projectAccentColors;
    };
    const enqueue = (key: string, value: SidebarProjectAccentColor) =>
      enqueueProjectAccentColorWrite({
        environmentId: ENVIRONMENT,
        fallbackMap: {},
        readCurrentMap: () => ({ "repo/external": color("#333333") }),
        update: (current) => ({
          next: { ...current, [key]: value },
          changed: current[key] !== value,
        }),
        persist,
      });

    await Promise.all([enqueue("repo/a", color("#111111")), enqueue("repo/b", color("#222222"))]);

    expect(persisted[1]).toEqual({
      "repo/external": "#333333",
      "repo/b": "#222222",
    });
  });
});
