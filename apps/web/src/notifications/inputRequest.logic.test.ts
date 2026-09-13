import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { buildInputRequestCopy, collectInputRequestCandidates } from "./inputRequest.logic";

function makeShell(input: {
  id: string;
  environmentId?: string;
  turnId?: string;
  approvals?: boolean;
  input?: boolean;
  archivedAt?: string | null;
}): EnvironmentThreadShell {
  return {
    id: input.id,
    environmentId: input.environmentId ?? "env-1",
    title: `Thread ${input.id}`,
    archivedAt: input.archivedAt ?? null,
    latestTurn: { turnId: input.turnId ?? `${input.id}-turn` },
    hasPendingApprovals: input.approvals ?? false,
    hasPendingUserInput: input.input ?? false,
  } as unknown as EnvironmentThreadShell;
}

const idle = (id: string) => makeShell({ id });
const needsInput = (id: string) => makeShell({ id, input: true });
const needsApproval = (id: string) => makeShell({ id, approvals: true });

describe("collectInputRequestCandidates", () => {
  it("fires when a known thread starts waiting for input or approval", () => {
    expect(collectInputRequestCandidates([idle("a")], [needsInput("a")])).toEqual([
      { environmentId: "env-1", threadId: "a", kind: "input", title: "Thread a" },
    ]);
    expect(collectInputRequestCandidates([idle("a")], [needsApproval("a")])).toEqual([
      { environmentId: "env-1", threadId: "a", kind: "approval", title: "Thread a" },
    ]);
  });

  it("stays silent for threads absent from the previous list (initial sync, reconnect)", () => {
    expect(collectInputRequestCandidates([], [needsInput("a")])).toEqual([]);
    expect(collectInputRequestCandidates([idle("a")], [idle("a"), needsApproval("b")])).toEqual([]);
  });

  it("does not re-fire while the same request stays pending", () => {
    expect(collectInputRequestCandidates([needsInput("a")], [needsInput("a")])).toEqual([]);
  });

  it("fires again for a new request on a later turn, or when the kind changes", () => {
    expect(
      collectInputRequestCandidates(
        [needsInput("a")],
        [makeShell({ id: "a", turnId: "a-turn-2", input: true })],
      ),
    ).toHaveLength(1);
    expect(collectInputRequestCandidates([needsInput("a")], [needsApproval("a")])).toEqual([
      { environmentId: "env-1", threadId: "a", kind: "approval", title: "Thread a" },
    ]);
  });

  it("prefers approval when both are pending and ignores archived threads", () => {
    expect(
      collectInputRequestCandidates(
        [idle("a")],
        [makeShell({ id: "a", approvals: true, input: true })],
      )[0]?.kind,
    ).toBe("approval");
    expect(
      collectInputRequestCandidates(
        [idle("a")],
        [makeShell({ id: "a", input: true, archivedAt: "2026-07-24T10:00:00.000Z" })],
      ),
    ).toEqual([]);
  });

  it("keys threads by environment", () => {
    expect(
      collectInputRequestCandidates(
        [idle("a")],
        [makeShell({ id: "a", environmentId: "env-2", input: true })],
      ),
    ).toEqual([]);
  });
});

describe("buildInputRequestCopy", () => {
  it("names the request kind and falls back for blank titles", () => {
    expect(buildInputRequestCopy({ kind: "approval", title: "Deploy" })).toEqual({
      title: "Approval needed",
      body: "Deploy",
    });
    expect(buildInputRequestCopy({ kind: "input", title: "  " })).toEqual({
      title: "Input needed",
      body: "A thread is waiting for input.",
    });
  });
});
