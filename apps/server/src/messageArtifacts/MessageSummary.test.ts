import {
  MessageId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { make, withLowSummaryEffort } from "./MessageSummary.ts";

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
      instanceId: ProviderInstanceId.make("opencode-work"),
      model: "auto",
      options: [{ id: "custom", value: true }],
    };

    expect(withLowSummaryEffort(selection, ProviderDriverKind.make("opencode"))).toBe(selection);
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

effectIt.layer(SqlitePersistenceMemory)("message summary persistence", (it) => {
  it.effect(
    "uses the thread model and worktree at low effort, then reuses the persisted result",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'summary-project', 'Summary project', '/workspace/root', '[]',
          '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'
        )
      `;
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, worktree_path, created_at, updated_at
        ) VALUES (
          'summary-thread', 'summary-project', 'Summary thread',
          '{"instanceId":"codex-work","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"high"}]}',
          'full-access', 'default', '/workspace/worktree',
          '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'
        )
      `;
        yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, generation_model_selection_json,
          generation_cwd, is_streaming, created_at, updated_at
        ) VALUES (
          'summary-message', 'summary-thread', 'assistant', '  Detailed response.  ',
          '{"instanceId":"codex-original","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"high"}]}',
          '/workspace/original', 0,
          '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'
        )
      `;

        const textGeneration = TextGeneration.of({
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
          generateSpeechScript: () => Effect.die("unused"),
          generateMessageSummary: (input) =>
            Ref.update(calls, (current) => [...current, input]).pipe(
              Effect.as({ summary: "Concise summary." }),
            ),
        });
        const provider = {
          instanceId: ProviderInstanceId.make("codex-original"),
          driverKind: ProviderDriverKind.make("codex"),
          enabled: true,
        } as ProviderInstance;
        const providerRegistry = ProviderInstanceRegistry.of({
          getInstance: (instanceId) =>
            Effect.succeed(instanceId === provider.instanceId ? provider : undefined),
        } as ProviderInstanceRegistry["Service"]);
        const summaryService = yield* make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(TextGeneration, textGeneration),
              Layer.succeed(ProviderInstanceRegistry, providerRegistry),
            ),
          ),
        );

        const request = { messageId: MessageId.make("summary-message") };
        const first = yield* summaryService.summarize(request);
        const second = yield* summaryService.summarize(request);

        assert.equal(first.summary, "Concise summary.");
        assert.deepEqual(second, first);
        assert.deepEqual(yield* Ref.get(calls), [
          {
            cwd: "/workspace/original",
            message: "Detailed response.",
            maxSummaryChars: 12_000,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-original"),
              model: "gpt-5.6-sol",
              options: [{ id: "reasoningEffort", value: "low" }],
            },
          },
        ]);
      }),
  );
});
