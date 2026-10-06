import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type ModelSelection, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  type SpeechScriptGenerationInput,
  TextGeneration,
} from "../textGeneration/TextGeneration.ts";
import { make } from "./MessageSpeechScript.ts";
import { seedMessage, setMessageText } from "./testFixtures.ts";

const providerModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};
const scriptModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude-fast"),
  model: "claude-haiku",
};

const makeScriptService = Effect.fn("makeScriptService")(function* (
  generate: (
    input: SpeechScriptGenerationInput,
  ) => Effect.Effect<{ readonly script: string }, TextGenerationError>,
) {
  const calls = yield* Ref.make<ReadonlyArray<SpeechScriptGenerationInput>>([]);
  const service = yield* make.pipe(
    Effect.provideService(
      TextGeneration,
      TextGeneration.of({
        generateCommitMessage: () => Effect.die("unused"),
        generatePrContent: () => Effect.die("unused"),
        generateBranchName: () => Effect.die("unused"),
        generateThreadTitle: () => Effect.die("unused"),
        generateMessageSummary: () => Effect.die("unused"),
        generateSpeechScript: (input) =>
          Ref.update(calls, (current) => [...current, input]).pipe(Effect.andThen(generate(input))),
      }),
    ),
  );
  return { service, calls };
});

const storedScripts = (messageId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly script: string }>`
        SELECT script FROM fork_message_speech_scripts WHERE message_id = ${messageId}
      `,
  );

const seed = (suffix: string, text: string) =>
  seedMessage({
    suffix,
    text,
    threadModelSelection: providerModel,
    runModelSelection: providerModel,
    worktreePath: "/workspace/worktree",
  });

const TestLayer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  NodeServices.layer,
);

it.layer(TestLayer)("message speech scripts", (it) => {
  it.effect("writes the script in an empty directory, stores it, and reuses it per recipe", () =>
    Effect.gen(function* () {
      const message = yield* seed("script-reuse", "  The **build** passed.  ");
      const { service, calls } = yield* makeScriptService((input) =>
        Effect.succeed({ script: ` Spoken: ${input.message} ` }),
      );
      const request = { messageId: message.id, maxScriptChars: 500, modelSelection: scriptModel };

      const first = yield* service.generate(request);
      const second = yield* service.generate(request);
      const restyled = yield* service.generate({ ...request, instructions: "Cheerful" });

      assert.equal(first.script, "Spoken: The **build** passed.");
      assert.deepEqual(second, first);
      assert.notEqual(restyled.scriptRecipeHash, first.scriptRecipeHash);
      const recorded = yield* Ref.get(calls);
      assert.equal(recorded.length, 2);
      assert.equal(recorded[0]?.message, "The **build** passed.");
      assert.deepEqual(recorded[0]?.modelSelection, scriptModel);
      assert.isTrue(recorded[0]?.cwd.includes("t3code-message-speech-"));
    }),
  );

  it.effect("keeps the stored script when the message changes during generation", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const message = yield* seed("script-stale", "First answer.");
      const editDuringNextCall = yield* Ref.make(false);
      const { service } = yield* makeScriptService((input) =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(editDuringNextCall, false)) {
            yield* setMessageText(message, "Third answer.").pipe(
              Effect.provideService(ProjectionStore.ProjectionStoreV2, store),
              Effect.orDie,
            );
          }
          return { script: `Spoken ${input.message}` };
        }),
      );
      const request = { messageId: message.id, maxScriptChars: 500, modelSelection: scriptModel };

      yield* service.generate(request);
      yield* setMessageText(message, "Second answer.");
      yield* Ref.set(editDuringNextCall, true);
      const stale = yield* Effect.flip(service.generate(request));

      assert.equal(stale.reason, "message_unavailable");
      assert.deepEqual(yield* storedScripts(message.id), [{ script: "Spoken First answer." }]);
      assert.equal((yield* service.generate(request)).script, "Spoken Third answer.");
    }),
  );

  it.effect("fails typed without replacing the stored script", () =>
    Effect.gen(function* () {
      const message = yield* seed("script-failures", "A short answer.");
      const outcome = yield* Ref.make<"ok" | "error" | "too-long">("ok");
      const { service, calls } = yield* makeScriptService(() =>
        Effect.gen(function* () {
          switch (yield* Ref.get(outcome)) {
            case "ok":
              return { script: "Short." };
            case "too-long":
              return { script: "x".repeat(600) };
            case "error":
              return yield* new TextGenerationError({
                operation: "generateSpeechScript",
                detail: "offline",
              });
          }
        }),
      );
      const request = { messageId: message.id, maxScriptChars: 500, modelSelection: scriptModel };
      yield* service.generate(request);

      // A different recipe forces a new generation for each failure case.
      yield* Ref.set(outcome, "error");
      const providerFailure = yield* Effect.flip(
        service.generate({ ...request, instructions: "Slow" }),
      );
      yield* Ref.set(outcome, "too-long");
      const oversizedScript = yield* Effect.flip(
        service.generate({ ...request, instructions: "Slower" }),
      );
      const oversizedSource = yield* Effect.flip(
        service.generate({ ...request, maxScriptChars: 5 }),
      );

      assert.deepEqual(
        [providerFailure.reason, oversizedScript.reason, oversizedSource.reason],
        ["script_failed", "script_failed", "source_too_long"],
      );
      assert.equal((yield* Ref.get(calls)).length, 3);
      assert.deepEqual(yield* storedScripts(message.id), [{ script: "Short." }]);
    }),
  );

  it.effect("runs one generation for concurrent requests on the same message", () =>
    Effect.gen(function* () {
      const message = yield* seed("script-concurrent", "Concurrent answer.");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { service, calls } = yield* makeScriptService(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ script: "Spoken once." }),
        ),
      );
      const request = { messageId: message.id, maxScriptChars: 500, modelSelection: scriptModel };

      const first = yield* Effect.forkChild(service.generate(request));
      yield* Deferred.await(entered);
      const second = yield* Effect.forkChild(service.generate(request));
      yield* Deferred.succeed(release, undefined);

      const results = yield* Fiber.joinAll([first, second]);
      assert.deepEqual(results[1], results[0]);
      assert.equal((yield* Ref.get(calls)).length, 1);
    }),
  );
});
