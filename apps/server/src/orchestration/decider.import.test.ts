import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
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
import * as TestClock from "effect/testing/TestClock";

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

it.layer(NodeServices.layer)("thread history import", (it) => {
  it.effect("marks imported thread creation without changing live creation", () =>
    Effect.gen(function* () {
      const createdAt = "2026-08-24T10:00:00.000Z";
      const projectId = ProjectId.make("project-1");
      const readModel = yield* projectEvent(createEmptyReadModel(createdAt), {
        sequence: 1,
        eventId: EventId.make("event-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-project-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-project-created"),
        metadata: {},
        payload: {
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      const makeCreateCommand = (threadId: ThreadId) => ({
        type: "thread.create" as const,
        commandId: CommandId.make(`command-create-${threadId}`),
        threadId,
        projectId,
        title: "Imported thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        createdAt,
      });

      const imported = yield* decideOrchestrationCommand({
        command: {
          ...makeCreateCommand(ThreadId.make("import:codex:session-1")),
          historyImport: true,
        },
        readModel,
      });
      const live = yield* decideOrchestrationCommand({
        command: makeCreateCommand(ThreadId.make("live-thread")),
        readModel,
      });

      expect(imported).toMatchObject({
        type: "thread.created",
        metadata: { historyImport: true },
      });
      expect(live).toMatchObject({ type: "thread.created" });
      expect(live).not.toMatchObject({ metadata: { historyImport: true } });
    }),
  );

  it.effect("settles imported messages at the latest absolute timestamp", () =>
    Effect.gen(function* () {
      const createdAt = "2026-08-24T10:30:00.000+02:00";
      const threadId = ThreadId.make("import:codex:session-1");
      const readModel = yield* projectEvent(createEmptyReadModel(createdAt), {
        sequence: 1,
        eventId: EventId.make("event-thread-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-thread-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-thread-created"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-1"),
          title: "Imported thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

      const events = yield* decideOrchestrationCommand({
        command: {
          type: "thread.history.import",
          commandId: CommandId.make("command-import-history"),
          threadId,
          messages: [
            {
              messageId: MessageId.make(`${threadId}:000000`),
              role: "user",
              text: "Fix the bug",
              createdAt,
            },
            {
              messageId: MessageId.make(`${threadId}:000001`),
              role: "assistant",
              text: "Fixed",
              createdAt: "2026-08-24T09:00:00.000Z",
            },
          ],
        },
        readModel,
      });

      expect(events).toMatchObject([
        {
          type: "thread.message-sent",
          metadata: { historyImport: true },
          payload: { role: "user", text: "Fix the bug", turnId: null, streaming: false },
        },
        {
          type: "thread.message-sent",
          metadata: { historyImport: true },
          payload: { role: "assistant", text: "Fixed", turnId: null, streaming: false },
        },
        {
          type: "thread.settled",
          metadata: { historyImport: true },
          occurredAt: "2026-08-24T09:00:00.000Z",
          payload: {
            settledAt: "2026-08-24T09:00:00.000Z",
            updatedAt: "2026-08-24T09:00:00.000Z",
          },
        },
      ]);

      let projected = readModel;
      const plannedEvents = Array.isArray(events) ? events : [events];
      for (const [index, event] of plannedEvents.entries()) {
        projected = yield* projectEvent(projected, { ...event, sequence: index + 2 });
      }
      projected = yield* projectEvent(projected, {
        sequence: 5,
        eventId: EventId.make("event-import-reverted"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.reverted",
        occurredAt: "2026-08-24T10:02:00.000Z",
        commandId: CommandId.make("command-import-reverted"),
        causationEventId: null,
        correlationId: CommandId.make("command-import-reverted"),
        metadata: {},
        payload: { threadId, turnCount: 0 },
      });
      expect(projected.threads[0]?.messages.map((message) => message.text)).toEqual([
        "Fix the bug",
        "Fixed",
      ]);
    }),
  );

  it.effect("allows a thread with a newly imported user message to be settled", () =>
    Effect.gen(function* () {
      const createdAt = "2026-08-24T10:00:00.000Z";
      yield* TestClock.setTime(Date.parse("2026-08-24T10:00:30.000Z"));
      const threadId = ThreadId.make("import:codex:session-1");
      const withThread = yield* projectEvent(createEmptyReadModel(createdAt), {
        sequence: 1,
        eventId: EventId.make("event-import-thread-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-import-thread-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-import-thread-created"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-1"),
          title: "Imported thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });
      const readModel = yield* projectEvent(withThread, {
        sequence: 2,
        eventId: EventId.make("event-import-user-message"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.message-sent",
        occurredAt: createdAt,
        commandId: CommandId.make("command-import-user-message"),
        causationEventId: null,
        correlationId: CommandId.make("command-import-user-message"),
        metadata: { historyImport: true },
        payload: {
          threadId,
          messageId: MessageId.make("import:codex:session-1:0"),
          role: "user",
          text: "Existing prompt",
          turnId: null,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        },
      });

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("command-settle-imported-thread"),
          threadId,
        },
        readModel,
      });

      expect(result).toMatchObject({ type: "thread.settled" });
    }),
  );

  it.effect("rejects history import after a client message reaches the thread", () =>
    Effect.gen(function* () {
      const createdAt = "2026-08-24T10:00:00.000Z";
      const liveMessageAt = "2026-08-24T10:02:00.000Z";
      const threadId = ThreadId.make("import:codex:client-race");
      const withThread = yield* projectEvent(createEmptyReadModel(createdAt), {
        sequence: 1,
        eventId: EventId.make("event-client-race-thread-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-client-race-thread-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-client-race-thread-created"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-1"),
          title: "Imported thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });
      const readModel = yield* projectEvent(withThread, {
        sequence: 2,
        eventId: EventId.make("event-client-race-message"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.message-sent",
        occurredAt: liveMessageAt,
        commandId: CommandId.make("command-client-race-message"),
        causationEventId: null,
        correlationId: CommandId.make("command-client-race-message"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("client-race-message"),
          role: "user",
          text: "Start live work",
          turnId: null,
          streaming: false,
          createdAt: liveMessageAt,
          updatedAt: liveMessageAt,
        },
      });

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.history.import",
            commandId: CommandId.make("command-client-race-import"),
            threadId,
            messages: [
              {
                messageId: MessageId.make(`${threadId}:000000`),
                role: "user",
                text: "Old work",
                createdAt,
              },
            ],
          },
          readModel,
        }),
      );

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("must be active and empty");
      expect(readModel.threads[0]?.updatedAt).toBe(liveMessageAt);
    }),
  );

  for (const requestKind of ["approval.requested", "user-input.requested"] as const) {
    it.effect(`rejects history import with an open ${requestKind} activity`, () =>
      Effect.gen(function* () {
        const createdAt = "2026-08-24T10:00:00.000Z";
        const threadId = ThreadId.make(`import:codex:${requestKind}`);
        const withThread = yield* projectEvent(createEmptyReadModel(createdAt), {
          sequence: 1,
          eventId: EventId.make(`event-${requestKind}-thread-created`),
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.created",
          occurredAt: createdAt,
          commandId: CommandId.make(`command-${requestKind}-thread-created`),
          causationEventId: null,
          correlationId: CommandId.make(`command-${requestKind}-thread-created`),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-1"),
            title: "Imported thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        });
        const readModel = yield* projectEvent(withThread, {
          sequence: 2,
          eventId: EventId.make(`event-${requestKind}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.activity-appended",
          occurredAt: createdAt,
          commandId: CommandId.make(`command-${requestKind}`),
          causationEventId: null,
          correlationId: CommandId.make(`command-${requestKind}`),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make(`activity-${requestKind}`),
              tone: "approval",
              kind: requestKind,
              summary: "Pending request",
              payload: { requestId: "request-1" },
              turnId: null,
              createdAt,
            },
          },
        });

        const error = yield* Effect.flip(
          decideOrchestrationCommand({
            command: {
              type: "thread.history.import",
              commandId: CommandId.make(`command-import-${requestKind}`),
              threadId,
              messages: [
                {
                  messageId: MessageId.make(`${threadId}:000000`),
                  role: "user",
                  text: "Old work",
                  createdAt,
                },
              ],
            },
            readModel,
          }),
        );

        expect(error._tag).toBe("OrchestrationCommandInvariantError");
        expect(error.message).toContain("must be active and empty");
      }),
    );
  }

  it.effect("rejects a live user message in the imported-session namespace", () =>
    Effect.gen(function* () {
      const createdAt = "2026-08-24T10:00:00.000Z";
      const threadId = ThreadId.make("thread-live-message");
      const readModel = yield* projectEvent(createEmptyReadModel(createdAt), {
        sequence: 1,
        eventId: EventId.make("event-live-thread-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-live-thread-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-live-thread-created"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-1"),
          title: "Live thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("command-live-import-id"),
            threadId,
            message: {
              messageId: MessageId.make("import:forged-live-message"),
              role: "user",
              text: "Live work",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt,
          },
          readModel,
        }),
      );

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("reserved imported-session namespace");
    }),
  );

  it.effect("rejects live assistant messages in the imported-session namespace", () =>
    Effect.gen(function* () {
      const createdAt = "2026-08-24T10:00:00.000Z";
      const threadId = ThreadId.make("thread-live-assistant-message");
      const readModel = yield* projectEvent(createEmptyReadModel(createdAt), {
        sequence: 1,
        eventId: EventId.make("event-live-assistant-thread-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-live-assistant-thread-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-live-assistant-thread-created"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-1"),
          title: "Live thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

      for (const commandType of [
        "thread.message.assistant.delta",
        "thread.message.assistant.complete",
      ] as const) {
        const command =
          commandType === "thread.message.assistant.delta"
            ? {
                type: commandType,
                commandId: CommandId.make("command-live-assistant-delta-import-id"),
                threadId,
                messageId: MessageId.make("import:forged-live-assistant-message"),
                delta: "Live work",
                createdAt,
              }
            : {
                type: commandType,
                commandId: CommandId.make("command-live-assistant-complete-import-id"),
                threadId,
                messageId: MessageId.make("import:forged-live-assistant-message"),
                createdAt,
              };
        const error = yield* Effect.flip(decideOrchestrationCommand({ command, readModel }));

        expect(error._tag).toBe("OrchestrationCommandInvariantError");
        expect(error.message).toContain("reserved imported-session namespace");
      }
    }),
  );
});
