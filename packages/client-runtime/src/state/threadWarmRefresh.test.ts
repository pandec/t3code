import { describe, expect, it } from "vite-plus/test";

import { MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { OrchestrationThread } from "@t3tools/contracts";

import { preserveLoadedOlderMessages } from "./threads.ts";
import { DEFAULT_MESSAGE_WINDOW_LIMIT, MAX_MESSAGE_WINDOW_MULTIPLIER } from "./threadRetention.ts";

const MOBILE_BASE_WINDOW = 150;
const MOBILE_MAX_OLDER = MOBILE_BASE_WINDOW * (MAX_MESSAGE_WINDOW_MULTIPLIER - 1);
const MOBILE_MAX_RESIDENT = MOBILE_BASE_WINDOW * MAX_MESSAGE_WINDOW_MULTIPLIER;

const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  movedToTopAt: null,
  deletedAt: null,
  messages: [],
  completedTurnAssistantMessageIds: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

function isoTimestampForSecond(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const seconds = totalSeconds % 60;
  const day = 1 + Math.floor(hours / 24);
  const hour = hours % 24;
  return `2026-04-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(
    minutes,
  ).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000Z`;
}

function makeMessages(
  prefix: string,
  count: number,
  startIndex = 0,
): OrchestrationThread["messages"] {
  return Array.from({ length: count }, (_, offset) => {
    const index = startIndex + offset;
    const createdAt = isoTimestampForSecond(index);
    return {
      id: MessageId.make(`${prefix}-${index}`),
      role: "user" as const,
      text: `Message ${prefix}-${index}`,
      turnId: null,
      streaming: false,
      createdAt,
      updatedAt: createdAt,
    };
  });
}

describe("preserveLoadedOlderMessages", () => {
  it("preserves loaded history under the mobile base window without hitting a cap", () => {
    const older = makeMessages("older", 300);
    const base = makeMessages("base", MOBILE_BASE_WINDOW, 300);
    const current: OrchestrationThread = {
      ...baseThread,
      messages: [...older, ...base],
      messageWindow: {
        hasMoreOlder: true,
        oldestLoadedMessageId: older[0]!.id,
        totalCount: null,
      },
    };
    const refreshed: OrchestrationThread = {
      ...baseThread,
      messages: base,
      messageWindow: {
        hasMoreOlder: true,
        oldestLoadedMessageId: base[0]!.id,
        totalCount: null,
      },
    };

    const result = preserveLoadedOlderMessages(current, refreshed, older.length, {
      messageWindowLimit: MOBILE_BASE_WINDOW,
      maxLoadedOlderMessageCount: MOBILE_MAX_OLDER,
    });

    expect(result.messages).toHaveLength(older.length + base.length);
    expect(result.messages.length).toBeLessThanOrEqual(MOBILE_MAX_RESIDENT);
    expect(result.messages.length - base.length).toBeLessThanOrEqual(MOBILE_MAX_OLDER);
    expect(result.messageWindow?.hasMoreOlder).toBe(true);
  });

  it("clamps resident total and older count to the 5x cap when fully loaded", () => {
    // More candidates than the cap allows, so the merge must clamp rather
    // than let a warm refresh regrow the window past explicit scrollback's
    // own five-window ceiling.
    const older = makeMessages("older", MOBILE_MAX_OLDER + 200);
    const base = makeMessages("base", MOBILE_BASE_WINDOW, older.length);
    const current: OrchestrationThread = {
      ...baseThread,
      messages: [...older, ...base],
      messageWindow: {
        hasMoreOlder: true,
        oldestLoadedMessageId: older[0]!.id,
        totalCount: null,
      },
    };
    const refreshed: OrchestrationThread = {
      ...baseThread,
      messages: base,
      messageWindow: {
        hasMoreOlder: true,
        oldestLoadedMessageId: base[0]!.id,
        totalCount: null,
      },
    };

    const result = preserveLoadedOlderMessages(current, refreshed, MOBILE_MAX_OLDER, {
      messageWindowLimit: MOBILE_BASE_WINDOW,
      maxLoadedOlderMessageCount: MOBILE_MAX_OLDER,
    });

    expect(result.messages.length).toBe(MOBILE_MAX_RESIDENT);
    expect(result.messages.length).toBeLessThanOrEqual(MOBILE_MAX_RESIDENT);
    const preservedOlderCount = result.messages.length - base.length;
    expect(preservedOlderCount).toBe(MOBILE_MAX_OLDER);
    expect(preservedOlderCount).toBeLessThanOrEqual(MOBILE_MAX_OLDER);
    // Reaching the retention cap stops inviting further loads, mirroring
    // `loadOlderMessages`'s own explicit-scrollback ceiling.
    expect(result.messageWindow?.hasMoreOlder).toBe(false);
    // The oldest surviving message is the most recent slice of `older`, not
    // its head — clamping trims from the far (oldest) end.
    expect(result.messages[0]?.id).toBe(older.at(-1 * MOBILE_MAX_OLDER)?.id);
  });

  it("clamps to the known total when only a partial older page overlaps the cap", () => {
    const totalCount = MOBILE_MAX_RESIDENT - 50;
    const older = makeMessages("older", totalCount - MOBILE_BASE_WINDOW);
    const base = makeMessages("base", MOBILE_BASE_WINDOW, older.length);
    const current: OrchestrationThread = {
      ...baseThread,
      messages: [...older, ...base],
      messageWindow: {
        hasMoreOlder: true,
        oldestLoadedMessageId: older[0]!.id,
        totalCount,
      },
    };
    const refreshed: OrchestrationThread = {
      ...baseThread,
      messages: base,
      messageWindow: {
        hasMoreOlder: true,
        oldestLoadedMessageId: base[0]!.id,
        totalCount,
      },
    };

    const result = preserveLoadedOlderMessages(current, refreshed, older.length, {
      messageWindowLimit: MOBILE_BASE_WINDOW,
      maxLoadedOlderMessageCount: MOBILE_MAX_OLDER,
    });

    expect(result.messages.length).toBeLessThanOrEqual(MOBILE_MAX_RESIDENT);
    const preservedOlderCount = result.messages.length - base.length;
    expect(preservedOlderCount).toBeLessThanOrEqual(MOBILE_MAX_OLDER);
    expect(result.messages.length).toBe(totalCount);
    // Caught up to the server's authoritative total: nothing more to load.
    expect(result.messageWindow?.hasMoreOlder).toBe(false);
  });

  it("uses the default mobile constant as the base window for the shared cap math", () => {
    expect(DEFAULT_MESSAGE_WINDOW_LIMIT).toBeGreaterThan(0);
    expect(MOBILE_MAX_OLDER).toBe(600);
    expect(MOBILE_MAX_RESIDENT).toBe(750);
  });
});
