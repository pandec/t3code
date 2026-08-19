/**
 * Which pooled gateway account serves a thread's provider session.
 *
 * The `CURRENT`-style marker a usage popover can derive client-side from
 * account priorities only answers "which account would a *new* session bind
 * to" — the gateway's session-affinity table is sticky, so the account a
 * running thread actually spends can differ once tiers change or an account
 * recovers from cooldown. This module answers the real question by reading
 * that binding: it resolves the thread's persisted provider session id and
 * gateway target, then asks the gateway which credential the session is bound
 * to for the thread's model (see `probeCliProxyApiSessionAccount`).
 *
 * Scoped to Claude sessions deliberately: the gateway keys Claude affinity on
 * the session UUID T3 already persists in the thread's resume cursor, while
 * other providers carry no session identity the gateway would recognize.
 * Every unsupported or failed path answers null — the marker is best-effort
 * and clients render "unknown" by simply not showing it.
 *
 * @module provider/threadGatewayAccount
 */
import type {
  ProviderUsageThreadAccountInput,
  ProviderUsageThreadAccountResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import {
  probeCliProxyApiSessionAccount,
  resolveCliProxyApiUsageProbeTarget,
} from "./cliProxyApiUsage.ts";
import { isUuid } from "./Layers/ClaudeAdapter.ts";
import type { ProviderInstanceRegistryShape } from "./Services/ProviderInstanceRegistry.ts";
import type { ProviderSessionDirectoryShape } from "./Services/ProviderSessionDirectory.ts";

/**
 * A binding row idle longer than this is treated as absent. The gateway's
 * session-affinity TTL (an hour, sliding) has certainly lapsed by then, so a
 * probe would not read an existing binding — it would create a fresh one for
 * a session that may never run again, and report the cold pick as "current".
 */
const BINDING_FRESHNESS_MS = 60 * 60 * 1_000;

/**
 * The Claude session UUID out of a persisted resume cursor, mirroring the
 * adapter's own resume-state read: `resume` wins over the legacy `sessionId`
 * slot, and anything the adapter's `isUuid` would refuse to resume is treated
 * as absent rather than sent to the gateway.
 */
export function claudeSessionIdFromResumeCursor(resumeCursor: unknown): string | null {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return null;
  }
  const cursor = resumeCursor as { resume?: unknown; sessionId?: unknown };
  const candidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : null;
  return candidate !== null && isUuid(candidate) ? candidate : null;
}

export interface ThreadGatewayAccountDependencies {
  readonly sessionDirectory: Pick<ProviderSessionDirectoryShape, "getBinding">;
  readonly instanceRegistry: Pick<ProviderInstanceRegistryShape, "getInstanceConfig">;
  readonly httpClient: HttpClient.HttpClient;
}

/**
 * Build the `providerUsage.threadAccount` reader. Never fails: a thread
 * without a binding, a non-Claude provider, a non-gateway instance, and a
 * probe error all answer `{ authIndex: null }`.
 */
export function makeThreadGatewayAccountReader(dependencies: ThreadGatewayAccountDependencies) {
  return (
    input: ProviderUsageThreadAccountInput,
  ): Effect.Effect<ProviderUsageThreadAccountResult> =>
    Effect.gen(function* () {
      const none: ProviderUsageThreadAccountResult = { authIndex: null };
      const binding = Option.getOrUndefined(
        yield* dependencies.sessionDirectory
          .getBinding(input.threadId)
          .pipe(Effect.orElseSucceed(() => Option.none())),
      );
      if (binding === undefined || binding.provider !== "claudeAgent") return none;
      // A stopped or errored runtime has no live session to read a binding
      // for — the reaper stops sessions well inside the freshness window, and
      // probing one would bind a dead session to a pooled account.
      if (binding.status === "stopped" || binding.status === "error") return none;
      // A long-idle binding's gateway entry has expired, so probing would not
      // read anything — it would bind a dead session and mislabel the pool's
      // cold pick as "current". Unparseable timestamps count as idle.
      const nowMs = yield* Clock.currentTimeMillis;
      const idleMs = nowMs - Date.parse(binding.lastSeenAt);
      if (!Number.isFinite(idleMs) || idleMs > BINDING_FRESHNESS_MS) return none;
      const sessionId = claudeSessionIdFromResumeCursor(binding.resumeCursor);
      if (sessionId === null || binding.providerInstanceId === undefined) return none;
      const envelope = yield* (
        dependencies.instanceRegistry.getInstanceConfig?.(binding.providerInstanceId) ??
          Effect.succeed(undefined)
      );
      if (envelope === undefined) return none;
      const target = resolveCliProxyApiUsageProbeTarget(envelope, binding.provider);
      if (target === null) return none;
      const authIndex = yield* probeCliProxyApiSessionAccount(target, {
        sessionId,
        model: input.model,
      }).pipe(Effect.provideService(HttpClient.HttpClient, dependencies.httpClient));
      return { authIndex };
    });
}
