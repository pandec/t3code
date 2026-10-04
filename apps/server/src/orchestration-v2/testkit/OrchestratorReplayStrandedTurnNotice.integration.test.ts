import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ProviderReplayEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeRestartReplayHarness,
} from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { STRANDED_PRIOR_TURN_NOTICE } from "../StrandedTurnNotice.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  projectionFor,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
} from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import { readProviderReplayTranscript } from "./ReplayTranscriptNdjson.ts";

const SCENARIO = "turn_interrupt_restart";
const SESSION_ID = "fb591f8f-073f-4981-bf67-9b5bffb537d5";
const FIRST_AFTER_RESTART = "Did that command finish?";
const SECOND_AFTER_RESTART = "Thanks. Anything else?";
const SLASH_COMMAND_AFTER_RESTART = "/deploy production";

const frameType = (frame: unknown) =>
  typeof frame === "object" && frame !== null ? Reflect.get(frame, "type") : undefined;

/**
 * The recorded mid-tool Claude turn, cut by a server exit while its Bash call
 * runs (no Stop, no result). A fresh runtime resumes the native session; each
 * prompt frame it sends is pinned, so these are the provider's view.
 */
const readStrandedTranscript = Effect.fn("readStrandedTranscript")(function* (
  resumedPrompts: ReadonlyArray<string>,
) {
  const recorded = yield* readProviderReplayTranscript(
    new URL(`./fixtures/${SCENARIO}/claude_transcript.ndjson`, import.meta.url),
  );
  const interrupt = recorded.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && frameType(entry.frame) === "query.interrupt",
  );
  const resumeOpen = recorded.entries.find(
    (entry) => entry.type === "expect_outbound" && entry.label === "query.open:2",
  );
  if (interrupt < 0 || resumeOpen === undefined) {
    throw new Error(`${SCENARIO} must record an interrupt and a resumed query.open.`);
  }
  const resumedTurn = (label: string, text: string): ReadonlyArray<ProviderReplayEntry> => [
    {
      type: "expect_outbound",
      label: `prompt.offer:${label}`,
      frame: {
        type: "prompt.offer",
        message: {
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
        },
      },
    },
    {
      type: "emit_inbound",
      label: `assistant:${label}`,
      frame: {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          id: `msg_stranded_${label}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `REPLY_${label}` }],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
        session_id: SESSION_ID,
        uuid: `stranded-assistant-${label}`,
      },
    },
    {
      type: "emit_inbound",
      label: `result:${label}`,
      frame: {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: `REPLY_${label}`,
        stop_reason: "end_turn",
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        session_id: SESSION_ID,
        uuid: `stranded-result-${label}`,
      },
    },
  ];
  return yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
    ...recorded,
    entries: [
      // The server shuts down here, with the Bash call still running.
      ...recorded.entries.slice(0, interrupt),
      resumeOpen,
      ...resumedPrompts.flatMap((prompt, index) => resumedTurn(String(index + 1), prompt)),
    ],
  });
});

/**
 * Strands a turn with a server exit, then sends `firstAfterRestart` and
 * `SECOND_AFTER_RESTART` after recovery; `firstPrompt` is what the provider
 * must receive for the first.
 */
const runAfterStrandedTurn = (firstAfterRestart: string, firstPrompt: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const transcript = yield* readStrandedTranscript([firstPrompt, SECOND_AFTER_RESTART]);
      const workspace = yield* checkpointWorkspace(SCENARIO);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "t3-orchestration-v2-stranded-turn-" }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const materialized = yield* materializeFixtureInput({
        scenario: SCENARIO,
        fixtureInput: {
          steps: [
            { type: "message", text: TURN_INTERRUPT_MID_TOOL_PROMPT },
            // Only its waits are used: the server exits once the tool runs.
            { type: "interrupt", targetRunIndex: 1, waitForTurnItemType: "command_execution" },
            { type: "message", text: firstAfterRestart },
            { type: "message", text: SECOND_AFTER_RESTART },
          ],
        },
        driver: ProviderDriverKind.make("claudeAgent"),
        modelSelection: CLAUDE_MODEL_SELECTION,
      });
      const toolRunning = materialized.steps.findIndex(
        (step) => step.type === "await_run_turn_item",
      );
      const interruptDispatch = materialized.steps.findIndex(
        (step) => step.type === "dispatch" && step.command.type === "run.interrupt",
      );
      const interruptSettled = materialized.steps.findIndex(
        (step, index) => index > interruptDispatch && step.type === "await_thread_idle",
      );
      const phase1Steps = materialized.steps.slice(0, toolRunning + 1);
      const phase2Steps = materialized.steps.slice(interruptSettled + 1);
      const { harness, assertComplete } = makeClaudeRestartReplayHarness(transcript);
      const databaseLayer = makeSqlitePersistenceLive(path.join(tempDir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );
      const scenario = (name: string, steps: typeof materialized.steps) => ({
        name: `${SCENARIO}:${name}`,
        transcript,
        commands: steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
        steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { cwd: workspace },
      });

      yield* Effect.scoped(
        runOrchestratorV2ProviderReplayScenario(scenario("before-restart", phase1Steps), harness, {
          databaseLayer,
        }),
      );
      const after = yield* Effect.scoped(
        runOrchestratorV2ProviderReplayScenario(scenario("after-restart", phase2Steps), harness, {
          databaseLayer,
          recoverOnStartup: true,
          continueThreadsAfterServerUpdate: false,
        }),
      );
      // The replay runner rejects any prompt frame that differs from the transcript.
      yield* assertComplete;
      const projection = projectionFor(after, SCENARIO);
      assert.deepEqual(
        projection.runs.map((run) => [run.status, run.strandedByRestart]),
        [
          ["cancelled", true],
          ["completed", undefined],
          ["completed", undefined],
        ],
      );
      // The notice reaches the provider only; the timeline keeps what the user sent.
      assert.deepEqual(
        projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : [])),
        [TURN_INTERRUPT_MID_TOOL_PROMPT, firstAfterRestart, SECOND_AFTER_RESTART],
      );
    }).pipe(
      provideDeterministicTestRuntime,
      Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
    ),
  );

describe("turn stranded by a restart", () => {
  it.effect("tells the next provider turn once that the restart cut it off", () =>
    runAfterStrandedTurn(
      FIRST_AFTER_RESTART,
      `${STRANDED_PRIOR_TURN_NOTICE}\n\nUser message:\n${FIRST_AFTER_RESTART}`,
    ),
  );

  it.effect("keeps a slash command as the whole prompt", () =>
    // A notice ahead of it would turn the command into prose; it is dropped, not deferred.
    runAfterStrandedTurn(SLASH_COMMAND_AFTER_RESTART, SLASH_COMMAND_AFTER_RESTART),
  );
});
