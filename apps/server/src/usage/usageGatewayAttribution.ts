/**
 * Fork-local correction for usage routed through a model gateway.
 *
 * Provider attribution is decided by the transcript directory a record was
 * scanned from, so a Claude Code session that reached an OpenAI model through
 * the CLIProxyAPI gateway is recorded as Claude usage. It is not: those tokens
 * burn the Codex subscription pool, and the panel folding them into Claude
 * Code makes the provider split wrong on both sides.
 *
 * The model name is the reliable signal. Anthropic does not ship a `gpt-*`
 * model, so a `gpt-*` model in a Claude transcript can only have come from the
 * gateway routing the request to the OpenAI pool. Claude-named models stay with
 * Claude Code whether or not they went through the gateway, which is correct:
 * they bill against the Anthropic pool either way.
 *
 * @module usageGatewayAttribution
 */
import type { UsageRecord } from "./usageTranscripts.ts";

/**
 * Whether a model name belongs to OpenAI, tolerating a `vendor/` prefix some
 * gateway configurations expose.
 */
function isOpenAiModel(model: string): boolean {
  const name = model.toLowerCase();
  const bare = name.slice(name.lastIndexOf("/") + 1);
  return bare.startsWith("gpt-");
}

/**
 * Reassigns a gateway-routed record to the provider whose subscription it
 * actually spends. Every other record is returned unchanged, by identity.
 */
export function attributeGatewayUsage(record: UsageRecord): UsageRecord {
  if (record.provider !== "claude" || !isOpenAiModel(record.model)) return record;
  return { ...record, provider: "codex" };
}
