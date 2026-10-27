/**
 * Fork: the `continuationKey` a native conversation was created under. `ProviderSwitchService`
 * compares this, not the owner's live key, so a reconfigured owner can't hand a conversation to
 * an instance that can't see it, and a removed owner's conversation still resumes on a sibling.
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
import * as SqlClient from "effect/sql/SqlClient";

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
   * Records the continuation identity the attaching runtime was opened with
   * for the provider thread's native conversation. The first record wins;
   * failures are logged, never raised, so recording can't break a session start.
   */
  readonly recordAttached: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly continuation: {
      readonly driver: ProviderDriverKind;
      readonly continuationKey: string;
    };
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

export const layer: Layer.Layer<NativeContinuationStore, never, SqlClient.SqlClient> = Layer.effect(
  NativeContinuationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Conversations already recorded by this process; skips a write per turn.
    const recorded = new Set<string>();

    return NativeContinuationStore.of({
      recordAttached: Effect.fn("NativeContinuationStore.recordAttached")(
        function* ({ providerInstanceId, providerThread, continuation }) {
          const nativeThreadId = providerThread.nativeThreadRef?.nativeId ?? null;
          if (nativeThreadId === null) return;
          const ref: NativeConversationRef = {
            providerInstanceId,
            driver: providerThread.driver,
            nativeThreadId,
          };
          const key = refKey(ref);
          if (recorded.has(key)) return;
          // An instance id can be recreated on another driver; never vouch
          // for a conversation the attaching runtime's driver didn't produce.
          if (continuation.driver !== providerThread.driver) return;
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO fork_native_continuation (
              provider_instance_id, driver, native_thread_id, continuation_key, recorded_at
            ) VALUES (
              ${ref.providerInstanceId}, ${ref.driver}, ${ref.nativeThreadId},
              ${continuation.continuationKey}, ${now}
            )
            ON CONFLICT DO NOTHING
          `;
          recorded.add(key);
        },
        (effect, { providerInstanceId, providerThread }) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.native-continuation.record-failed", {
                providerInstanceId,
                providerThreadId: providerThread.id,
                cause,
              }),
            ),
          ),
      ),
      get: Effect.fn("NativeContinuationStore.get")((ref) =>
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
      ),
    });
  }),
);
