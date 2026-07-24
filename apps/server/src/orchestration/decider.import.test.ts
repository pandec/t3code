import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project");
const importThreadId = ThreadId.make("imported-thread");

const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(now);
  return yield* projectEvent(initial, {
    sequence: 1,
    eventId: EventId.make("event-project"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("command-project"),
    causationEventId: null,
    correlationId: CommandId.make("command-project"),
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
});

const importCommand = {
  type: "thread.import",
  commandId: CommandId.make("command-import"),
  threadId: importThreadId,
  projectId,
  title: "Imported session",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claude-instance"),
    model: "claude-sonnet-5",
  },
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  source: {
    provider: ProviderDriverKind.make("claudeAgent"),
    nativeSessionId: "9fc85367-4ed9-4dc7-a44e-bee92408ff84",
    nativeCwd: "/tmp/project",
  },
  messages: [
    {
      messageId: MessageId.make("import:imported-thread:00000"),
      role: "user",
      text: "Remember the codeword PINEAPPLE-42.",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      messageId: MessageId.make("import:imported-thread:00001"),
      role: "assistant",
      text: "OK",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ],
  createdAt: now,
} as const;

it.layer(NodeServices.layer)("thread import decider", (it) => {
  it.effect("emits a stopped provider session and imported history", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        readModel: yield* seedReadModel,
        command: importCommand,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.session-set",
        "thread.history-imported",
      ]);
      const created = events[0];
      if (created?.type === "thread.created") {
        expect(created.payload).toMatchObject({
          threadId: importThreadId,
          projectId,
          title: "Imported session",
          branch: null,
          worktreePath: null,
        });
      }
      const sessionSet = events[1];
      expect(sessionSet?.type).toBe("thread.session-set");
      if (sessionSet?.type === "thread.session-set") {
        expect(sessionSet.causationEventId).toBe(created?.eventId);
        expect(sessionSet.payload.session).toEqual({
          threadId: importThreadId,
          status: "stopped",
          providerName: importCommand.source.provider,
          providerInstanceId: importCommand.modelSelection.instanceId,
          runtimeMode: importCommand.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        });
      }
      const imported = events[2];
      expect(imported?.type).toBe("thread.history-imported");
      if (imported?.type === "thread.history-imported") {
        expect(imported.causationEventId).toBe(sessionSet?.eventId);
        expect(imported.payload.source).toEqual(importCommand.source);
        expect(imported.payload.messages).toEqual(importCommand.messages);
      }
    }),
  );

  it.effect("rejects an import into a missing project", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        readModel: createEmptyReadModel(now),
        command: importCommand,
      }).pipe(Effect.flip);
      expect(error.message).toContain("project");
    }),
  );

  it.effect("rejects an import when the thread id already exists", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      readModel = yield* projectEvent(readModel, {
        sequence: 2,
        eventId: EventId.make("event-existing-thread"),
        aggregateKind: "thread",
        aggregateId: importThreadId,
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("command-existing-thread"),
        causationEventId: null,
        correlationId: CommandId.make("command-existing-thread"),
        metadata: {},
        payload: {
          threadId: importThreadId,
          projectId,
          title: "Existing",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude-instance"),
            model: "claude-sonnet-5",
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      const error = yield* decideOrchestrationCommand({
        readModel,
        command: importCommand,
      }).pipe(Effect.flip);
      expect(error.message).toContain("already exists");
    }),
  );

  it.effect("projects imported history into the read model deterministically", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decideOrchestrationCommand({
        readModel,
        command: importCommand,
      }).pipe(Effect.map((result) => (Array.isArray(result) ? result : [result])));

      const applyAll = (base: typeof readModel) =>
        Effect.gen(function* () {
          let model = base;
          for (const [index, event] of events.entries()) {
            model = yield* projectEvent(model, {
              ...event,
              sequence: 10 + index,
            });
          }
          return model;
        });

      const projected = yield* applyAll(readModel);
      const thread = projected.threads.find((entry) => entry.id === importThreadId);
      expect(thread).toBeDefined();
      expect(thread?.session).toEqual({
        threadId: importThreadId,
        status: "stopped",
        providerName: importCommand.source.provider,
        providerInstanceId: importCommand.modelSelection.instanceId,
        runtimeMode: importCommand.runtimeMode,
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      });
      expect(
        thread?.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          turnId: message.turnId,
          streaming: message.streaming,
        })),
      ).toEqual([
        {
          id: "import:imported-thread:00000",
          role: "user",
          text: "Remember the codeword PINEAPPLE-42.",
          turnId: null,
          streaming: false,
        },
        {
          id: "import:imported-thread:00001",
          role: "assistant",
          text: "OK",
          turnId: null,
          streaming: false,
        },
      ]);

      // Replay determinism: rebuilding from the same journal yields identical messages.
      const replayed = yield* applyAll(yield* seedReadModel);
      expect(replayed.threads.find((entry) => entry.id === importThreadId)?.messages).toEqual(
        thread?.messages,
      );
    }),
  );

  it.effect("allows an imported thread to fork before starting a turn", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      const importEvents = yield* decideOrchestrationCommand({
        readModel,
        command: importCommand,
      }).pipe(Effect.map((result) => (Array.isArray(result) ? result : [result])));
      for (const [index, event] of importEvents.entries()) {
        readModel = yield* projectEvent(readModel, {
          ...event,
          sequence: 10 + index,
        });
      }

      const forkResult = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.fork",
          commandId: CommandId.make("command-fork-import"),
          sourceThreadId: importThreadId,
          threadId: ThreadId.make("forked-import"),
          createdAt: now,
        },
      });
      const forkEvents = Array.isArray(forkResult) ? forkResult : [forkResult];
      expect(forkEvents.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.session-set",
        "thread.fork-requested",
      ]);
      const forkSession = forkEvents[1];
      expect(forkSession?.type).toBe("thread.session-set");
      if (forkSession?.type === "thread.session-set") {
        expect(forkSession.payload.session).toMatchObject({
          status: "starting",
          providerName: importCommand.source.provider,
          providerInstanceId: importCommand.modelSelection.instanceId,
        });
      }
    }),
  );
});
