/**
 * Usage history for Claude Code: the transcript format of its
 * `<home>/projects/**.jsonl` session files and where each instance keeps them.
 *
 * @module provider/Drivers/claudeUsage
 */

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  parseTimestampMs,
  tokenCount,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";

import { resolveClaudeConfigDirPath } from "./ClaudeHome.ts";

/**
 * Parses one line of a Claude Code transcript.
 *
 * Claude Code writes one record per assistant *content block*, each carrying
 * the parent message's `usage` as known when the block was written. Summing
 * them overcounts by roughly 2.4x on a real workload, so the caller keeps one
 * record per `dedupeKey`.
 *
 * Anthropic reports the input and cache split at message start, so native
 * records already carry it. A model proxied through an Anthropic-compatible
 * gateway such as CLIProxyAPI reports usage only when the response completes.
 * Until then, Claude Code writes its own prompt-size estimate as `input_tokens`
 * with zero output and no cache fields. Only a record written after the
 * completion has the real usage, and roughly one message in five never gets
 * one, even though the request completed.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseClaudeRecord(parsed);
}

function parseClaudeRecord(parsed: unknown): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  // Matches ccusage: prefer the message/request pair, fall back to whichever
  // half exists. Records with neither cannot be de-duplicated.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];
  const inputTokens = tokenCount(usageRecord["input_tokens"]);
  const outputTokens = tokenCount(usageRecord["output_tokens"]);
  // Claude Code fills the cache fields in once real usage arrives, so their
  // absence with no output marks the placeholder estimate.
  const provisional = !("cache_read_input_tokens" in usageRecord) && outputTokens === 0;

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      // The estimate covers the whole prompt. Proxied requests that report
      // usage read about 96% of it from cache, so counting it as uncached
      // would bill a guess at full price.
      uncachedInputTokens: provisional ? 0 : inputTokens,
      cachedInputTokens: provisional
        ? inputTokens
        : tokenCount(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: tokenCount(usageRecord["cache_creation_input_tokens"]),
      outputTokens,
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
    dedupeKey,
    ...(provisional ? { provisional: true as const } : {}),
  };
}

const orEmpty = (record: UsageRecord | null): readonly UsageRecord[] =>
  record === null ? [] : [record];

export const claudeUsageFormat: TranscriptUsageFormat<void> = {
  // Keeps the dedupe and cost metadata. The `usage` subtree keeps future token fields.
  selectFields: {
    type: true,
    timestamp: true,
    requestId: true,
    sessionId: true,
    costUSD: true,
    message: { id: true, model: true, usage: true },
  },
  mightCarryUsage: (line) => line.includes('"usage"'),
  parseLine: (line) => orEmpty(parseClaudeLine(line)),
  parseProjected: (projected) => orEmpty(parseClaudeRecord(projected)),
  malformed: { carriesUsage: (text) => text.includes('"usage"') },
};

export const claudeUsageReader: ProviderUsageReader<ClaudeSettings, Path.Path> = {
  kind: "transcripts",
  provider: "claude",
  format: claudeUsageFormat,
  directories: Effect.fn("claudeUsageReader.directories")(function* ({ config, environment }) {
    // An undecodable config has no trustworthy home to read.
    if (config === undefined) return [];
    const path = yield* Path.Path;
    // Shadow config dirs link `projects` back to this shared config dir, so it
    // is the one transcript source; walking both would read them twice.
    const configDir = yield* resolveClaudeConfigDirPath(config, environment);
    return [{ dir: path.join(configDir, "projects") }];
  }),
};
