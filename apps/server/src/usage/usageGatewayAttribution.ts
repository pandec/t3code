/**
 * Fork-local correction for usage routed through a model gateway.
 *
 * Provider attribution is decided by the transcript directory a record was
 * scanned from, so a Claude Code session that reached an OpenAI model through
 * the CLIProxyAPI gateway is recorded as Claude usage. It is not: those tokens
 * burn the Codex subscription pool, and the panel folding them into Claude
 * Code makes the provider split wrong on both sides. The gateway is bound in
 * both directions here, so the same happens in reverse when a Codex session
 * reaches an Anthropic model.
 *
 * The model name is the reliable signal. Neither vendor ships a model named
 * after the other, so a `gpt-*` model in a Claude transcript, or a `claude-*`
 * model in a Codex rollout, can only have come from the gateway routing that
 * request to the other pool.
 *
 * @module usageGatewayAttribution
 */
import type { UsageProviderKind } from "@t3tools/contracts";

import type { UsageRecord } from "./usageTranscripts.ts";

/**
 * The pool a model name belongs to, or `null` when the name says nothing.
 *
 * A `vendor/` prefix is tolerated because some gateway configurations expose
 * models that way.
 */
function modelPool(model: string): UsageProviderKind | null {
  const name = model.toLowerCase();
  const bare = name.slice(name.lastIndexOf("/") + 1);
  if (bare.startsWith("gpt-")) return "codex";
  if (bare.startsWith("claude-")) return "claude";
  return null;
}

/**
 * Reassigns a gateway-routed record to the provider whose subscription it
 * actually spends. Every other record is returned unchanged, by identity, so
 * callers can compare references to detect a reassignment.
 */
export function attributeGatewayUsage(record: UsageRecord): UsageRecord {
  const pool = modelPool(record.model);
  if (pool === null || pool === record.provider) return record;
  return { ...record, provider: pool };
}
