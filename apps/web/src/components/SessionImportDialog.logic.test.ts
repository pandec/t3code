import { SessionImportCandidate, SessionImportError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  getAmbiguousSessionImportProviders,
  getLinkedSessionsGroupLabel,
  getSessionImportCandidateKey,
  getSessionImportEmptyStateLabel,
  getSessionImportFailureReason,
  getSessionImportProviderLabel,
  partitionSessionImportCandidates,
} from "./SessionImportDialog.logic";

const decodeCandidate = Schema.decodeSync(SessionImportCandidate);

function candidate(input: {
  readonly instanceId: string;
  readonly provider: "claudeAgent" | "codex";
  readonly providerDisplayName?: string;
  readonly nativeSessionId?: string;
  readonly linkedThread?: {
    readonly threadId: string;
    readonly title: string;
    readonly archivedAt: string | null;
    readonly updatedAt: string;
  };
}): SessionImportCandidate {
  return decodeCandidate({
    instanceId: input.instanceId,
    provider: input.provider,
    providerDisplayName: input.providerDisplayName ?? input.provider,
    nativeSessionId: input.nativeSessionId ?? `${input.instanceId}-session`,
    name: null,
    preview: "Preview",
    messageCount: 1,
    updatedAt: "2026-08-05T00:00:00.000Z",
    linkedThread: input.linkedThread ?? null,
    canFork: false,
  });
}

const linkedThread = {
  threadId: "thread-1",
  title: "Owning thread",
  archivedAt: null,
  updatedAt: "2026-08-04T00:00:00.000Z",
};

describe("session import provider labels", () => {
  it("keys duplicate native sessions by provider instance", () => {
    const session = candidate({
      instanceId: "codex_personal",
      provider: "codex",
      nativeSessionId: "shared-session",
    });

    expect(getSessionImportCandidateKey(session)).toBe("codex_personal:shared-session");
  });

  it("keeps labels compact when each provider has one instance", () => {
    const codex = candidate({ instanceId: "codex_personal", provider: "codex" });
    const claude = candidate({ instanceId: "claude_work", provider: "claudeAgent" });
    const ambiguousProviders = getAmbiguousSessionImportProviders([codex, claude]);

    expect([...ambiguousProviders]).toEqual([]);
    expect(getSessionImportProviderLabel(codex, ambiguousProviders.has(codex.provider))).toBe(
      "Codex",
    );
    expect(getSessionImportProviderLabel(claude, ambiguousProviders.has(claude.provider))).toBe(
      "Claude Code",
    );
  });

  it("adds instance ids when one provider has multiple distinct instances", () => {
    const codexPersonal = candidate({
      instanceId: "codex_personal",
      provider: "codex",
      providerDisplayName: "Codex",
    });
    const codexWork = candidate({
      instanceId: "codex_work",
      provider: "codex",
      providerDisplayName: "Codex",
    });
    const claude = candidate({
      instanceId: "claude_work",
      provider: "claudeAgent",
      providerDisplayName: "Claude",
    });
    const ambiguousProviders = getAmbiguousSessionImportProviders([
      codexPersonal,
      codexWork,
      claude,
    ]);

    expect([...ambiguousProviders]).toEqual(["codex"]);
    expect(
      getSessionImportProviderLabel(codexPersonal, ambiguousProviders.has(codexPersonal.provider)),
    ).toBe("Codex · codex_personal");
    expect(
      getSessionImportProviderLabel(codexWork, ambiguousProviders.has(codexWork.provider)),
    ).toBe("Codex · codex_work");
    expect(getSessionImportProviderLabel(claude, ambiguousProviders.has(claude.provider))).toBe(
      "Claude",
    );
  });

  it("does not treat multiple sessions from one instance as ambiguous", () => {
    const first = candidate({
      instanceId: "codex_personal",
      provider: "codex",
      nativeSessionId: "session-one",
    });
    const second = candidate({
      instanceId: "codex_personal",
      provider: "codex",
      nativeSessionId: "session-two",
    });

    expect([...getAmbiguousSessionImportProviders([first, second])]).toEqual([]);
  });
});

describe("session import candidate groups", () => {
  it("partitions linked sessions out while preserving order within each group", () => {
    const first = candidate({ instanceId: "codex_personal", provider: "codex" });
    const owned = candidate({
      instanceId: "claude_work",
      provider: "claudeAgent",
      nativeSessionId: "owned-session",
      linkedThread,
    });
    const second = candidate({
      instanceId: "codex_personal",
      provider: "codex",
      nativeSessionId: "second-session",
    });

    const groups = partitionSessionImportCandidates([first, owned, second]);

    expect(groups.importable).toEqual([first, second]);
    expect(groups.linked).toEqual([owned]);
  });

  it("labels the linked group with its count", () => {
    expect(getLinkedSessionsGroupLabel(4)).toBe("Already in T3 (4)");
  });

  it("shows no empty state while importable rows exist", () => {
    const importable = candidate({ instanceId: "codex_personal", provider: "codex" });

    expect(getSessionImportEmptyStateLabel(partitionSessionImportCandidates([importable]))).toBe(
      null,
    );
  });

  it("explains an all-linked list instead of claiming nothing was found", () => {
    const owned = candidate({ instanceId: "codex_personal", provider: "codex", linkedThread });

    expect(getSessionImportEmptyStateLabel(partitionSessionImportCandidates([owned]))).toBe(
      "Every session found for this project is already in T3 Code.",
    );
    expect(getSessionImportEmptyStateLabel(partitionSessionImportCandidates([]))).toBe(
      "No sessions found for this project.",
    );
  });
});

describe("session import failure reasons", () => {
  it("reads the reason from a decoded SessionImportError", () => {
    const error = new SessionImportError({
      reason: "already-imported",
      detail: "Session already imported.",
    });

    expect(getSessionImportFailureReason(error)).toBe("already-imported");
  });

  it("reads the reason from a structurally equivalent failure", () => {
    expect(
      getSessionImportFailureReason({ _tag: "SessionImportError", reason: "fork-unsupported" }),
    ).toBe("fork-unsupported");
  });

  it("ignores unrelated errors", () => {
    expect(getSessionImportFailureReason(new Error("boom"))).toBe(null);
    expect(getSessionImportFailureReason("nope")).toBe(null);
    expect(getSessionImportFailureReason(null)).toBe(null);
  });
});
