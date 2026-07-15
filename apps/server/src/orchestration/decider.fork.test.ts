import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const sourceThreadId = ThreadId.make("source-thread");

const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: EventId.make("event-project"),
    aggregateKind: "project",
    aggregateId: ProjectId.make("project"),
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("command-project"),
    causationEventId: null,
    correlationId: CommandId.make("command-project"),
    metadata: {},
    payload: {
      projectId: ProjectId.make("project"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  const withThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("event-thread"),
    aggregateKind: "thread",
    aggregateId: sourceThreadId,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("command-thread"),
    causationEventId: null,
    correlationId: CommandId.make("command-thread"),
    metadata: {},
    payload: {
      threadId: sourceThreadId,
      projectId: ProjectId.make("project"),
      title: "Source",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex-instance"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: "dev",
      worktreePath: "/tmp/project",
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(withThread, {
    sequence: 3,
    eventId: EventId.make("event-session"),
    aggregateKind: "thread",
    aggregateId: sourceThreadId,
    type: "thread.session-set",
    occurredAt: now,
    commandId: CommandId.make("command-session"),
    causationEventId: null,
    correlationId: CommandId.make("command-session"),
    metadata: {},
    payload: {
      threadId: sourceThreadId,
      session: {
        threadId: sourceThreadId,
        status: "stopped",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex-instance"),
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    },
  });
});

it.layer(NodeServices.layer)("thread fork decider", (it) => {
  it.effect("copies thread settings and starts provider fork setup", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        readModel: yield* seedReadModel,
        command: {
          type: "thread.fork",
          commandId: CommandId.make("command-fork"),
          sourceThreadId,
          threadId: ThreadId.make("destination-thread"),
          createdAt: now,
        },
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.session-set",
        "thread.fork-requested",
      ]);
      const created = events[0];
      expect(created?.type).toBe("thread.created");
      if (created?.type === "thread.created") {
        expect(created.payload).toMatchObject({
          title: "Source (fork)",
          branch: "dev",
          worktreePath: "/tmp/project",
          runtimeMode: "full-access",
        });
      }
    }),
  );

  it.effect("rejects a fork while the source provider session is running", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      readModel = yield* projectEvent(readModel, {
        sequence: 4,
        eventId: EventId.make("event-session-running"),
        aggregateKind: "thread",
        aggregateId: sourceThreadId,
        type: "thread.session-set",
        occurredAt: now,
        commandId: CommandId.make("command-session-running"),
        causationEventId: null,
        correlationId: CommandId.make("command-session-running"),
        metadata: {},
        payload: {
          threadId: sourceThreadId,
          session: {
            threadId: sourceThreadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex-instance"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      });

      const error = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.fork",
          commandId: CommandId.make("command-fork-busy"),
          sourceThreadId,
          threadId: ThreadId.make("destination-busy"),
          createdAt: now,
        },
      }).pipe(Effect.flip);
      expect(error.message).toContain("cannot be forked while a turn is active");
    }),
  );

  it.effect("rejects turns and repeat forks from an incomplete fork", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      readModel = yield* projectEvent(readModel, {
        sequence: 4,
        eventId: EventId.make("event-session-fork-failed"),
        aggregateKind: "thread",
        aggregateId: sourceThreadId,
        type: "thread.session-set",
        occurredAt: now,
        commandId: CommandId.make("command-session-fork-failed"),
        causationEventId: null,
        correlationId: CommandId.make("command-session-fork-failed"),
        metadata: {},
        payload: {
          threadId: sourceThreadId,
          session: {
            threadId: sourceThreadId,
            status: "error",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex-instance"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "Conversation fork failed: provider rejected the request",
            updatedAt: now,
          },
        },
      });

      const turnError = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("command-failed-fork-turn"),
          threadId: sourceThreadId,
          message: {
            messageId: MessageId.make("message-failed-fork-turn"),
            role: "user",
            text: "continue",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        },
      }).pipe(Effect.flip);
      expect(turnError.message).toContain("provider fork is not usable");

      const forkError = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.fork",
          commandId: CommandId.make("command-repeat-failed-fork"),
          sourceThreadId,
          threadId: ThreadId.make("destination-repeat-failed"),
          createdAt: now,
        },
      }).pipe(Effect.flip);
      expect(forkError.message).toContain("incomplete conversation fork");
    }),
  );
});
