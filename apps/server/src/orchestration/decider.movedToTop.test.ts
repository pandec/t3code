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
import { projectEvent } from "./projector.ts";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";
const MOVED_TO_TOP_AT = "2099-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      movedToTopAt: null,
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

it.layer(NodeServices.layer)("move-to-top decider", (it) => {
  it.effect("emits the supplied timestamp without changing thread updatedAt", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.move-to-top",
          commandId: CommandId.make("cmd-move-to-top"),
          threadId: ThreadId.make("thread-1"),
          movedToTopAt: MOVED_TO_TOP_AT,
        },
        readModel,
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("thread.moved-to-top");
      if (event?.type !== "thread.moved-to-top") return;
      expect(event.payload.movedToTopAt).toBe(MOVED_TO_TOP_AT);

      const projected = yield* projectEvent(readModel, { ...event, sequence: 1 });
      expect(projected.threads[0]?.movedToTopAt).toBe(MOVED_TO_TOP_AT);
      expect(projected.threads[0]?.updatedAt).toBe(UPDATED_AT);
    }),
  );
});
