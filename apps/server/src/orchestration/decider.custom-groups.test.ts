import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
// The Effect test clock starts at the epoch.
const SNOOZED_AT = "1969-12-31T00:00:00.000Z";
const FUTURE_WAKE = "1970-01-02T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function makeReadModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        pullRequests: [],
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        activeOrderKey: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        completedTurnAssistantMessageIds: [],
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        ...overrides,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("custom thread groups", (it) => {
  it.effect(
    "creates a thread directly in its chosen group and defaults legacy creation to Active",
    () =>
      Effect.gen(function* () {
        let readModel = createEmptyReadModel(NOW);
        const project = yield* decideOrchestrationCommand({
          readModel,
          command: {
            type: "project.create",
            commandId: CommandId.make("create-project"),
            projectId: ProjectId.make("project-1"),
            title: "Project",
            workspaceRoot: "/tmp/project",
            createdAt: NOW,
          },
        });
        for (const event of Array.isArray(project) ? project : [project]) {
          readModel = yield* projectEvent(readModel, {
            ...event,
            sequence: readModel.snapshotSequence + 1,
          });
        }
        for (const customGroupId of ["research", null, undefined]) {
          const threadId = ThreadId.make(`thread-${customGroupId}`);
          const decided = yield* decideOrchestrationCommand({
            readModel,
            command: {
              type: "thread.create",
              commandId: CommandId.make(`create-${customGroupId}`),
              threadId,
              projectId: ProjectId.make("project-1"),
              title: "Thread",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: NOW,
              ...(customGroupId !== undefined ? { customGroupId } : {}),
            },
          });
          for (const event of Array.isArray(decided) ? decided : [decided]) {
            expect(event.type).toBe("thread.created");
            readModel = yield* projectEvent(readModel, {
              ...event,
              sequence: readModel.snapshotSequence + 1,
            });
          }
          expect(readModel.threads.find((thread) => thread.id === threadId)).toMatchObject({
            customGroupId: customGroupId ?? null,
            settledOverride: null,
          });
        }
      }),
  );

  it.effect("assigns, moves and clears a group without changing lifecycle or activity", () =>
    Effect.gen(function* () {
      let readModel = makeReadModel({
        pinnedAt: NOW,
        snoozedAt: SNOOZED_AT,
        snoozedUntil: FUTURE_WAKE,
        activeOrderKey: "m",
      });
      for (const customGroupId of ["research", "parked", null]) {
        const decided = yield* decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make(`group-${customGroupId}`),
            threadId: THREAD_ID,
            customGroupId,
          },
        });
        for (const event of Array.isArray(decided) ? decided : [decided])
          readModel = yield* projectEvent(readModel, {
            ...event,
            sequence: readModel.snapshotSequence + 1,
          });
        expect(readModel.threads[0]).toMatchObject({
          customGroupId,
          updatedAt: NOW,
          pinnedAt: NOW,
          snoozedAt: SNOOZED_AT,
          snoozedUntil: FUTURE_WAKE,
          activeOrderKey: "m",
        });
      }
    }),
  );
});
