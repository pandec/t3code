import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  type MessageSummaryGenerationInput,
  TextGeneration,
} from "../textGeneration/TextGeneration.ts";
import { make, withLowSummaryEffort } from "./MessageSummary.ts";
import { seedMessage, setMessageText } from "./testFixtures.ts";

describe("message summary model selection", () => {
  it("uses the same Codex instance and model with low reasoning effort", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex-work"),
      model: "gpt-5.6-sol",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ],
    };

    expect(withLowSummaryEffort(selection, ProviderDriverKind.make("codex"))).toEqual({
      instanceId: ProviderInstanceId.make("codex-work"),
      model: "gpt-5.6-sol",
      options: [
        { id: "serviceTier", value: "priority" },
        { id: "reasoningEffort", value: "low" },
      ],
    });
  });

  it("uses low effort for Claude without changing its instance or model", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-opus-4-8",
      options: [{ id: "effort", value: "max" }],
    };

    expect(withLowSummaryEffort(selection, ProviderDriverKind.make("claudeAgent"))).toEqual({
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-opus-4-8",
      options: [{ id: "effort", value: "low" }],
    });
  });

  it("leaves providers without a low-effort option unchanged", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("grok-work"),
      model: "auto",
      options: [{ id: "custom", value: true }],
    };

    expect(withLowSummaryEffort(selection, ProviderDriverKind.make("grok"))).toBe(selection);
  });

  it("uses the low OpenCode model variant", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("opencode-work"),
      model: "openai/gpt-5.6-sol",
      options: [{ id: "variant", value: "high" }],
    };

    expect(withLowSummaryEffort(selection, ProviderDriverKind.make("opencode"))).toEqual({
      instanceId: ProviderInstanceId.make("opencode-work"),
      model: "openai/gpt-5.6-sol",
      options: [{ id: "variant", value: "low" }],
    });
  });

  it("uses low reasoning for Cursor", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("cursor-work"),
      model: "auto",
      options: [{ id: "reasoning", value: "xhigh" }],
    };

    expect(withLowSummaryEffort(selection, ProviderDriverKind.make("cursor"))).toEqual({
      instanceId: ProviderInstanceId.make("cursor-work"),
      model: "auto",
      options: [{ id: "reasoning", value: "low" }],
    });
  });
});

const runModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex-run"),
  model: "gpt-5.6-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const threadModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex-thread"),
  model: "gpt-5.4",
};

const makeSummaryService = Effect.fn("makeSummaryService")(function* (
  generate: (
    input: MessageSummaryGenerationInput,
  ) => Effect.Effect<{ readonly summary: string }, TextGenerationError>,
  options: { readonly disabledInstance?: ProviderInstanceId } = {},
) {
  const calls = yield* Ref.make<ReadonlyArray<MessageSummaryGenerationInput>>([]);
  const textGeneration = TextGeneration.of({
    generateCommitMessage: () => Effect.die("unused"),
    generatePrContent: () => Effect.die("unused"),
    generateBranchName: () => Effect.die("unused"),
    generateThreadTitle: () => Effect.die("unused"),
    generateSpeechScript: () => Effect.die("unused"),
    generateMessageSummary: (input) =>
      Ref.update(calls, (current) => [...current, input]).pipe(Effect.andThen(generate(input))),
  });
  const providerRegistry = ProviderInstanceRegistry.of({
    getInstance: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make("codex"),
        enabled: instanceId !== options.disabledInstance,
      } as ProviderInstance),
  } as ProviderInstanceRegistry["Service"]);
  const service = yield* make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(TextGeneration, textGeneration),
        Layer.succeed(ProviderInstanceRegistry, providerRegistry),
      ),
    ),
  );
  return { service, calls };
});

const storedSummaries = (messageId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly summary: string }>`
        SELECT summary FROM fork_message_summaries WHERE message_id = ${messageId}
      `,
  );

const TestLayer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  NodeServices.layer,
);

effectIt.layer(TestLayer)("message summary persistence", (it) => {
  it.effect("summarizes with the producing run's model at low effort, then reuses the result", () =>
    Effect.gen(function* () {
      const message = yield* seedMessage({
        suffix: "summary-run",
        text: "  Detailed response.  ",
        threadModelSelection: threadModel,
        runModelSelection: runModel,
        worktreePath: "/workspace/worktree",
      });
      const { service, calls } = yield* makeSummaryService(() =>
        Effect.succeed({ summary: " Concise summary. " }),
      );

      const first = yield* service.summarize({ messageId: message.id });
      const second = yield* service.summarize({ messageId: message.id });

      assert.equal(first.summary, "Concise summary.");
      assert.deepEqual(second, first);
      assert.deepEqual(yield* Ref.get(calls), [
        {
          cwd: "/workspace/worktree",
          message: "Detailed response.",
          maxSummaryChars: 12_000,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex-run"),
            model: "gpt-5.6-sol",
            options: [{ id: "reasoningEffort", value: "low" }],
          },
        },
      ]);
    }),
  );

  it.effect("never stores a summary of text that changed during generation", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const message = yield* seedMessage({
        suffix: "summary-stale",
        text: "First answer.",
        threadModelSelection: threadModel,
        runModelSelection: runModel,
        worktreePath: "/workspace/worktree",
      });
      const editedDuringGeneration = yield* Ref.make(false);
      const { service, calls } = yield* makeSummaryService((input) =>
        Effect.gen(function* () {
          if (!(yield* Ref.getAndSet(editedDuringGeneration, true))) {
            yield* setMessageText(message, "Edited answer.").pipe(
              Effect.provideService(ProjectionStore.ProjectionStoreV2, store),
              Effect.orDie,
            );
          }
          return { summary: `Summary of ${input.message}` };
        }),
      );

      const stale = yield* Effect.flip(service.summarize({ messageId: message.id }));
      assert.equal(stale.reason, "message_unavailable");
      assert.deepEqual(yield* storedSummaries(message.id), []);

      const fresh = yield* service.summarize({ messageId: message.id });
      assert.equal(fresh.summary, "Summary of Edited answer.");
      assert.deepEqual(yield* storedSummaries(message.id), [
        { summary: "Summary of Edited answer." },
      ]);
      assert.equal((yield* Ref.get(calls)).length, 2);
    }),
  );

  it.effect("pins the thread model for a runless message", () =>
    Effect.gen(function* () {
      const message = yield* seedMessage({
        suffix: "summary-runless",
        text: "Imported answer.",
        threadModelSelection: threadModel,
        runModelSelection: null,
        worktreePath: null,
      });
      const { service, calls } = yield* makeSummaryService(() =>
        Effect.succeed({ summary: "Imported summary." }),
      );

      yield* service.summarize({ messageId: message.id });
      const [call] = yield* Ref.get(calls);
      assert.equal(call?.modelSelection.instanceId, threadModel.instanceId);
      // Without a worktree or project the provider runs in an empty directory.
      assert.isTrue((call?.cwd ?? "").includes("t3code-message-summary-"));
    }),
  );

  it.effect("rejects unusable messages and unavailable providers without storing anything", () =>
    Effect.gen(function* () {
      const streaming = yield* seedMessage({
        suffix: "summary-streaming",
        text: "Still writing",
        threadModelSelection: threadModel,
        runModelSelection: runModel,
        worktreePath: null,
        streaming: true,
      });
      const user = yield* seedMessage({
        suffix: "summary-user",
        text: "A question",
        threadModelSelection: threadModel,
        runModelSelection: runModel,
        worktreePath: null,
        role: "user",
      });
      const disabled = yield* seedMessage({
        suffix: "summary-disabled",
        text: "An answer",
        threadModelSelection: threadModel,
        runModelSelection: runModel,
        worktreePath: null,
      });
      const failing = yield* seedMessage({
        suffix: "summary-failing",
        text: "Another answer",
        threadModelSelection: threadModel,
        runModelSelection: threadModel,
        worktreePath: null,
      });
      const { service, calls } = yield* makeSummaryService(
        () =>
          Effect.fail(
            new TextGenerationError({ operation: "generateMessageSummary", detail: "offline" }),
          ),
        { disabledInstance: runModel.instanceId },
      );

      const reasons = yield* Effect.forEach([streaming, user, disabled, failing], (message) =>
        Effect.flip(service.summarize({ messageId: message.id })).pipe(
          Effect.map((error) => error.reason),
        ),
      );
      assert.deepEqual(reasons, [
        "message_unavailable",
        "message_unavailable",
        "provider_unavailable",
        "generation_failed",
      ]);
      assert.equal((yield* Ref.get(calls)).length, 1);
      assert.deepEqual(yield* storedSummaries(failing.id), []);
    }),
  );
});
