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

// Claude Code uses this model for local placeholders that never reached the API.
export const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";
const SYNTHETIC_MODEL_FIELD = `"model":${JSON.stringify(CLAUDE_SYNTHETIC_MODEL)}`;

/**
 * Claude Code writes one record per content block, each repeating the message's
 * usage, so the caller keeps the one with most output per `dedupeKey`. Proxied
 * models report nothing until completion (earlier records hold a prompt-size
 * estimate), and about one proxied message in five never gets a completed record.
 */
export function parseClaudeLine(line: string): readonly UsageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  return parseClaudeRecord(parsed);
}

function parseClaudeRecord(parsed: unknown): readonly UsageRecord[] {
  if (typeof parsed !== "object" || parsed === null) return [];

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return [];

  const message = record["message"];
  if (typeof message !== "object" || message === null) return [];
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return [];
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return [];

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0 || model === CLAUDE_SYNTHETIC_MODEL) return [];

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];
  const inputTokens = tokenCount(usageRecord["input_tokens"]);
  const outputTokens = tokenCount(usageRecord["output_tokens"]);
  const cacheCreationTokens = tokenCount(usageRecord["cache_creation_input_tokens"]);
  const oneHourCacheCreationTokens = Math.min(
    cacheCreationTokens,
    tokenCount(nested(usageRecord["cache_creation"])["ephemeral_1h_input_tokens"]),
  );
  // Claude Code fills the cache fields in once real usage arrives, and always
  // writes the output count, so a record with neither cache field and no
  // output is the placeholder estimate.
  const provisional =
    !("cache_read_input_tokens" in usageRecord) &&
    !("cache_creation_input_tokens" in usageRecord) &&
    outputTokens === 0;

  const executor: UsageRecord = {
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
      cacheCreationTokens,
      outputTokens,
      // Thinking is billed as output; Claude Code breaks it out on completion.
      reasoningTokens: Math.min(
        outputTokens,
        tokenCount(nested(usageRecord["output_tokens_details"])["thinking_tokens"]),
      ),
    },
    ...(oneHourCacheCreationTokens > 0 ? { oneHourCacheCreationTokens } : {}),
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
    dedupeKey,
    ...(provisional ? { provisional: true as const } : {}),
  };

  // Top-level `usage` is the executor's alone. Advisor calls run on another model at its own rates
  // and appear only in `iterations`, so each one is its own record under that model.
  const records = [executor];
  const iterations: readonly unknown[] = Array.isArray(usageRecord["iterations"])
    ? usageRecord["iterations"]
    : [];
  for (const [index, iteration] of iterations.entries()) {
    if (typeof iteration !== "object" || iteration === null) continue;
    const advisor = iteration as Record<string, unknown>;
    if (advisor["type"] !== "advisor_message") continue;

    const advisorModel = typeof advisor["model"] === "string" ? advisor["model"] : "";
    if (advisorModel.length === 0 || advisorModel === CLAUDE_SYNTHETIC_MODEL) continue;

    records.push({
      provider: "claude",
      timestampMs,
      model: advisorModel,
      sessionId: executor.sessionId,
      totals: {
        uncachedInputTokens: tokenCount(advisor["input_tokens"]),
        cachedInputTokens: tokenCount(advisor["cache_read_input_tokens"]),
        cacheCreationTokens: tokenCount(advisor["cache_creation_input_tokens"]),
        outputTokens: tokenCount(advisor["output_tokens"]),
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      speed: executor.speed,
      dedupeKey: dedupeKey === null ? null : `${dedupeKey}:advisor:${index}`,
    });
  }
  return records;
}

function nested(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export const claudeUsageFormat: TranscriptUsageFormat<void> = {
  selectFields: {
    type: true,
    timestamp: true,
    requestId: true,
    sessionId: true,
    costUSD: true,
    message: { id: true, model: true, usage: true },
  },
  usageMarkers: ['"usage"'],
  parseLine: (line) => parseClaudeLine(line),
  parseProjected: (projected) => parseClaudeRecord(projected),
  // A local placeholder carries usage but is skipped on purpose.
  malformed: {
    carriesUsage: (text) => text.includes('"usage"') && !text.includes(SYNTHETIC_MODEL_FIELD),
  },
};

export const claudeUsageReader: ProviderUsageReader<ClaudeSettings, Path.Path> = {
  kind: "transcripts",
  provider: "claude",
  format: claudeUsageFormat,
  directories: Effect.fn("claudeUsageReader.directories")(function* ({ config, environment }) {
    if (config === undefined) return [];
    const path = yield* Path.Path;
    // Shadow config dirs link `projects` back to this shared config dir, so it
    // is the one transcript source; walking both would read them twice.
    const configDir = yield* resolveClaudeConfigDirPath(config, environment);
    return [{ dir: path.join(configDir, "projects") }];
  }),
};
