/**
 * StrictResume — provider threads that continue a native session imported from
 * outside T3 Code. Their next turn must resume that session or fail visibly;
 * silently starting a fresh native session would drop the imported history
 * the user chose to continue.
 */
import type { ProviderThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";

export interface StrictResumeShape {
  readonly markStrict: (
    providerThreadId: ProviderThreadId,
  ) => Effect.Effect<void, SqlError.SqlError>;
  /** A failed read counts as strict, so the run fails visibly instead of replacing a possibly imported session. */
  readonly isStrict: (providerThreadId: ProviderThreadId) => Effect.Effect<boolean>;
}

export class StrictResume extends Context.Service<StrictResume, StrictResumeShape>()(
  "t3/sessionImport/StrictResume",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    markStrict: (providerThreadId) =>
      Effect.flatMap(DateTime.now, (now) =>
        sql`
          INSERT OR IGNORE INTO fork_strict_resume_provider_threads (provider_thread_id, created_at)
          VALUES (${providerThreadId}, ${DateTime.formatIso(now)})
        `.pipe(Effect.asVoid),
      ),
    isStrict: (providerThreadId) =>
      sql`
        SELECT 1 FROM fork_strict_resume_provider_threads
        WHERE provider_thread_id = ${providerThreadId}
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read strict-resume state", { providerThreadId, cause }).pipe(
            Effect.as(true),
          ),
        ),
      ),
  } satisfies StrictResumeShape;
});

export const layer = Layer.effect(StrictResume, make);
