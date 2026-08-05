import { SessionImportCandidate } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  getAmbiguousSessionImportProviders,
  getSessionImportCandidateKey,
  getSessionImportProviderLabel,
} from "./SessionImportDialog.logic";

const decodeCandidate = Schema.decodeSync(SessionImportCandidate);

function candidate(input: {
  readonly instanceId: string;
  readonly provider: "claudeAgent" | "codex";
  readonly providerDisplayName?: string;
  readonly nativeSessionId?: string;
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
  });
}

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
