// @effect-diagnostics nodeBuiltinImport:off -- The reader under test is raw node:fs by design, so its fixtures are too.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readTranscriptRecords } from "./usageTranscriptReader.ts";

/**
 * `malformedRecords` is the reader's way of saying "this file's totals are
 * understated". `parseCodexLine` answers `null` both for lines it could not
 * read and for well-formed lines it deliberately declined to count, so these
 * cover the seam between the two.
 */
async function withCodexTranscript<A>(
  lines: string,
  use: (path: string) => Promise<A>,
): Promise<A> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-reader-"));
  const path = NodePath.join(dir, "rollout.jsonl");
  try {
    await NodeFSP.writeFile(path, lines, "utf8");
    return await use(path);
  } finally {
    await NodeFSP.rm(dir, { force: true, recursive: true });
  }
}

const meta = (overrides: { readonly forkedFromId?: string; readonly timestamp: string }) =>
  JSON.stringify({
    type: "session_meta",
    timestamp: overrides.timestamp,
    payload: {
      type: "session_meta",
      id: "child",
      ...(overrides.forkedFromId ? { forked_from_id: overrides.forkedFromId } : {}),
    },
  });

const turnContext = (timestamp: string) =>
  JSON.stringify({
    type: "turn_context",
    timestamp,
    payload: { type: "turn_context", model: "gpt-5.6-sol" },
  });

const tokenCount = (timestamp: string, inputTokens: number, output: number) =>
  JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: output,
          reasoning_output_tokens: 0,
        },
      },
    },
  });

describe("readTranscriptRecords", () => {
  it("does not report deliberately dropped fork copies as malformed", async () => {
    const forkInstant = "2026-08-01T05:00:00.000Z";
    const lines = [
      meta({ timestamp: forkInstant, forkedFromId: "parent" }),
      turnContext(forkInstant),
      // Copied parent history, written in one burst at the fork instant.
      tokenCount("2026-08-01T05:00:00.001Z", 100, 10),
      tokenCount("2026-08-01T05:00:00.002Z", 200, 20),
      // The child's own first turn, seconds later.
      tokenCount("2026-08-01T05:00:06.000Z", 300, 30),
    ].join("\n");

    const result = await withCodexTranscript(lines, (path) => readTranscriptRecords(path, "codex"));

    expect(result?.records).toHaveLength(1);
    expect(result?.records[0]?.totals.outputTokens).toBe(30);
    // The two copies were read perfectly; only their usage was declined.
    expect(result?.malformedRecords).toBe(0);
  });

  it("still reports a usage line it could not parse as malformed", async () => {
    const start = "2026-08-01T05:00:00.000Z";
    const lines = [
      meta({ timestamp: start }),
      turnContext(start),
      tokenCount("2026-08-01T05:00:01.000Z", 100, 10),
      // Truncated mid-write, as a crashed rollout leaves it.
      '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token',
    ].join("\n");

    const result = await withCodexTranscript(lines, (path) => readTranscriptRecords(path, "codex"));

    expect(result?.records).toHaveLength(1);
    expect(result?.malformedRecords).toBe(1);
  });

  it("reports an unreadable file as null rather than an empty read", async () => {
    expect(await readTranscriptRecords("/nonexistent/rollout.jsonl", "codex")).toBeNull();
  });
});
