/**
 * Fork: the continuation group each native provider conversation lives in.
 *
 * Instances that share a `continuationKey` (Claude shadow accounts on one
 * shared config dir, Codex instances on one home) can resume each other's
 * native conversations, so an account switch keeps native context. The live
 * key only describes an instance's current config, though; a conversation
 * stays where it was created. `ProviderSessionManager` records the owner's key
 * when a session first attaches a native conversation, and
 * `ProviderSwitchService` compares that recorded key, not the owner's live
 * one, when a switch moves the conversation to another instance. A
 * reconfigured owner therefore can't hand a conversation to an instance that
 * can't see it, and a removed owner's conversation still resumes on a
 * compatible sibling. Without a record the switch falls back to the live
 * owner, and with neither it hands context off instead of resuming natively.
 *
 * @module orchestration-v2/NativeContinuationStore
 */
import {
  type OrchestrationV2ProviderThread,
  type ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { defaultProviderContinuationIdentity } from "../provider/ProviderDriver.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";

export class NativeContinuationReadError extends Schema.TaggedError<NativeContinuationReadError>()(
  "NativeContinuationReadError",
  { providerInstanceId: ProviderInstanceId, cause: Schema.Defect() },
) {}

export interface NativeConversationRef {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly nativeThreadId: string;
}

export interface NativeContinuationStoreShape {
  /**
   * Records the attaching instance's live continuation key for the provider
   * thread's native conversation. The first record wins; failures are logged,
   * never raised, so recording can't break a session start.
   */
  readonly recordAttached: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerThread: OrchestrationV2ProviderThread;
  }) => Effect.Effect<void>;
  /** The recorded continuation key of one native conversation, if any. */
  readonly get: (
    ref: NativeConversationRef,
  ) => Effect.Effect<Option.Option<string>, NativeContinuationReadError>;
}

export class NativeContinuationStore extends Context.Service<
  NativeContinuationStore,
  NativeContinuationStoreShape
>()("t3/orchestration-v2/NativeContinuationStore") {}

const refKey = (ref: NativeConversationRef) =>
  `${ref.providerInstanceId}\u0000${ref.driver}\u0000${ref.nativeThreadId}`;

export const layer: Layer.Layer<
  NativeContinuationStore,
  never,
  SqlClient.SqlClient | ProviderAdapterRegistry.ProviderAdapterRegistryV2
> = Layer.effect(
  NativeContinuationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    // Conversations already recorded by this process; skips a write per turn.
    const recorded = new Set<string>();

    const liveContinuationKey = (providerInstanceId: ProviderInstanceId) =>
      registry.getMetadata !== undefined
        ? registry
            .getMetadata(providerInstanceId)
            .pipe(Effect.map(({ driver, continuationKey }) => ({ driver, continuationKey })))
        : registry.get(providerInstanceId).pipe(
            Effect.map((adapter) => ({
              driver: adapter.driver,
              continuationKey: defaultProviderContinuationIdentity({
                driverKind: adapter.driver,
                instanceId: providerInstanceId,
              }).continuationKey,
            })),
          );

    return NativeContinuationStore.of({
      recordAttached: ({ providerInstanceId, providerThread }) =>
        Effect.gen(function* () {
          const nativeThreadId = providerThread.nativeThreadRef?.nativeId ?? null;
          if (nativeThreadId === null) return;
          const ref: NativeConversationRef = {
            providerInstanceId,
            driver: providerThread.driver,
            nativeThreadId,
          };
          const key = refKey(ref);
          if (recorded.has(key)) return;
          const live = yield* liveContinuationKey(providerInstanceId);
          // An instance id can be recreated on another driver; never vouch
          // for a conversation the live owner's driver didn't produce.
          if (live.driver !== providerThread.driver) return;
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO fork_native_continuation (
              provider_instance_id, driver, native_thread_id, continuation_key, recorded_at
            ) VALUES (
              ${ref.providerInstanceId}, ${ref.driver}, ${ref.nativeThreadId},
              ${live.continuationKey}, ${now}
            )
            ON CONFLICT DO NOTHING
          `;
          recorded.add(key);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.native-continuation.record-failed", {
              providerInstanceId,
              providerThreadId: providerThread.id,
              cause,
            }),
          ),
        ),
      get: (ref) =>
        sql<{ readonly continuation_key: string }>`
          SELECT continuation_key FROM fork_native_continuation
          WHERE provider_instance_id = ${ref.providerInstanceId}
            AND driver = ${ref.driver}
            AND native_thread_id = ${ref.nativeThreadId}
        `.pipe(
          Effect.map((rows) => Option.fromNullishOr(rows[0]?.continuation_key)),
          Effect.mapError(
            (cause) =>
              new NativeContinuationReadError({
                providerInstanceId: ref.providerInstanceId,
                cause,
              }),
          ),
        ),
    });
  }),
);
