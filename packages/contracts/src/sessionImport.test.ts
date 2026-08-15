import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { SessionImportCandidate } from "./sessionImport.ts";

const decodeCandidate = Schema.decodeUnknownSync(SessionImportCandidate);

describe("SessionImportCandidate", () => {
  it("decodes candidates from older servers without linkedThread", () => {
    const candidate = decodeCandidate({
      instanceId: "claude-main",
      provider: "claudeAgent",
      providerDisplayName: "Claude Code",
      nativeSessionId: "session-1",
      name: null,
      preview: "Continue the task",
      messageCount: 2,
      updatedAt: "2026-08-15T10:00:00.000Z",
    });

    expect(candidate.linkedThread).toBeUndefined();
  });
});
