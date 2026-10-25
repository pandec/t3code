/**
 * Fork: a `gpt-*` model in a Claude transcript, or `claude-*` in a Codex rollout, was routed by the
 * CLIProxyAPI gateway and spent the other subscription pool, so it is reattributed. Applied when
 * merging, after source ownership is settled, so it cannot drop or double count buckets.
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
