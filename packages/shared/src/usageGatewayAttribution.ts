/**
 * Fork-local correction for usage routed through a model gateway.
 *
 * An environment attributes usage by the transcript directory it scanned, so a
 * Claude Code session that reached an OpenAI model through the CLIProxyAPI
 * gateway is reported as Claude usage. It is not: those tokens burn the Codex
 * subscription pool. The gateway is bound in both directions, so the same
 * happens in reverse when a Codex session reaches an Anthropic model.
 *
 * The model name is the reliable signal. Neither vendor ships a model named
 * after the other, so a `gpt-*` model in a Claude transcript, or a `claude-*`
 * model in a Codex rollout, can only have come from the gateway routing that
 * request to the other pool.
 *
 * This is applied when merging, deliberately not when scanning. A summary's
 * buckets are claimed through the providers of the sources their environment
 * owns, so moving a bucket to a provider its directory reports no source for
 * would either drop it or, once a source is invented to hold it, hand that
 * environment every bucket of that provider and double count. Correcting after
 * ownership has been settled leaves that arithmetic untouched, and works
 * against environments running any server version.
 *
 * @module usageGatewayAttribution
 */
import type { UsageBucket, UsageProviderKind } from "@t3tools/contracts";

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
 * Credits a bucket to the provider whose subscription its model spends. Any
 * other bucket is returned unchanged, by identity.
 */
export function attributeGatewayBucket(bucket: UsageBucket): UsageBucket {
  const pool = modelPool(bucket.model);
  if (pool === null || pool === bucket.provider) return bucket;
  return { ...bucket, provider: pool };
}
