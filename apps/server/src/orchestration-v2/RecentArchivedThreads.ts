/**
 * Fork: the bounded recent-archive window behind the clients' always-mounted
 * archive shelves (web sidebar, mobile home and split sidebar). Reads only the
 * newest archived root threads as full v2 shells (latest run, PR links and
 * archive request included) plus the unclipped total, so a large archive
 * never ships to a shelf that shows a handful of rows. The full archive stays
 * on `getArchivedShellSnapshot` for the Settings archive.
 */
import {
  OrchestrationV2GetShellSnapshotError,
  type OrchestrationV2GetRecentArchivedThreadsInput,
  type OrchestrationV2RecentArchivedThreads,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  archivedRootThreadCondition,
  ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
  ProjectionStoreV2,
} from "./ProjectionStore.ts";

export class RecentArchivedThreads extends Context.Service<
  RecentArchivedThreads,
  {
    /** Newest archived root threads first; `projectIds: []` matches nothing. */
    readonly get: (
      input: OrchestrationV2GetRecentArchivedThreadsInput,
    ) => Effect.Effect<OrchestrationV2RecentArchivedThreads, OrchestrationV2GetShellSnapshotError>;
  }
>()("t3/orchestration-v2/RecentArchivedThreads") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStoreV2;

  const get: RecentArchivedThreads["Service"]["get"] = (input) =>
    input.projectIds?.length === 0
      ? Effect.succeed({
          schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
          snapshotSequence: 0,
          threads: [],
          totalArchivedCount: 0,
        })
      : sql
          .withTransaction(
            Effect.gen(function* () {
              const snapshot = yield* projections.getShellSnapshot({
                location: "archive",
                archiveWindow: {
                  limit: input.limit,
                  ...(input.projectIds === undefined ? {} : { projectIds: input.projectIds }),
                },
              });
              const [count] = yield* sql<{ readonly total: number }>`
                SELECT COUNT(*) AS total
                FROM orchestration_v2_projection_threads w
                WHERE ${archivedRootThreadCondition(sql, input.projectIds)}
              `;
              return {
                schemaVersion: snapshot.schemaVersion,
                snapshotSequence: snapshot.snapshotSequence,
                threads: snapshot.archivedThreads.toSorted(
                  (left, right) =>
                    archivedAtMillis(right) - archivedAtMillis(left) ||
                    right.id.localeCompare(left.id),
                ),
                totalArchivedCount: count?.total ?? 0,
              };
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed to load recent archived threads",
                  cause,
                }),
            ),
          );

  return RecentArchivedThreads.of({ get });
});

const archivedAtMillis = (thread: { readonly archivedAt: DateTime.Utc | null }) =>
  thread.archivedAt === null ? 0 : DateTime.toEpochMillis(thread.archivedAt);

export const layer = Layer.effect(RecentArchivedThreads, make);
