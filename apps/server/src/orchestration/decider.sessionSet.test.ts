import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type ThreadSessionExpectation,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(session: OrchestrationSession | null): OrchestrationReadModel {
  return {
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
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        deletedAt: null,
        messages: [],
        completedTurnAssistantMessageIds: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session,
      },
    ],
    updatedAt: NOW,
  };
}

function makeSession(
  status: OrchestrationSession["status"],
  activeTurnId: OrchestrationSession["activeTurnId"] = null,
): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId,
    lastError: null,
    updatedAt: NOW,
  };
}

function makeSessionSetCommand(
  session: OrchestrationSession,
  expectedSession?: ThreadSessionExpectation,
) {
  return {
    type: "thread.session.set",
    commandId: CommandId.make("cmd-session-set"),
    threadId: ThreadId.make("thread-1"),
    session,
    ...(expectedSession !== undefined ? { expectedSession } : {}),
    createdAt: NOW,
  } as const;
}

it.layer(NodeServices.layer)("session set compare-and-set decider", (it) => {
  it.effect("applies a guarded write while the observed session still holds", () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("turn-1");
      const result = yield* decideOrchestrationCommand({
        command: makeSessionSetCommand(makeSession("running", turnId), {
          status: "running",
          activeTurnId: turnId,
        }),
        readModel: makeReadModel(makeSession("running", turnId)),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );

  it.effect("drops a guarded write when the session status moved on", () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("turn-1");
      // The revive race: a failed-steer recovery observed a running session,
      // but interrupt-failure recovery stopped it before the write landed.
      const error = yield* decideOrchestrationCommand({
        command: makeSessionSetCommand(makeSession("running", turnId), {
          status: "running",
          activeTurnId: turnId,
        }),
        readModel: makeReadModel(makeSession("stopped", null)),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");

      const absentError = yield* decideOrchestrationCommand({
        command: makeSessionSetCommand(makeSession("running", turnId), {
          status: "running",
          activeTurnId: turnId,
        }),
        readModel: makeReadModel(null),
      }).pipe(Effect.flip);
      expect(absentError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("drops a guarded write when the active turn changed under it", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: makeSessionSetCommand(makeSession("running", TurnId.make("turn-1")), {
          status: "running",
          activeTurnId: TurnId.make("turn-1"),
        }),
        readModel: makeReadModel(makeSession("running", TurnId.make("turn-2"))),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("treats a null expectation as 'no session yet'", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: makeSessionSetCommand(makeSession("error"), null),
        readModel: makeReadModel(null),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);

      const error = yield* decideOrchestrationCommand({
        command: makeSessionSetCommand(makeSession("error"), null),
        readModel: makeReadModel(makeSession("running", TurnId.make("turn-1"))),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("leaves unguarded writes unconditional", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: makeSessionSetCommand(makeSession("running", TurnId.make("turn-1"))),
        readModel: makeReadModel(makeSession("stopped", null)),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );
});
