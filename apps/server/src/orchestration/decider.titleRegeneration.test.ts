import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Manual title",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      completedTurnAssistantMessageIds: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: UPDATED_AT,
};

it.layer(NodeServices.layer)("title regeneration decider", (it) => {
  it.effect("creates explicit placeholder titles with manual ownership atomically", () =>
    Effect.gen(function* () {
      const thread = readModel.threads[0]!;
      const commandId = CommandId.make("explicit-title-create");
      const created = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId,
          threadId: thread.id,
          projectId: thread.projectId,
          title: "New thread",
          titleSource: "manual",
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt: UPDATED_AT,
        },
        readModel: {
          ...readModel,
          threads: [],
          projects: [
            {
              id: thread.projectId,
              title: "Project",
              workspaceRoot: "/tmp/project",
              defaultModelSelection: null,
              scripts: [],
              createdAt: UPDATED_AT,
              updatedAt: UPDATED_AT,
              deletedAt: null,
            },
          ],
        },
      });
      const event = Array.isArray(created) ? created[0]! : created;
      expect(event.payload).toMatchObject({
        title: "New thread",
        titleState: { source: "manual", version: commandId, needsRefinement: false },
      });
      const completed = yield* decideOrchestrationCommand({
        command: {
          type: "thread.title.generate.complete",
          commandId: CommandId.make("automatic-title"),
          threadId: thread.id,
          expectedTitle: "New thread",
          expectedVersion: commandId,
          title: "Generated title",
          needsRefinement: true,
        },
        readModel: {
          ...readModel,
          threads: [
            {
              ...thread,
              title: "New thread",
              titleState: { source: "manual", version: commandId, needsRefinement: false },
            },
          ],
        },
      });
      const completion = Array.isArray(completed) ? completed[0]! : completed;
      expect(completion.payload).toEqual({ threadId: thread.id, updatedAt: UPDATED_AT });
    }),
  );

  it.effect("preserves updatedAt for a stale completion", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.title.regeneration.complete",
          commandId: CommandId.make("cmd-regeneration-complete"),
          threadId: ThreadId.make("thread-1"),
          requestId: CommandId.make("cmd-old-regeneration-request"),
          title: "Generated title",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload).toEqual({
          threadId: ThreadId.make("thread-1"),
          updatedAt: UPDATED_AT,
        });
      }
    }),
  );

  it.effect("rejects an initial result after a manual rename to the same text", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.title.generate.complete",
          commandId: CommandId.make("generated"),
          threadId: ThreadId.make("thread-1"),
          expectedTitle: "Manual title",
          expectedVersion: null,
          title: "Automatic title",
          needsRefinement: true,
        },
        readModel: {
          ...readModel,
          threads: readModel.threads.map((thread) => ({
            ...thread,
            titleState: {
              source: "manual" as const,
              version: CommandId.make("manual"),
              needsRefinement: false,
            },
          })),
        },
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.payload).toEqual({ threadId: ThreadId.make("thread-1"), updatedAt: UPDATED_AT });
    }),
  );

  it.effect("records manual ownership even when the title text does not change", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("manual-rename"),
          threadId: ThreadId.make("thread-1"),
          title: "Manual title",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.payload).toMatchObject({
        titleState: { source: "manual", version: "manual-rename", needsRefinement: false },
      });
    }),
  );
});
