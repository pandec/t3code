import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RecentArchivedThreads from "./RecentArchivedThreads.ts";

const TestLayer = RecentArchivedThreads.layer.pipe(
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const thread = (
  id: string,
  projectId: ProjectId,
  overrides: {
    readonly archivedMinute?: number;
    readonly deleted?: boolean;
    readonly subagentOf?: string;
    readonly pullRequest?: number;
  } = {},
): OrchestrationV2DomainEvent => {
  const threadId = ThreadId.make(id);
  return {
    id: EventId.make(`created:${id}`),
    type: "thread.created",
    threadId,
    providerInstanceId,
    occurredAt: at(0),
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: id,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(overrides.pullRequest === undefined
        ? {}
        : {
            linkedPullRequest: {
              projectId,
              repository: "acme/app",
              number: overrides.pullRequest,
              url: `https://github.com/acme/app/pull/${overrides.pullRequest}`,
            },
          }),
      activeProviderThreadId: null,
      lineage:
        overrides.subagentOf === undefined
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }
          : {
              parentThreadId: ThreadId.make(overrides.subagentOf),
              relationshipToParent: "subagent",
              rootThreadId: ThreadId.make(overrides.subagentOf),
            },
      forkedFrom: null,
      createdAt: at(0),
      updatedAt: at(0),
      archivedAt: overrides.archivedMinute === undefined ? null : at(overrides.archivedMinute),
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: overrides.deleted === true ? at(30) : null,
    },
  };
};

const seed = Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
  Effect.forEach(
    [
      thread("active-a", projectA),
      thread("archived-a-old", projectA, { archivedMinute: 1 }),
      thread("archived-a-new", projectA, { archivedMinute: 9, pullRequest: 42 }),
      thread("archived-b-mid", projectB, { archivedMinute: 5 }),
      thread("archived-b-newest", projectB, { archivedMinute: 12 }),
      thread("archived-deleted", projectA, { archivedMinute: 20, deleted: true }),
      thread("archived-subagent", projectA, {
        archivedMinute: 21,
        subagentOf: "archived-a-new",
      }),
    ],
    (event) => projections.apply(event),
    { discard: true },
  ),
);

const ids = (result: { readonly threads: ReadonlyArray<{ readonly id: ThreadId }> }) =>
  result.threads.map((shell) => shell.id);

it.layer(TestLayer)("RecentArchivedThreads", (it) => {
  it.effect(
    "returns the newest archived root threads, their PR metadata and the filtered total",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const recent = yield* RecentArchivedThreads.RecentArchivedThreads;

        const window = yield* recent.get({ limit: 2 });
        assert.deepStrictEqual(ids(window), ["archived-b-newest", "archived-a-new"]);
        // Deleted and subagent threads are neither listed nor counted.
        assert.strictEqual(window.totalArchivedCount, 4);
        assert.strictEqual(window.threads[1]?.linkedPullRequest?.number, 42);

        const everything = yield* recent.get({ limit: 50 });
        assert.deepStrictEqual(ids(everything), [
          "archived-b-newest",
          "archived-a-new",
          "archived-b-mid",
          "archived-a-old",
        ]);

        // The project filter bounds the window and the total alike.
        const filtered = yield* recent.get({ limit: 1, projectIds: [projectA] });
        assert.deepStrictEqual(ids(filtered), ["archived-a-new"]);
        assert.strictEqual(filtered.totalArchivedCount, 2);

        const none = yield* recent.get({ limit: 10, projectIds: [] });
        assert.deepStrictEqual(ids(none), []);
        assert.strictEqual(none.totalArchivedCount, 0);
      }),
  );
});
