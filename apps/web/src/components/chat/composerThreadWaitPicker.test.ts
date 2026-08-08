import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import {
  buildThreadWaitInsertionText,
  buildThreadWaitPickerEntries,
  threadWaitPickerActivity,
} from "./composerThreadWaitPicker";

const ENV = "env-1" as EnvironmentId;
const OTHER_ENV = "env-2" as EnvironmentId;

function shell(input: {
  id: string;
  title: string;
  updatedAt: string;
  environmentId?: EnvironmentId;
  archivedAt?: string | null;
  sessionStatus?: "running" | "starting" | "ready" | "idle" | "stopped" | "error";
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  backgroundLiveness?: "working" | "monitoring" | null;
}): EnvironmentThreadShell {
  return {
    id: input.id as ThreadId,
    title: input.title,
    updatedAt: input.updatedAt,
    environmentId: input.environmentId ?? ENV,
    archivedAt: input.archivedAt ?? null,
    session: input.sessionStatus ? { status: input.sessionStatus } : null,
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
    backgroundLiveness: input.backgroundLiveness ?? null,
  } as unknown as EnvironmentThreadShell;
}

describe("threadWaitPickerActivity", () => {
  it("ranks pending approvals and input as blocked over a running session", () => {
    expect(
      threadWaitPickerActivity(
        shell({
          id: "t",
          title: "t",
          updatedAt: "2026-08-08T10:00:00.000Z",
          sessionStatus: "running",
          hasPendingApprovals: true,
        }),
      ),
    ).toBe("blocked");
  });

  it("treats starting sessions as running", () => {
    expect(
      threadWaitPickerActivity(
        shell({
          id: "t",
          title: "t",
          updatedAt: "2026-08-08T10:00:00.000Z",
          sessionStatus: "starting",
        }),
      ),
    ).toBe("running");
  });

  it("reports background liveness once the session has settled", () => {
    expect(
      threadWaitPickerActivity(
        shell({
          id: "t",
          title: "t",
          updatedAt: "2026-08-08T10:00:00.000Z",
          sessionStatus: "ready",
          backgroundLiveness: "working",
        }),
      ),
    ).toBe("background");
  });
});

describe("buildThreadWaitPickerEntries", () => {
  const shells = [
    shell({ id: "idle-old", title: "Routine idle thread", updatedAt: "2026-08-01T10:00:00.000Z" }),
    shell({
      id: "running-old",
      title: "Long running sync",
      updatedAt: "2026-08-02T10:00:00.000Z",
      sessionStatus: "running",
    }),
    shell({ id: "idle-new", title: "Routine idle thread", updatedAt: "2026-08-08T10:00:00.000Z" }),
    shell({
      id: "archived",
      title: "Archived thread",
      updatedAt: "2026-08-08T11:00:00.000Z",
      archivedAt: "2026-08-08T11:00:00.000Z",
    }),
    shell({
      id: "other-env",
      title: "Other environment thread",
      updatedAt: "2026-08-08T12:00:00.000Z",
      environmentId: OTHER_ENV,
    }),
    shell({ id: "self", title: "The composing thread", updatedAt: "2026-08-08T13:00:00.000Z" }),
  ];

  it("excludes archived, other-environment, and the composing thread; running first, then recency", () => {
    const entries = buildThreadWaitPickerEntries({
      shells,
      environmentId: ENV,
      excludeThreadId: "self" as ThreadId,
      query: "",
    });
    expect(entries.map((entry) => entry.id)).toEqual(["running-old", "idle-new", "idle-old"]);
  });

  it("filters by title query", () => {
    const entries = buildThreadWaitPickerEntries({
      shells,
      environmentId: ENV,
      excludeThreadId: null,
      query: "sync",
    });
    expect(entries.map((entry) => entry.id)).toEqual(["running-old"]);
  });

  it("prefers recency between equal-score title matches", () => {
    const entries = buildThreadWaitPickerEntries({
      shells,
      environmentId: ENV,
      excludeThreadId: null,
      query: "idle thread",
    });
    expect(entries.map((entry) => entry.id)).toEqual(["idle-new", "idle-old"]);
  });
});

describe("buildThreadWaitInsertionText", () => {
  it("wraps the id in backticks, quotes the title, and ends mid-sentence", () => {
    expect(buildThreadWaitInsertionText({ id: "abc-123", title: "Sync Fork With Upstream" })).toBe(
      '$t3-cli wait for thread `abc-123` ("Sync Fork With Upstream") to finish, then ',
    );
  });

  it("collapses whitespace, converts double quotes, and caps long titles", () => {
    const text = buildThreadWaitInsertionText({
      id: "abc",
      title: `A  "very"   ${"long ".repeat(20)}title`,
    });
    expect(text).toContain("A 'very' long");
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(140);
  });

  it("omits the title clause when the title is blank", () => {
    expect(buildThreadWaitInsertionText({ id: "abc", title: "  " })).toBe(
      "$t3-cli wait for thread `abc` to finish, then ",
    );
  });
});
