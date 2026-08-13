import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "../state/models.ts";

export type CanonicalThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "monitoring"
  | "failed"
  | "ready";

export type ThreadStatusParityInput = Pick<
  EnvironmentThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "session" | "backgroundLiveness"
>;

const session = (status: NonNullable<ThreadStatusParityInput["session"]>["status"]) => ({
  threadId: ThreadId.make("thread-status-parity"),
  status,
  providerName: "Codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: status === "error" ? "boom" : null,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const ready: ThreadStatusParityInput = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null,
  backgroundLiveness: null,
};

export const THREAD_STATUS_PARITY_CASES = [
  {
    name: "approval outranks every lower state",
    thread: {
      ...ready,
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      session: session("running"),
      backgroundLiveness: "monitoring",
    },
    expected: "approval",
  },
  {
    name: "approval outranks foreground failure",
    thread: { ...ready, hasPendingApprovals: true, session: session("error") },
    expected: "approval",
  },
  {
    name: "approval outranks background working",
    thread: { ...ready, hasPendingApprovals: true, backgroundLiveness: "working" },
    expected: "approval",
  },
  {
    name: "input outranks foreground work and background liveness",
    thread: {
      ...ready,
      hasPendingUserInput: true,
      session: session("running"),
      backgroundLiveness: "working",
    },
    expected: "input",
  },
  {
    name: "input outranks foreground failure",
    thread: { ...ready, hasPendingUserInput: true, session: session("error") },
    expected: "input",
  },
  {
    name: "running session outranks background monitoring",
    thread: { ...ready, session: session("running"), backgroundLiveness: "monitoring" },
    expected: "working",
  },
  {
    name: "starting session outranks background monitoring",
    thread: { ...ready, session: session("starting"), backgroundLiveness: "monitoring" },
    expected: "working",
  },
  {
    name: "foreground error",
    thread: { ...ready, session: session("error") },
    expected: "failed",
  },
  {
    name: "foreground error outranks stale liveness",
    thread: {
      ...ready,
      session: session("error"),
      backgroundLiveness: "working",
    },
    expected: "failed",
  },
  {
    name: "foreground error outranks background monitoring",
    thread: {
      ...ready,
      session: session("error"),
      backgroundLiveness: "monitoring",
    },
    expected: "failed",
  },
  {
    name: "background working",
    thread: { ...ready, session: session("ready"), backgroundLiveness: "working" },
    expected: "working",
  },
  {
    name: "background monitoring",
    thread: { ...ready, session: session("stopped"), backgroundLiveness: "monitoring" },
    expected: "monitoring",
  },
  {
    name: "quiescent thread",
    thread: ready,
    expected: "ready",
  },
] as const satisfies ReadonlyArray<{
  readonly name: string;
  readonly thread: ThreadStatusParityInput;
  readonly expected: CanonicalThreadStatus;
}>;
