/**
 * Persisted continuation-key plumbing for provider runtime bindings.
 *
 * Provider session starts, forks, imports, and startup backfill stamp the owning instance's
 * `continuationIdentity.continuationKey` into `runtime_payload_json` so
 * continuation compatibility can still be proven after the owning instance
 * is renamed or deleted (the live registry can no longer be asked about an
 * instance id that no longer exists). Readers live in both `ProviderService`
 * (the persisted-cursor gate in `startSession`) and
 * `ProviderSessionDirectory` (the intra-continuation-group exemption from
 * owner-change state clearing), hence the shared module.
 *
 * @module provider/runtimeBindingContinuation
 */

export function readPersistedContinuationKey(
  runtimePayload: unknown | null | undefined,
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "continuationKey" in runtimePayload ? runtimePayload.continuationKey : undefined;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
