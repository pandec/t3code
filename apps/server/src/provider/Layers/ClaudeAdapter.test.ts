// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionResult,
  SDKControlGetUsageResponse,
  SDKControlInitializeResponse,
  SDKControlReloadSkillsResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  ClaudeSettings,
  ProviderDriverKind,
  ProviderItemId,
  ProviderRuntimeEvent,
  type RuntimeMode,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
  SYNTHETIC_CLAUDE_THINKING_MODEL,
} from "../ClaudeModelCatalog.testFixtures.ts";
import { ProviderAdapterProcessError, ProviderAdapterValidationError } from "../Errors.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import type { ClaudeScopedLimitNames } from "./claudeUsageLimits.ts";
import {
  hasPendingClaudeWork,
  makeClaudeAdapter,
  type ClaudeAdapterLiveOptions,
} from "./ClaudeAdapter.ts";
import { CLAUDE_SDK_INITIALIZATION_TIMEOUT_MS } from "./ClaudeProvider.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Test-local service tag so the rest of the file can keep using `yield* ClaudeAdapter`.
class ClaudeAdapter extends Context.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "t3/provider/Layers/ClaudeAdapter.test/ClaudeAdapter",
) {}

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  public readonly setModelCalls: Array<string | undefined> = [];
  public readonly setPermissionModeCalls: Array<string> = [];
  public readonly setMaxThinkingTokensCalls: Array<number | null> = [];
  public initializationResultOverride: (() => Promise<SDKControlInitializeResponse>) | undefined;
  public initializationCommands: SDKControlInitializeResponse["commands"] = [];
  public reloadSkillsResult: SDKControlReloadSkillsResponse = { skills: [] };
  public reloadSkillsFailure: unknown | undefined;
  public closeCalls = 0;
  /** Undefined models an SDK that lacks the experimental usage API entirely. */
  public usageResult: (() => Promise<unknown>) | undefined;
  public usageCalls = 0;
  public closeError: unknown | undefined;

  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  readonly setModel = async (model?: string): Promise<void> => {
    this.setModelCalls.push(model);
  };

  readonly setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    this.setPermissionModeCalls.push(mode);
  };

  readonly setMaxThinkingTokens = async (maxThinkingTokens: number | null): Promise<void> => {
    this.setMaxThinkingTokensCalls.push(maxThinkingTokens);
  };

  readonly initializationResult = async (): Promise<SDKControlInitializeResponse> => {
    if (this.initializationResultOverride) {
      return this.initializationResultOverride();
    }
    return { commands: this.initializationCommands } as SDKControlInitializeResponse;
  };

  readonly reloadSkills = async (): Promise<SDKControlReloadSkillsResponse> => {
    if (this.reloadSkillsFailure !== undefined) {
      throw this.reloadSkillsFailure;
    }
    return this.reloadSkillsResult;
  };

  readonly close = (): void => {
    this.closeCalls += 1;
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
    this.finish();
  };

  get usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET():
    | (() => Promise<SDKControlGetUsageResponse>)
    | undefined {
    const usageResult = this.usageResult;
    if (!usageResult) {
      return undefined;
    }
    return async function (this: FakeClaudeQuery) {
      this.usageCalls += 1;
      return (await usageResult()) as SDKControlGetUsageResponse;
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value) {
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}

function makeHarness(config?: {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly baseDir?: string;
  readonly claudeConfig?: Partial<ClaudeSettings>;
  readonly instanceId?: ProviderInstanceId;
  readonly forkSession?: ClaudeAdapterLiveOptions["forkSession"];
  readonly scopedLimitNames?: ClaudeAdapterLiveOptions["scopedLimitNames"];
}) {
  const query = new FakeClaudeQuery();
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }
    | undefined;

  const adapterOptions: ClaudeAdapterLiveOptions = {
    ...(config?.instanceId ? { instanceId: config.instanceId } : {}),
    ...(config?.scopedLimitNames ? { scopedLimitNames: config.scopedLimitNames } : {}),
    modelCatalog: Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    createQuery: (input) => {
      createInput = input;
      return query;
    },
    ...(config?.forkSession ? { forkSession: config.forkSession } : {}),
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
  };

  return {
    layer: Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings(config?.claudeConfig ?? {});
        return yield* makeClaudeAdapter(claudeConfig, adapterOptions);
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          config?.baseDir ?? "/tmp",
        ),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
    query,
    getLastCreateQueryInput: () => createInput,
  };
}

function makeDeterministicRandomService(seed = 0x1234_5678): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };

  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

async function readFirstPromptText(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<string | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  if (typeof next.value.message.content === "string") {
    return next.value.message.content;
  }
  const content = next.value.message.content[0];
  if (!content || content.type !== "text") {
    return undefined;
  }
  return content.text;
}

async function readFirstPromptMessage(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<SDKUserMessage | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  return next.value;
}

function writeSkillFile(skillDirectory: string, contents: string): void {
  NodeFS.mkdirSync(skillDirectory, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(skillDirectory, "SKILL.md"), contents);
}

const toTranscriptLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Drains the first `count` queued prompts so consecutive turns can be compared. */
async function readPromptMessages(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
  count: number,
): Promise<Array<SDKUserMessage>> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return [];
  }
  const messages: Array<SDKUserMessage> = [];
  while (messages.length < count) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    messages.push(next.value);
  }
  return messages;
}

const THREAD_ID = ThreadId.make("thread-claude-1");
const RESUME_THREAD_ID = ThreadId.make("thread-claude-resume");
const SYNTHETIC_SUBAGENT_MODEL = "claude-synthetic-subagent[expanded]";

describe("ClaudeAdapterLive", () => {
  it.effect("lists genuine Claude skills for the active workspace", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-"));
    const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-home-"));
    const harness = makeHarness({ cwd, claudeConfig: { homePath } });
    harness.query.reloadSkillsResult = {
      skills: [
        {
          name: "project-review",
          description: "Review this project",
          argumentHint: "",
        },
        {
          name: "PROJECT-REVIEW",
          description: "Duplicate",
          argumentHint: "",
        },
      ],
    };
    harness.query.initializationCommands = [
      { name: "project-review", description: "Review this project", argumentHint: "" },
    ];

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const listSkills = adapter.listSkills;
      if (!listSkills) return yield* Effect.die("Claude adapter does not support skill listing");
      const skills = yield* listSkills({ cwd });

      assert.equal(adapter.listSkillsTimeoutMillis, CLAUDE_SDK_INITIALIZATION_TIMEOUT_MS);
      assert.deepEqual(skills, [
        {
          name: "project-review",
          description: "Review this project",
          enabled: true,
          modelInvocable: true,
        },
      ]);
      assert.equal(harness.getLastCreateQueryInput()?.options.cwd, NodeFS.realpathSync(cwd));
      assert.equal(harness.getLastCreateQueryInput()?.options.persistSession, false);
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.settingSources, [
        "user",
        "project",
        "local",
      ]);
      // Loading project settings must not run the workspace's hooks: the
      // picker refreshes on open, so a SessionStart hook would fire with it.
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.settings, {
        disableAllHooks: true,
      });
      // Project settings are loaded for skills, so discovery must opt out of
      // the workspace's `.mcp.json` servers rather than booting them.
      assert.equal(harness.getLastCreateQueryInput()?.options.strictMcpConfig, true);
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.mcpServers, {});
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.allowedTools, []);
      // Connected claude.ai MCP servers live outside filesystem config, so the
      // shared probe options must disable them independently.
      assert.equal(
        harness.getLastCreateQueryInput()?.options.env?.ENABLE_CLAUDEAI_MCP_SERVERS,
        "false",
      );
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provide(harness.layer),
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(cwd, { recursive: true, force: true });
          NodeFS.rmSync(homePath, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("surfaces user-invocable-only skills the SDK skill list omits", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-manual-"));
    const homePath = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "claude-skills-manual-home-"),
    );
    writeSkillFile(
      NodePath.join(homePath, "skills", "dotfiles-sync"),
      [
        "---",
        "name: dotfiles-sync",
        "description: Sync dotfiles.",
        "user-invocable: true",
        "disable-model-invocation: true",
        "---",
      ].join("\n"),
    );
    writeSkillFile(
      NodePath.join(homePath, "skills", "internal-only"),
      [
        "---",
        "name: internal-only",
        "description: Model use only.",
        "user-invocable: false",
        "---",
      ].join("\n"),
    );
    const harness = makeHarness({ cwd, claudeConfig: { homePath } });
    harness.query.reloadSkillsResult = {
      skills: [
        { name: "project-review", description: "Review this project", argumentHint: "" },
        { name: "internal-only", description: "Model use only", argumentHint: "" },
      ],
    };
    harness.query.initializationCommands = [
      { name: "dotfiles-sync", description: "Sync dotfiles.", argumentHint: "" },
      { name: "project-review", description: "Review this project", argumentHint: "" },
    ];

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const listSkills = adapter.listSkills;
      if (!listSkills) return yield* Effect.die("Claude adapter does not support skill listing");
      const skills = yield* listSkills({ cwd });

      // `skills/reload` never reports `disable-model-invocation: true` skills,
      // so the picker would lose them without the filesystem scan.
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["dotfiles-sync", "project-review"],
      );
      assert.equal(skills[0]?.modelInvocable, false);
      assert.equal(skills[0]?.scope, "user");
      assert.equal(skills[1]?.modelInvocable, true);
    }).pipe(
      Effect.provide(harness.layer),
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(cwd, { recursive: true, force: true });
          NodeFS.rmSync(homePath, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps reported skills when the initialization command list is empty", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-nocommands-"));
    const homePath = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "claude-skills-nocommands-home-"),
    );
    writeSkillFile(
      NodePath.join(homePath, "skills", "deploy"),
      ["---", "name: deploy", "description: Deploy the app.", "---"].join("\n"),
    );
    const harness = makeHarness({ cwd, claudeConfig: { homePath } });
    harness.query.reloadSkillsResult = {
      skills: [{ name: "project-review", description: "Review this project", argumentHint: "" }],
    };
    harness.query.initializationCommands = [];

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const listSkills = adapter.listSkills;
      if (!listSkills) return yield* Effect.die("Claude adapter does not support skill listing");
      const skills = yield* listSkills({ cwd });

      // An empty command list says nothing about user invocation. Using it to
      // gate the merge would discard every skill we just discovered.
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["deploy", "project-review"],
      );
    }).pipe(
      Effect.provide(harness.layer),
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(cwd, { recursive: true, force: true });
          NodeFS.rmSync(homePath, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("still gates scanned skills by the command list when only reload fails", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-gated-"));
    const homePath = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "claude-skills-gated-home-"),
    );
    writeSkillFile(
      NodePath.join(homePath, "skills", "deploy"),
      ["---", "name: deploy", "description: Deploy the app.", "---"].join("\n"),
    );
    // Disabled through settings: present on disk, absent from the CLI's
    // command list, and `/turned-off` does not resolve.
    writeSkillFile(
      NodePath.join(homePath, "skills", "turned-off"),
      ["---", "name: turned-off", "description: Switched off.", "---"].join("\n"),
    );
    const harness = makeHarness({ cwd, claudeConfig: { homePath } });
    harness.query.reloadSkillsFailure = new Error("reload failed");
    harness.query.initializationCommands = [
      { name: "deploy", description: "Deploy the app.", argumentHint: "" },
    ];

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const listSkills = adapter.listSkills;
      if (!listSkills) return yield* Effect.die("Claude adapter does not support skill listing");
      const skills = yield* listSkills({ cwd });

      // Initialization succeeded, so its command list survives the reload
      // failure and still filters what the picker offers.
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["deploy"],
      );
      // No SDK skill list means no evidence about model reachability.
      assert.equal(skills[0]?.modelInvocable, undefined);
    }).pipe(
      Effect.provide(harness.layer),
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(cwd, { recursive: true, force: true });
          NodeFS.rmSync(homePath, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("fails when reload fails and the command list gates the scan to nothing", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-gated-empty-"));
    const homePath = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "claude-skills-gated-empty-home-"),
    );
    writeSkillFile(
      NodePath.join(homePath, "skills", "turned-off"),
      ["---", "name: turned-off", "description: Switched off.", "---"].join("\n"),
    );
    const harness = makeHarness({ cwd, claudeConfig: { homePath } });
    harness.query.reloadSkillsFailure = new Error("reload failed");
    harness.query.initializationCommands = [
      { name: "help", description: "Built-in", argumentHint: "" },
    ];

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const listSkills = adapter.listSkills;
      if (!listSkills) return yield* Effect.die("Claude adapter does not support skill listing");
      const error = yield* Effect.flip(listSkills({ cwd }));

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provide(harness.layer),
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(cwd, { recursive: true, force: true });
          NodeFS.rmSync(homePath, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("falls back to scanned skills when Claude skill reload fails", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-degraded-"));
    const homePath = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "claude-skills-degraded-home-"),
    );
    writeSkillFile(
      NodePath.join(homePath, "skills", "deploy"),
      ["---", "name: deploy", "description: Deploy the app.", "---"].join("\n"),
    );
    const harness = makeHarness({ cwd, claudeConfig: { homePath } });
    harness.query.reloadSkillsFailure = new Error("reload failed");

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const listSkills = adapter.listSkills;
      if (!listSkills) return yield* Effect.die("Claude adapter does not support skill listing");
      const skills = yield* listSkills({ cwd });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["deploy"],
      );
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provide(harness.layer),
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(cwd, { recursive: true, force: true });
          NodeFS.rmSync(homePath, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "closes the discovery query when Claude skill reload fails with nothing on disk",
    () => {
      const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-failure-"));
      const homePath = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "claude-skills-failure-home-"),
      );
      const harness = makeHarness({ cwd, claudeConfig: { homePath } });
      harness.query.reloadSkillsFailure = new Error("reload failed");

      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const listSkills = adapter.listSkills;
        if (!listSkills) return yield* Effect.die("Claude adapter does not support skill listing");
        const error = yield* Effect.flip(listSkills({ cwd }));

        // Nothing to serve, so the caller must see the failure and fall back to
        // the provider snapshot rather than cache an empty list.
        assert.equal(error._tag, "ProviderAdapterRequestError");
        assert.equal(harness.query.closeCalls, 1);
      }).pipe(
        Effect.provide(harness.layer),
        Effect.ensuring(
          Effect.sync(() => {
            NodeFS.rmSync(cwd, { recursive: true, force: true });
            NodeFS.rmSync(homePath, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("aborts and closes a pending Claude skill discovery when interrupted", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-interrupt-"));
    const homePath = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "claude-skills-interrupt-home-"),
    );
    const harness = makeHarness({ cwd, claudeConfig: { homePath } });
    let abortObserved = false;
    let markInitializationStarted: () => void = () => {};
    const initializationStarted = new Promise<void>((resolve) => {
      markInitializationStarted = resolve;
    });
    harness.query.initializationResultOverride = () =>
      new Promise<SDKControlInitializeResponse>((_resolve, reject) => {
        markInitializationStarted();
        const signal = harness.getLastCreateQueryInput()?.options.abortController?.signal;
        signal?.addEventListener(
          "abort",
          () => {
            abortObserved = true;
            reject(new Error("discovery aborted"));
          },
          { once: true },
        );
      });

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const listSkills = adapter.listSkills;
      if (!listSkills) return yield* Effect.die("Claude adapter does not support skill listing");

      const fiber = yield* Effect.forkChild(listSkills({ cwd }));
      yield* Effect.promise(() => initializationStarted);
      yield* Fiber.interrupt(fiber);

      assert.equal(abortObserved, true);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provide(harness.layer),
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(cwd, { recursive: true, force: true });
          NodeFS.rmSync(homePath, { recursive: true, force: true });
        }),
      ),
    );
  });

  it("derives pending work from background tasks and session crons", () => {
    assert.equal(hasPendingClaudeWork({}), false);
    assert.equal(hasPendingClaudeWork({ background_tasks: [] }), false);
    assert.equal(hasPendingClaudeWork({ session_crons: [] }), false);
    assert.equal(hasPendingClaudeWork({ background_tasks: [{}] }), true);
    assert.equal(hasPendingClaudeWork({ session_crons: [{}] }), true);
  });

  it.effect("emits subscription usage from the structured usage API on session start", () => {
    const harness = makeHarness();
    // Shape captured live from the SDK usage API.
    harness.query.usageResult = () =>
      Promise.resolve({
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: 44,
            resets_at: "2026-07-31T02:59:59.990712+00:00",
          },
        },
      });

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const usageEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "account.rate-limits.updated",
      ).pipe(Stream.runHead, Effect.forkChild);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const usageEvent = yield* Fiber.join(usageEventFiber);
      assert.equal(usageEvent._tag, "Some");
      if (usageEvent._tag !== "Some") {
        return;
      }
      const payload = usageEvent.value.payload as {
        readonly limits: {
          readonly windows: ReadonlyArray<{ readonly id: string; readonly usedPercent: number }>;
        };
        readonly rateLimits: Record<string, unknown>;
      };
      assert.deepEqual(
        payload.limits.windows.map(({ id, usedPercent }) => ({ id, usedPercent })),
        [{ id: "five_hour", usedPercent: 44 }],
      );
      assert.equal(payload.rateLimits.source, "claude.usage-api");
      assert.equal(payload.rateLimits.subscriptionType, "max");
      assert.isTrue(harness.query.usageCalls >= 1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("reads usage through a minimal ephemeral query without creating a session", () => {
    const harness = makeHarness();
    harness.query.usageResult = () =>
      Promise.resolve({
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          limits: [{ kind: "session", percent: 27, severity: "normal", is_active: true }],
        },
      });

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const usage = yield* adapter.readAccountUsage!();
      assert.deepEqual(usage, {
        source: "claude.usage-api",
        subscriptionType: "max",
        rateLimits: {
          limits: [{ kind: "session", percent: 27, severity: "normal", is_active: true }],
        },
      });
      assert.deepEqual(yield* adapter.listSessions(), []);
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.settings, {
        disableAllHooks: true,
      });
      assert.equal(harness.query.closeCalls, 1);
      assert.equal(harness.query.usageCalls, 1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("returns undefined when ephemeral Claude usage is unavailable", () => {
    const harness = makeHarness();
    harness.query.usageResult = () =>
      Promise.resolve({
        subscription_type: null,
        rate_limits_available: false,
        rate_limits: null,
      });

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      assert.equal(yield* adapter.readAccountUsage!(), undefined);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("closes a pending ephemeral usage query when interrupted", () => {
    const harness = makeHarness();
    let markInitializationStarted: () => void = () => {};
    const initializationStarted = new Promise<void>((resolve) => {
      markInitializationStarted = resolve;
    });
    harness.query.initializationResultOverride = () => {
      markInitializationStarted();
      return new Promise<SDKControlInitializeResponse>(() => undefined);
    };

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const fiber = yield* Effect.forkChild(adapter.readAccountUsage!());
      yield* Effect.promise(() => initializationStarted);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      }
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("closes a stalled ephemeral usage query at the 15 second bound", () => {
    const harness = makeHarness();
    let markInitializationStarted: () => void = () => {};
    const initializationStarted = new Promise<void>((resolve) => {
      markInitializationStarted = resolve;
    });
    harness.query.initializationResultOverride = () => {
      markInitializationStarted();
      return new Promise<SDKControlInitializeResponse>(() => undefined);
    };

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const fiber = yield* Effect.forkChild(adapter.readAccountUsage!());
      yield* Effect.promise(() => initializationStarted);
      yield* TestClock.adjust("15 seconds");

      assert.equal(yield* Fiber.join(fiber), undefined);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("stays silent when the experimental usage API is absent or failing", () => {
    const harness = makeHarness();
    // Models both degradation paths: an SDK that renamed/removed the method
    // (undefined) must not break sessions, and neither must a throwing call.
    harness.query.usageResult = undefined;

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      assert.equal(session.status, "ready");
      assert.equal(harness.query.usageCalls, 0);

      harness.query.usageResult = () => Promise.reject(new Error("usage endpoint unavailable"));
      const secondSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      assert.equal(secondSession.status, "ready");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("does not let a stalled usage request block session startup", () => {
    const harness = makeHarness();
    harness.query.usageResult = () => new Promise<never>(() => undefined);

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.timeout("1 second"));

      assert.equal(session.status, "ready");
      yield* Effect.yieldNow;
      assert.equal(harness.query.usageCalls, 1);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("skips usage emission for sessions without plan rate limits", () => {
    const harness = makeHarness();
    // API-key / Bedrock / Vertex sessions report availability false.
    harness.query.usageResult = () =>
      Promise.resolve({
        subscription_type: null,
        rate_limits_available: false,
        rate_limits: null,
      });

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const events: Array<string> = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event.type);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Effect.yieldNow;

      assert.isTrue(harness.query.usageCalls >= 1);
      assert.isFalse(events.includes("account.rate-limits.updated"));
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect(
    "settles the cwd at the turn boundary when the transcript lags the tool",
    () => {
      const sessionId = "6d1c47a9-32fe-4b08-8e5a-71c0d9b4e2af";
      const workspaceRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-lag-cwd-"));
      const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-lag-home-"));
      const worktreePath = NodePath.join(workspaceRoot, ".claude", "worktrees", "feature");
      const projectDirectory = (cwd: string) =>
        NodePath.join(homePath, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

      // As it is at the moment the tool result arrives: the transcript is still
      // in the old project directory and still reports the old cwd. Observed
      // live — the entry recording the move landed ~2ms after the tool result.
      NodeFS.mkdirSync(projectDirectory(workspaceRoot), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(projectDirectory(workspaceRoot), `${sessionId}.jsonl`),
        `${toTranscriptLine({ type: "user", uuid: "u1", cwd: workspaceRoot })}\n`,
      );

      const harness = makeHarness({ cwd: workspaceRoot, claudeConfig: { homePath } });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const cwdChangedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "session.cwd.changed",
        ).pipe(Stream.runHead, Effect.forkChild);

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
          cwd: workspaceRoot,
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "isolate this work",
          attachments: [],
        });

        harness.query.emit({
          type: "stream_event",
          session_id: sessionId,
          uuid: "stream-lag-1",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "tool-enter-worktree-lag",
              name: "EnterWorktree",
              input: { name: "feature" },
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "user",
          session_id: sessionId,
          uuid: "tool-result-lag-1",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-enter-worktree-lag",
                content: `Created worktree at ${worktreePath} on branch feature.`,
              },
            ],
          },
        } as unknown as SDKMessage);
        yield* Effect.yieldNow;

        // Now the CLI catches up: the transcript is relocated and records the
        // move. Nothing else will tell the adapter about it.
        NodeFS.mkdirSync(projectDirectory(worktreePath), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(projectDirectory(worktreePath), `${sessionId}.jsonl`),
          `${toTranscriptLine({ type: "user", uuid: "u1", cwd: workspaceRoot })}\n${toTranscriptLine(
            {
              type: "assistant",
              uuid: "a1",
              cwd: worktreePath,
            },
          )}\n`,
        );
        NodeFS.rmSync(NodePath.join(projectDirectory(workspaceRoot), `${sessionId}.jsonl`));

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: sessionId,
          uuid: "result-lag-1",
        } as unknown as SDKMessage);

        const event = yield* Fiber.join(cwdChangedFiber);
        const cwdChanged = Option.getOrUndefined(event);
        assert.equal(cwdChanged?.type, "session.cwd.changed");
        assert.deepInclude(cwdChanged?.payload, { cwd: worktreePath });
      }).pipe(
        Effect.provide(harness.layer),
        Effect.scoped,
        Effect.ensuring(
          Effect.sync(() => {
            NodeFS.rmSync(workspaceRoot, { recursive: true, force: true });
            NodeFS.rmSync(homePath, { recursive: true, force: true });
          }),
        ),
      );
    },
    15_000,
  );

  it.effect("emits a cwd change when a worktree tool moves the session", () => {
    const sessionId = "3f2b91c4-8d5e-4a17-9c33-2be7f0a15d84";
    const workspaceRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-wt-cwd-"));
    const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-wt-home-"));
    const worktreePath = NodePath.join(workspaceRoot, ".claude", "worktrees", "feature");

    // Claude relocates the transcript into the project directory derived from
    // the new cwd, and its trailing entries carry that cwd. That file is the
    // only place the move is observable — the CLI does not fire CwdChanged and
    // the stream reports a cwd only in system/init.
    const projectDirectory = NodePath.join(
      homePath,
      "projects",
      worktreePath.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    NodeFS.mkdirSync(projectDirectory, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(projectDirectory, `${sessionId}.jsonl`),
      `${toTranscriptLine({ type: "user", uuid: "u1", cwd: workspaceRoot })}\n${toTranscriptLine({
        type: "assistant",
        uuid: "a1",
        cwd: worktreePath,
      })}\n`,
    );

    const harness = makeHarness({ cwd: workspaceRoot, claudeConfig: { homePath } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const cwdChangedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.cwd.changed",
      ).pipe(Stream.runHead, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        cwd: workspaceRoot,
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "isolate this work",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: sessionId,
        uuid: "stream-wt-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-enter-worktree",
            name: "EnterWorktree",
            input: { name: "feature" },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: sessionId,
        uuid: "tool-result-wt-1",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-enter-worktree",
              content: `Created worktree at ${worktreePath} on branch feature.`,
            },
          ],
        },
      } as unknown as SDKMessage);

      const event = yield* Fiber.join(cwdChangedFiber);
      const cwdChanged = Option.getOrUndefined(event);
      assert.equal(cwdChanged?.type, "session.cwd.changed");
      assert.deepInclude(cwdChanged?.payload, { cwd: worktreePath });
    }).pipe(
      Effect.provide(harness.layer),
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(workspaceRoot, { recursive: true, force: true });
          NodeFS.rmSync(homePath, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("reports the latest Stop hook pending-work state on turn completion", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const firstCompletionFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "schedule a wakeup",
        attachments: [],
      });

      const stopHook = harness.getLastCreateQueryInput()?.options.hooks?.Stop?.[0]?.hooks[0];
      assert.isDefined(stopHook);
      if (!stopHook) {
        return;
      }
      const hookOutput = yield* Effect.promise(() =>
        stopHook(
          {
            session_id: "sdk-session-pending",
            transcript_path: "/tmp/transcript.jsonl",
            cwd: "/tmp",
            hook_event_name: "Stop",
            stop_hook_active: false,
            background_tasks: [],
            session_crons: [
              {
                id: "cron-1",
                schedule: "0 12 16 7 *",
                recurring: false,
                prompt: "wake up",
              },
            ],
          },
          undefined,
          { signal: new AbortController().signal },
        ),
      );
      assert.deepEqual(hookOutput, {});

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-pending",
        uuid: "result-pending",
      } as unknown as SDKMessage);

      const firstCompletion = yield* Fiber.join(firstCompletionFiber);
      assert.equal(firstCompletion._tag, "Some");
      if (firstCompletion._tag !== "Some" || firstCompletion.value.type !== "turn.completed") {
        return;
      }
      assert.equal(firstCompletion.value.payload.hasPendingWork, true);

      const secondCompletionFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "wakeup fired",
        attachments: [],
      });
      yield* Effect.promise(() =>
        stopHook(
          {
            session_id: "sdk-session-pending",
            transcript_path: "/tmp/transcript.jsonl",
            cwd: "/tmp",
            hook_event_name: "Stop",
            stop_hook_active: false,
            background_tasks: [],
            session_crons: [],
          },
          undefined,
          { signal: new AbortController().signal },
        ),
      );
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-pending",
        uuid: "result-cleared",
      } as unknown as SDKMessage);

      const secondCompletion = yield* Fiber.join(secondCompletionFiber);
      assert.equal(secondCompletion._tag, "Some");
      if (secondCompletion._tag !== "Some" || secondCompletion.value.type !== "turn.completed") {
        return;
      }
      assert.equal(secondCompletion.value.payload.hasPendingWork, false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("omits pending work when a new turn completes without a Stop hook observation", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const firstCompletionFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "schedule background work",
        attachments: [],
      });

      const stopHook = harness.getLastCreateQueryInput()?.options.hooks?.Stop?.[0]?.hooks[0];
      assert.isDefined(stopHook);
      if (!stopHook) return;
      yield* Effect.promise(() =>
        stopHook(
          {
            session_id: "sdk-session-pending-reset",
            transcript_path: "/tmp/transcript.jsonl",
            cwd: "/tmp",
            hook_event_name: "Stop",
            stop_hook_active: false,
            background_tasks: [
              {
                id: "background-1",
                type: "subagent",
                status: "running",
                description: "Background task",
              },
            ],
            session_crons: [],
          },
          undefined,
          { signal: new AbortController().signal },
        ),
      );
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-pending-reset",
        uuid: "result-pending-reset",
      } as unknown as SDKMessage);
      yield* Fiber.join(firstCompletionFiber);

      const secondCompletionFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "start a new turn",
        attachments: [],
      });
      harness.query.finish();

      const secondCompletion = yield* Fiber.join(secondCompletionFiber);
      assert.equal(secondCompletion._tag, "Some");
      if (secondCompletion._tag !== "Some" || secondCompletion.value.type !== "turn.completed") {
        return;
      }
      assert.equal("hasPendingWork" in secondCompletion.value.payload, false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forks a persisted Claude session without starting a live query", () => {
    const forkCalls: Array<{
      readonly sessionId: string;
      readonly dir?: string;
      readonly configDirPath: string;
    }> = [];
    const forkSession: NonNullable<ClaudeAdapterLiveOptions["forkSession"]> = async (input) => {
      forkCalls.push(input);
      return { sessionId: "22222222-2222-4222-8222-222222222222" };
    };
    const harness = makeHarness({
      forkSession,
      claudeConfig: { homePath: "~/.claude-fork-work" },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const result = yield* adapter.forkSession!({
        sourceThreadId: ThreadId.make("source-thread"),
        destinationThreadId: ThreadId.make("destination-thread"),
        sourceResumeCursor: {
          threadId: "source-thread",
          resume: "11111111-1111-4111-8111-111111111111",
          turnCount: 3,
        },
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.deepEqual(forkCalls[0], {
        sessionId: "11111111-1111-4111-8111-111111111111",
        dir: "/tmp/project",
        configDirPath: NodePath.join(NodeOS.homedir(), ".claude-fork-work"),
      });
      assert.deepEqual(result.resumeCursor, {
        threadId: "destination-thread",
        resume: "22222222-2222-4222-8222-222222222222",
        turnCount: 3,
      });
      assert.equal(harness.getLastCreateQueryInput(), undefined);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("returns validation error for non-claude provider on startSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const result = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("codex"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "startSession",
          issue: "Expected provider 'claudeAgent' but received 'codex'.",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("retains Claude session startup causes without exposing their messages", () => {
    const cause = new Error("credential material that must remain in the cause chain");
    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            throw cause;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const error = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ProviderAdapterProcessError);
      assert.equal(error.detail, "Failed to start Claude runtime session.");
      assert.strictEqual(error.cause, cause);
      assert.notMatch(error.message, /credential material/u);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("derives bypass permission mode from full-access runtime policy", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("derives auto permission mode from auto runtime policy without skip flag", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "auto",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "auto");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("loads Claude filesystem settings sources for SDK sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, undefined);
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses bypass permissions for full-access claude sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes the configured auto-compaction window to Claude", () => {
    const harness = makeHarness({ claudeConfig: { autoCompactWindow: "300000" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const options = harness.getLastCreateQueryInput()?.options;
      assert.deepEqual(options?.settings, { autoCompactWindow: 300000 });
      assert.deepEqual(options?.supportedDialogKinds, ["resume_return"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude effort levels into query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("runs Claude SDK sessions with the configured CLAUDE_CONFIG_DIR", () => {
    const harness = makeHarness({ claudeConfig: { homePath: "~/.claude-work" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(
        createInput?.options.env?.CLAUDE_CONFIG_DIR,
        NodePath.join(NodeOS.homedir(), ".claude-work"),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rewrites custom model effort into the model id instead of query effort", () => {
    const harness = makeHarness({ claudeConfig: { customModels: ["gpt-5.6-sol"] } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "gpt-5.6-sol",
          [{ id: "effort", value: "medium" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "gpt-5.6-sol(medium)");
      assert.equal(createInput?.options.effort, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes pre-suffixed custom model ids through and ignores the effort option", () => {
    const harness = makeHarness({
      claudeConfig: { customModels: ["gpt-5.6-sol(high)"] },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "gpt-5.6-sol(high)",
          [{ id: "effort", value: "low" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "gpt-5.6-sol(high)");
      assert.equal(createInput?.options.effort, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("filters model and effort launch args for custom models", () => {
    const harness = makeHarness({
      claudeConfig: {
        launchArgs: "--model bypass-model --effort low --chrome",
        customModels: ["gpt-5.6-sol"],
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "gpt-5.6-sol",
          [{ id: "effort", value: "medium" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "gpt-5.6-sol(medium)");
      assert.equal(createInput?.options.effort, undefined);
      assert.deepEqual(createInput?.options.extraArgs, { chrome: null });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude thinking toggle for models that support it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_THINKING_MODEL,
          [{ id: "thinking", value: false }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        alwaysThinkingEnabled: false,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores Claude thinking toggle for models without it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
          [{ id: "thinking", value: false }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.settings, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude fast mode into SDK settings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "fastMode", value: true }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        fastMode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores claude fast mode for models without it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
          [{ id: "fastMode", value: true }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.settings, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("points Claude at the SKILL.md of a user-invocable-only skill reference", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skill-ref-"));
    const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skill-ref-home-"));
    writeSkillFile(
      NodePath.join(homePath, "skills", "writing-great-skills"),
      [
        "---",
        "name: writing-great-skills",
        "description: How to write skills.",
        "disable-model-invocation: true",
        "---",
      ].join("\n"),
    );
    // Model-invocable: Claude reaches this one through its skill tool, so the
    // reference must survive untouched.
    writeSkillFile(
      NodePath.join(homePath, "skills", "codex-review"),
      ["---", "name: codex-review", "description: Ask Codex.", "---"].join("\n"),
    );
    const harness = makeHarness({ cwd, claudeConfig: { homePath } });
    harness.query.reloadSkillsResult = {
      skills: [{ name: "codex-review", description: "Ask Codex.", argumentHint: "" }],
    };

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Rewrite it per $writing-great-skills then run $codex-review",
        attachments: [],
      });

      const message = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      const content = message?.message.content;
      assert.isArray(content);
      const blocks = Array.isArray(content) ? content : [];
      assert.deepEqual(
        blocks.map((block) => (block.type === "text" ? block.text : block.type)),
        [
          `Rewrite it per /writing-great-skills [Read: ${NodePath.join(
            homePath,
            "skills",
            "writing-great-skills",
            "SKILL.md",
          )}] then run`,
          "/codex-review",
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(cwd, { recursive: true, force: true });
          NodeFS.rmSync(homePath, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("leaves a message without skill references untouched", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skill-noref-"));
    const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skill-noref-home-"));
    writeSkillFile(
      NodePath.join(homePath, "skills", "writing-great-skills"),
      [
        "---",
        "name: writing-great-skills",
        "description: How to write skills.",
        "disable-model-invocation: true",
        "---",
      ].join("\n"),
    );
    const harness = makeHarness({ cwd, claudeConfig: { homePath } });

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Just a normal message",
        attachments: [],
      });

      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.equal(promptText, "Just a normal message");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(cwd, { recursive: true, force: true });
          NodeFS.rmSync(homePath, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("tells the agent when a turn was stranded rather than stopped by the user", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Status?",
        attachments: [],
        priorTurnEndedUnrequested: true,
      });

      // One read only: the prompt is a single-shot async iterable.
      const message = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      const content = message?.message.content;
      assert.isArray(content);
      const blocks = Array.isArray(content) ? content : [];
      assert.equal(blocks.length, 2);
      // The notice leads, so it is read before the message it explains.
      const [notice, prompt] = blocks;
      assert.equal(notice?.type, "text");
      assert.include(notice?.type === "text" ? notice.text : "", "not because the user stopped it");
      assert.equal(prompt?.type === "text" ? prompt.text : "", "Status?");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("leaves an ordinary turn's prompt untouched", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Status?",
        attachments: [],
      });

      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.equal(promptText, "Status?");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "keeps a configured custom alias opaque without disabling the canonical built-in",
    () => {
      const claudeConfig = { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] };
      const customHarness = makeHarness({ claudeConfig });
      const builtInHarness = makeHarness({ claudeConfig });
      const start = (harness: ReturnType<typeof makeHarness>, model: string) =>
        Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: ProviderDriverKind.make("claudeAgent"),
            modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), model, [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
              { id: "contextWindow", value: "expanded" },
            ]),
            runtimeMode: "full-access",
          });
          return harness.getLastCreateQueryInput()!.options;
        }).pipe(
          Effect.provideService(Random.Random, makeDeterministicRandomService()),
          Effect.provide(harness.layer),
        );
      const runCustomFlow = Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
            [
              { id: "effort", value: "high" },
              { id: "fastMode", value: true },
              { id: "contextWindow", value: "expanded" },
            ],
          ),
          runtimeMode: "full-access",
        });
        const options = customHarness.getLastCreateQueryInput()!.options;

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "use the built-in model",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            SYNTHETIC_CLAUDE_CAPABLE_MODEL,
            [{ id: "contextWindow", value: "expanded" }],
          ),
          attachments: [],
        });
        yield* Effect.promise(() => readFirstPromptText(customHarness.getLastCreateQueryInput()));
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "keep this prompt literal",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
            [{ id: "effort", value: "ultrathink" }],
          ),
          attachments: [],
        });
        const prompt = yield* Effect.promise(() =>
          readFirstPromptText(customHarness.getLastCreateQueryInput()),
        );
        return { options, prompt };
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(customHarness.layer),
      );

      return Effect.gen(function* () {
        const { options: customOptions, prompt: customPrompt } = yield* runCustomFlow;
        assert.equal(customOptions.model, `${SYNTHETIC_CLAUDE_COLLIDING_ALIAS}(high)`);
        assert.equal(customOptions.effort, undefined);
        assert.equal(customOptions.settings, undefined);
        assert.deepEqual(customHarness.query.setModelCalls, [
          `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`,
          `${SYNTHETIC_CLAUDE_COLLIDING_ALIAS}(high)`,
        ]);
        assert.equal(customPrompt, "keep this prompt literal");

        const builtInOptions = yield* start(builtInHarness, SYNTHETIC_CLAUDE_CAPABLE_MODEL);
        assert.equal(builtInOptions.model, `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`);
        assert.equal(builtInOptions.effort, "max");
        assert.deepEqual(builtInOptions.settings, { fastMode: true });
      });
    },
  );

  it.effect("treats ultrathink as a prompt keyword instead of a session effort", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
          [{ id: "effort", value: "ultrathink" }],
        ),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Investigate the edge cases",
        attachments: [],
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
          [{ id: "effort", value: "ultrathink" }],
        ),
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
      const promptText = yield* Effect.promise(() => readFirstPromptText(createInput));
      assert.equal(promptText, "Ultrathink:\nInvestigate the edge cases");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps compact commands intact when ultrathink is selected", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const modelSelection = createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        SYNTHETIC_CLAUDE_STANDARD_MODEL,
        [{ id: "effort", value: "ultrathink" }],
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/compact",
        attachments: [],
        modelSelection,
      });

      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.equal(promptText, "/compact");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("embeds image attachments in Claude user messages", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          NodeFS.rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const attachment = {
        type: "image" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment)!);
      NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
      NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "What's in this image?",
        attachments: [attachment],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      assert.deepEqual(promptMessage?.message.content, [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        },
        {
          type: "text",
          text: "What's in this image?",
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // The Claude CLI reads a streamed user message as a slash-command invocation
  // only when the final content block is text. Leading with the text block sent
  // every image-carrying turn down the plain-prompt path, so `/skill args`
  // reached the agent unexpanded with no error anywhere.
  it.effect("puts the command text last so attachments do not suppress expansion", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-command-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          NodeFS.rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const imageAttachment = {
        type: "image" as const,
        id: "thread-claude-attachment-22345678-1234-1234-1234-123456789abc",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const fileAttachment = {
        type: "file" as const,
        id: "thread-claude-attachment-32345678-1234-1234-1234-123456789abc",
        name: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      };
      for (const attachment of [imageAttachment, fileAttachment]) {
        const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment)!);
        NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
        NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));
      }

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/flow-patterns hello",
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/flow-patterns hello",
        attachments: [imageAttachment],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/flow-patterns hello",
        attachments: [fileAttachment],
      });

      const prompts = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 3),
      );
      const commandBlock = {
        type: "text" as const,
        text: "/flow-patterns hello",
      };

      assert.deepEqual(prompts[0]?.message.content, [commandBlock]);
      assert.deepEqual(prompts[1]?.message.content, [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        },
        commandBlock,
      ]);
      // Non-image attachments never become content blocks. Claude reaches them
      // through the path line ProviderService writes into the prompt, so the
      // text block stays last on its own.
      assert.deepEqual(prompts[2]?.message.content, [commandBlock]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("dispatches a $skill mention as a trailing slash command block", () => {
    // Claude Code only runs `/name` from the message's last text block, so a
    // chip picked mid-prompt is moved there and the surrounding prose kept.
    const homeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-home-"));
    NodeFS.mkdirSync(NodePath.join(homeDir, "skills", "implement"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(homeDir, "skills", "implement", "SKILL.md"),
      "---\ndescription: Implement the tickets.\n---\n# Body\n",
    );
    const harness = makeHarness({ claudeConfig: { homePath: homeDir } });
    harness.query.reloadSkillsResult = {
      skills: [{ name: "implement", description: "Implement the tickets.", argumentHint: "" }],
    };
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(homeDir, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "ok, now $implement all the tickets\nstart with auth",
        attachments: [],
      });

      const promptMessage = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      assert.deepEqual(promptMessage?.message.content, [
        { type: "text", text: "ok, now" },
        { type: "text", text: "/implement all the tickets\nstart with auth" },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the skill command block after image attachments", () => {
    // A command block followed by an image is not expanded by the CLI; the
    // image must come first.
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skill-image-"));
    const homeDir = NodePath.join(baseDir, "claude-home");
    NodeFS.mkdirSync(NodePath.join(homeDir, "skills", "review"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(homeDir, "skills", "review", "SKILL.md"),
      "---\ndescription: Review.\n---\n# Body\n",
    );
    const harness = makeHarness({ baseDir, claudeConfig: { homePath: homeDir } });
    harness.query.reloadSkillsResult = {
      skills: [{ name: "review", description: "Review.", argumentHint: "" }],
    };
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      const attachment = {
        type: "image" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment)!);
      NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
      NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "$review this screenshot",
        attachments: [attachment],
      });

      const promptMessage = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      assert.isDefined(promptMessage);
      const blocks = promptMessage.message.content as Array<{ type: string; text?: string }>;
      assert.deepEqual(
        blocks.map((block) => (block.type === "text" ? block.text : block.type)),
        ["image", "/review this screenshot"],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("leaves a $ mention of an unknown or disabled skill as prose", () => {
    const homeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-skills-off-"));
    NodeFS.mkdirSync(NodePath.join(homeDir, "skills", "deploy"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(homeDir, "skills", "deploy", "SKILL.md"),
      "---\ndescription: Deploy.\n---\n# Body\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(homeDir, "settings.json"),
      JSON.stringify({ skillOverrides: { deploy: "off" } }),
    );
    const harness = makeHarness({ claudeConfig: { homePath: homeDir } });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(homeDir, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run $deploy and echo $HOME",
        attachments: [],
      });

      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.equal(promptText, "run $deploy and echo $HOME");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude stream/runtime messages to canonical provider runtime events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
        },
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-0",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-3",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "ls",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-4",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-1",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          content: [{ type: "text", text: "Hi" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-1",
        uuid: "result-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "turn.completed",
        ],
      );

      const turnStarted = runtimeEvents[3];
      assert.equal(turnStarted?.type, "turn.started");
      if (turnStarted?.type === "turn.started") {
        assert.equal(String(turnStarted.turnId), String(turn.turnId));
      }

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Hi");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "command_execution");
      }

      const assistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      assert.equal(
        assistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          assistantCompletedIndex < toolStartedIndex,
        true,
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("places overage-included rate-limit events on the bucket the probe named", () => {
    const scopedLimitNames = Ref.makeUnsafe<ClaudeScopedLimitNames>({ overageIncluded: undefined });
    const harness = makeHarness({ scopedLimitNames });
    const rateLimitEvent = (utilization: number): SDKMessage =>
      ({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "seven_day_overage_included",
          utilization,
        },
        uuid: `rate-limit-${utilization}`,
        session_id: "sdk-session-1",
      }) as unknown as SDKMessage;
    const resultMessage = (uuid: string): SDKMessage =>
      ({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 1,
        session_id: "sdk-session-1",
        uuid,
      }) as unknown as SDKMessage;
    // The fork emits the raw event beside the typed windows, so filter to the
    // typed half: before the probe names the bucket only the raw half rides.
    const limitsUpdates = (events: Iterable<ProviderRuntimeEvent>) =>
      Array.from(events).flatMap((event) =>
        event.type === "account.rate-limits.updated" && event.payload.limits !== undefined
          ? [event.payload.limits]
          : [],
      );
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // Before any probe names the bucket the event has nowhere to land.
      // Collecting through the turn's completion proves the SDK message was
      // handled, not merely still queued.
      const firstTurnFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit(rateLimitEvent(0.2));
      harness.query.emit(resultMessage("result-1"));
      assert.deepStrictEqual(limitsUpdates(yield* Fiber.join(firstTurnFiber)), []);

      // The status probe reads `get_usage` and records the model it saw.
      yield* Ref.set(scopedLimitNames, { overageIncluded: "Fable" });
      const secondTurnFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId: session.threadId, input: "again", attachments: [] });
      harness.query.emit(rateLimitEvent(0.4));
      harness.query.emit(resultMessage("result-2"));
      assert.deepStrictEqual(limitsUpdates(yield* Fiber.join(secondTurnFiber)), [
        {
          windows: [
            {
              id: "seven_day_fable",
              kind: "weekly",
              label: "Weekly · Fable",
              usedPercent: 40,
              windowDurationMins: 10_080,
            },
          ],
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not emit turn.completed for a result with no active turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Collect through session.exited so the window after the second result
      // is deterministically inside the collection: both results are queued
      // after sendTurn returns and drain in order on the one stream consumer.
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 1,
        session_id: "sdk-session-1",
        uuid: "result-real",
      } as unknown as SDKMessage);

      // Second result with no turn in flight — the shape the resume
      // handshake (system/init + result(num_turns: 0)) delivers, and the
      // same completeTurn branch every no-turnState result lands in. This
      // used to emit an untargeted turn.completed; it must emit nothing.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        session_id: "sdk-session-1",
        uuid: "result-handshake",
      } as unknown as SDKMessage);

      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const completions = runtimeEvents.filter((event) => event.type === "turn.completed");
      // Exactly one completion — the real turn's, targeted at its turn id.
      // The buggy branch produced a second, untargeted one here.
      assert.equal(completions.length, 1);
      const completed = completions[0];
      if (completed?.type === "turn.completed") {
        assert.equal(String(completed.turnId), String(turn.turnId));
        assert.equal(completed.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("steers a running turn instead of opening a new one on mid-turn sendTurn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run 5 commands",
        attachments: [],
      });

      // Steer: a second sendTurn while the turn is still running continues
      // the same turn — the message is queued into the live agent loop.
      const steeredTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "actually run 15",
        attachments: [],
      });
      assert.equal(String(steeredTurn.turnId), String(turn.turnId));

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-steer",
        uuid: "assistant-steer-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-steer-1",
          content: [{ type: "text", text: "Adjusting to 15." }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-steer",
        uuid: "result-steer-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const turnStartedEvents = runtimeEvents.filter((event) => event.type === "turn.started");
      const turnCompletedEvents = runtimeEvents.filter((event) => event.type === "turn.completed");

      // One turn boundary for the whole run: the steer produced no
      // turn.completed/turn.started pair.
      assert.equal(turnStartedEvents.length, 1);
      assert.equal(String(turnStartedEvents[0]?.turnId), String(turn.turnId));
      assert.equal(turnCompletedEvents.length, 1);
      assert.equal(String(turnCompletedEvents[0]?.turnId), String(turn.turnId));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude reasoning deltas, streamed tool inputs, and tool results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-thinking",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Let",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-grep-1",
            name: "Grep",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-input-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"pattern":"foo","path":"src"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-tool-streams",
        uuid: "user-tool-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-grep-1",
              content: "src/example.ts:1:foo",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-tool-streams",
        uuid: "result-tool-streams",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.started",
          "item.updated",
          "item.updated",
          "item.completed",
          "turn.completed",
        ],
      );

      const reasoningDelta = runtimeEvents.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      assert.equal(reasoningDelta?.type, "content.delta");
      if (reasoningDelta?.type === "content.delta") {
        assert.equal(reasoningDelta.payload.delta, "Let");
        assert.equal(String(reasoningDelta.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "dynamic_tool_call");
      }

      const toolInputUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { input?: { pattern?: string; path?: string } } | undefined)?.input
            ?.pattern === "foo",
      );
      assert.equal(toolInputUpdated?.type, "item.updated");
      if (toolInputUpdated?.type === "item.updated") {
        assert.deepEqual(toolInputUpdated.payload.data, {
          toolName: "Grep",
          input: {
            pattern: "foo",
            path: "src",
          },
        });
      }

      const toolResultUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { result?: { tool_use_id?: string } } | undefined)?.result
            ?.tool_use_id === "tool-grep-1",
      );
      assert.equal(toolResultUpdated?.type, "item.updated");
      if (toolResultUpdated?.type === "item.updated") {
        assert.equal(
          (
            toolResultUpdated.payload.data as {
              result?: { content?: string };
            }
          ).result?.content,
          "src/example.ts:1:foo",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies only streamed Read image inputs as image views", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "inspect both files",
        attachments: [],
      });

      const imagePath = `/workspace/${"nested folder/".repeat(16)}reference image.webp`;
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-read-image",
        uuid: "read-image-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-read-image",
            name: "Read",
            input: {},
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-read-image",
        uuid: "read-image-input",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: encodeUnknownJsonString({ file_path: imagePath }),
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-read-image",
        uuid: "read-image-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-read-image",
              content: "Image Size: 1280x720.",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-read-image",
        uuid: "read-text-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-read-text",
            name: "Read",
            input: { file_path: "/workspace/src/index.ts" },
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-read-image",
        uuid: "read-text-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-read-text",
              content: "export {};",
            },
          ],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-read-image",
        uuid: "read-image-turn-result",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const imageEvents = runtimeEvents.filter(
        (
          event,
        ): event is Extract<
          ProviderRuntimeEvent,
          { type: "item.started" | "item.updated" | "item.completed" }
        > =>
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          String(event.itemId) === "tool-read-image",
      );
      assert.deepEqual(
        imageEvents.map((event) => [event.type, event.payload.itemType]),
        [
          ["item.started", "dynamic_tool_call"],
          ["item.updated", "image_view"],
          ["item.updated", "image_view"],
          ["item.completed", "image_view"],
        ],
      );
      for (const event of imageEvents.slice(1)) {
        assert.equal(event.payload.detail, imagePath);
        assert.equal(
          (event.payload.data as { input?: { file_path?: string } } | undefined)?.input?.file_path,
          imagePath,
        );
      }

      const textEvents = runtimeEvents.filter(
        (
          event,
        ): event is Extract<
          ProviderRuntimeEvent,
          { type: "item.started" | "item.updated" | "item.completed" }
        > =>
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          String(event.itemId) === "tool-read-text",
      );
      assert.deepEqual(
        textEvents.map((event) => event.payload.itemType),
        ["dynamic_tool_call", "dynamic_tool_call", "dynamic_tool_call"],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to a default plan step label for blank TodoWrite content", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-todo-1",
            name: "TodoWrite",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-input",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json:
              '{"todos":[{"content":"   ","status":"in_progress"},{"content":"Ship it","status":"completed"}]}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-todo-plan",
        uuid: "result-todo-plan",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const planUpdated = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.equal(planUpdated?.type, "turn.plan.updated");
      if (planUpdated?.type === "turn.plan.updated") {
        assert.equal(String(planUpdated.turnId), String(turn.turnId));
        assert.deepEqual(planUpdated.payload.plan, [
          { step: "Task", status: "inProgress" },
          { step: "Ship it", status: "completed" },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Claude Task tool invocations as collaboration agent work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task",
        uuid: "stream-task-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: {
              description: "Review the database layer",
              prompt: "Audit the SQL changes",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-task",
        uuid: "assistant-task-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-task-1",
          content: [{ type: "text", text: "Delegated" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task",
        uuid: "result-task-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "collab_agent_tool_call");
        assert.equal(toolStarted.payload.title, "Subagent task");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect.each<{ terminalReason: string }>([
    { terminalReason: "interrupted" },
    { terminalReason: "aborted_tools" },
    { terminalReason: "aborted_streaming" },
  ])(
    "treats Claude $terminalReason results as interrupted, hiding ede_diagnostic errors",
    ({ terminalReason }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        const diagnostic =
          "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use";
        harness.query.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [diagnostic],
          stop_reason: "tool_use",
          terminal_reason: terminalReason,
          session_id: "sdk-session-terminal-abort",
          uuid: `result-${terminalReason}`,
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.map((event) => event.type),
          [
            "session.started",
            "session.configured",
            "session.state.changed",
            "turn.started",
            "thread.started",
            "turn.completed",
          ],
        );

        const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
        assert.equal(turnCompleted?.type, "turn.completed");
        if (turnCompleted?.type === "turn.completed") {
          assert.equal(String(turnCompleted.turnId), String(turn.turnId));
          assert.equal(turnCompleted.payload.state, "interrupted");
          // "[ede_diagnostic] ..." is CLI-internal telemetry, never a banner.
          assert.equal(turnCompleted.payload.errorMessage, undefined);
          assert.equal(turnCompleted.payload.stopReason, "tool_use");
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("keeps non-abort Claude terminal reasons failed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const errorMessage = "Model error.";
      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [errorMessage],
        terminal_reason: "model_error",
        session_id: "sdk-session-model-error",
        uuid: "result-model-error",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "runtime.error",
          "turn.completed",
        ],
      );

      const runtimeError = runtimeEvents[runtimeEvents.length - 2];
      assert.equal(runtimeError?.type, "runtime.error");
      if (runtimeError?.type === "runtime.error") {
        assert.equal(runtimeError.payload.message, errorMessage);
      }

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "failed");
        assert.equal(turnCompleted.payload.errorMessage, errorMessage);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats user-aborted Claude results as interrupted without a runtime error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Error: Request was aborted."],
        stop_reason: "tool_use",
        session_id: "sdk-session-abort",
        uuid: "result-abort",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Error: Request was aborted.");
        assert.equal(turnCompleted.payload.stopReason, "tool_use");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats aborted_tools results as interrupted and hides ede_diagnostic errors", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      // Exact shape the CLI emits when Stop lands mid-tool-call: is_error
      // is true and the only error is internal diagnostic telemetry.
      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
        stop_reason: "tool_use",
        terminal_reason: "aborted_tools",
        session_id: "sdk-session-abort-tools",
        uuid: "result-abort-tools",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("interruptTurn settles live tasks and closes the provider session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Wait for the three task.* runtime events to prove the lifecycle
      // handlers processed the emissions (no wall-clock sleeps under the
      // test clock).
      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn agents",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-live",
        description: "Agent A",
        task_type: "local_agent",
        uuid: "task-live-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-settled",
        description: "Agent B",
        task_type: "local_agent",
        uuid: "task-settled-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-settled",
        status: "completed",
        output_file: "/tmp/task-settled.jsonl",
        summary: "done",
        uuid: "task-settled-done-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      yield* Fiber.join(taskEventsFiber);

      const stoppedTaskEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.interruptTurn(session.threadId);

      // Closing the session is the hard stop because SDK interrupt can leave
      // resumed background work alive.
      assert.equal(harness.query.closeCalls, 1);

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);

      const stoppedTaskEvents = Array.from(yield* Fiber.join(stoppedTaskEventFiber));
      assert.equal(stoppedTaskEvents.length, 1);
      const stoppedTaskEvent = stoppedTaskEvents[0];
      assert.equal(stoppedTaskEvent?.type, "task.completed");
      if (stoppedTaskEvent?.type === "task.completed") {
        assert.equal(String(stoppedTaskEvent.payload.taskId), "task-live");
        assert.equal(stoppedTaskEvent.payload.status, "stopped");
        assert.equal(stoppedTaskEvent.payload.taskType, "local_agent");
        assert.equal(stoppedTaskEvent.payload.title, "Agent A");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the session available when process close fails", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.closeError = new Error("close failed");

      const result = yield* adapter.interruptTurn(session.threadId).pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterProcessError");
      }
      assert.equal(harness.query.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(session.threadId), true);
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stopAll attempts every session when one process close fails", () => {
    const queries: FakeClaudeQuery[] = [];
    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            const query = new FakeClaudeQuery();
            queries.push(query);
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const firstQuery = queries[0];
      if (!firstQuery) {
        return;
      }
      firstQuery.closeError = new Error("close failed");

      const result = yield* adapter.stopAll().pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(queries[0]?.closeCalls, 1);
      assert.equal(queries[1]?.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);
      assert.equal(yield* adapter.hasSession(RESUME_THREAD_ID), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("completes with result usage without querying current context usage", () => {
    const harness = makeHarness();
    let getContextUsageCalls = 0;
    Object.assign(harness.query, {
      getContextUsage: async () => {
        getContextUsageCalls += 1;
        return {
          totalTokens: 999,
          maxTokens: 200000,
          isAutoCompactEnabled: true,
        };
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-result-usage",
        uuid: "assistant-result-usage-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-result-usage-1",
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 80,
            output_tokens: 20,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-result-usage",
        uuid: "assistant-result-usage-2",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-result-usage-2",
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 180,
            output_tokens: 20,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-result-usage",
        uuid: "assistant-result-usage-3",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-result-usage-3",
          role: "assistant",
          content: [],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: {
          input_tokens: 400,
          output_tokens: 50,
        },
        modelUsage: {
          [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(getContextUsageCalls, 0);
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload.usage, {
          usedTokens: 200,
          lastUsedTokens: 200,
          totalProcessedTokens: 450,
          inputTokens: 180,
          outputTokens: 20,
          maxTokens: 200000,
          compactsAutomatically: true,
        });
      }
      assert.equal(
        runtimeEvents.find((event) => event.type === "turn.completed")?.type,
        "turn.completed",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves compacted usage when completion follows an older assistant frame", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-compacted-usage",
        uuid: "assistant-compacted-usage",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-compacted-usage",
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 180,
            output_tokens: 20,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          pre_tokens: 200,
          post_tokens: 40,
        },
        session_id: "sdk-session-compacted-usage",
        uuid: "compact-boundary-usage",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { post_tokens: 40 },
        session_id: "sdk-session-compacted-usage",
        uuid: "compact-boundary-post-usage",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 2,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-compacted-usage",
        usage: {
          input_tokens: 400,
          output_tokens: 50,
        },
        modelUsage: {
          [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const compactionEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "thread.state.changed" }> =>
          event.type === "thread.state.changed" && event.payload.state === "compacted",
      );
      assert.equal(compactionEvents[0]?.payload.beforeTokens, 200);
      assert.equal(compactionEvents[0]?.payload.afterTokens, 40);
      assert.equal(compactionEvents[1]?.payload.beforeTokens, undefined);
      assert.equal(compactionEvents[1]?.payload.afterTokens, 40);
      const finalUsageEvent = runtimeEvents.findLast(
        (event) => event.type === "thread.token-usage.updated",
      );
      assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
      if (finalUsageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(finalUsageEvent.payload.usage, {
          usedTokens: 40,
          totalProcessedTokens: 450,
          maxTokens: 200000,
          compactsAutomatically: true,
        });
      }
      assert.equal(
        runtimeEvents.find((event) => event.type === "turn.completed")?.type,
        "turn.completed",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("workflow member coalescing: identical snapshots suppress, changes emit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Collect task.progress until member-0's tick-3 emission lands, then
      // evaluate member emissions.
      const progressFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.progress"),
        Stream.takeUntil(
          // Sentinel: member-0's tick-3 emission (tokens 20) — members are
          // emitted after the coordinator row within a tick.
          (event) =>
            (event.payload as { taskId?: string }).taskId === "wf-coalesce:wf:0" &&
            (event.payload as { typedUsage?: { totalTokens?: number } }).typedUsage?.totalTokens ===
              20,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run workflow",
        attachments: [],
      });

      const memberSnapshot = (tokens: number) => [
        { type: "workflow_phase", index: 0, title: "Work" },
        {
          type: "workflow_agent",
          index: 0,
          state: "running",
          label: "member-0",
          phaseIndex: 0,
          tokens,
        },
        {
          type: "workflow_agent",
          index: 1,
          state: "running",
          label: "member-1",
          phaseIndex: 0,
          tokens: 50,
        },
      ];
      const tick = (usageTotal: number, snapshot: ReturnType<typeof memberSnapshot>) =>
        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "wf-coalesce",
          description: "Coalescing workflow",
          usage: { total_tokens: usageTotal, tool_uses: 1, duration_ms: 10 },
          workflow_progress: snapshot,
          uuid: `wf-tick-${usageTotal}`,
          session_id: "sdk-session",
        } as unknown as SDKMessage);

      // Tick 1: both members are new -> 2 member events.
      tick(100, memberSnapshot(10));
      // Tick 2: IDENTICAL member snapshot -> 0 member events (coordinator
      // usage changed, but members did not).
      tick(200, memberSnapshot(10));
      // Tick 3: member-0's tokens advanced -> exactly 1 member event.
      tick(300, memberSnapshot(20));

      const progressEvents = Array.from(yield* Fiber.join(progressFiber));
      const byMember = new Map<string, number>();
      for (const event of progressEvents) {
        const taskId = (event.payload as { taskId: string }).taskId;
        if (!taskId.includes(":wf:")) continue;
        byMember.set(taskId, (byMember.get(taskId) ?? 0) + 1);
      }
      // member-0: tick 1 + tick 3. member-1: tick 1 only (tick 2 identical,
      // tick 3 unchanged).
      assert.equal(byMember.get("wf-coalesce:wf:0"), 2);
      assert.equal(byMember.get("wf-coalesce:wf:1"), 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("task.started carries model/effort; subagent snapshots refine the model", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn an agent",
        attachments: [],
      });

      // No explicit model/effort on the launch input: the task inherits the
      // session's selection.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-model",
        description: "Agent M",
        task_type: "local_agent",
        tool_use_id: "toolu_agent_m",
        uuid: "task-model-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      // The subagent's assistant snapshot carries the authoritative API
      // model id, which refines the linkage on later rows.
      harness.query.emit({
        type: "assistant",
        parent_tool_use_id: "toolu_agent_m",
        message: {
          model: SYNTHETIC_SUBAGENT_MODEL,
          content: [],
        },
        uuid: "subagent-snapshot-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-model",
        description: "Agent M",
        usage: { total_tokens: 100, tool_uses: 1, duration_ms: 10 },
        uuid: "task-model-progress-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
      const started = taskEvents[0];
      assert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        assert.equal(started.payload.model, SYNTHETIC_CLAUDE_CAPABLE_MODEL);
        assert.equal(started.payload.effort, "max");
      }
      const progress = taskEvents[1];
      assert.equal(progress?.type, "task.progress");
      if (progress?.type === "task.progress") {
        assert.equal(progress.payload.model, SYNTHETIC_SUBAGENT_MODEL);
        assert.equal(progress.payload.effort, "max");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("a subagent snapshot that beats task_started still wins over the seed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const taskEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("task.")),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "spawn an agent",
        attachments: [],
      });

      // The subagent streams its first assistant snapshot before the task is
      // registered, so there is no agent to refine yet.
      harness.query.emit({
        type: "assistant",
        parent_tool_use_id: "toolu_agent_early",
        message: {
          model: SYNTHETIC_SUBAGENT_MODEL,
          content: [],
        },
        uuid: "early-snapshot-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-early",
        description: "Agent E",
        task_type: "local_agent",
        tool_use_id: "toolu_agent_early",
        uuid: "task-early-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-early",
        description: "Agent E",
        usage: { total_tokens: 100, tool_uses: 1, duration_ms: 10 },
        uuid: "task-early-progress-uuid",
        session_id: "sdk-session",
      } as unknown as SDKMessage);

      const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
      const started = taskEvents[0];
      assert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        assert.equal(started.payload.model, SYNTHETIC_SUBAGENT_MODEL);
        assert.equal(started.payload.effort, "max");
      }
      const progress = taskEvents[1];
      assert.equal(progress?.type, "task.progress");
      if (progress?.type === "task.progress") {
        assert.equal(progress.payload.model, SYNTHETIC_SUBAGENT_MODEL);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes the session when the Claude stream aborts after a turn starts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("All fibers interrupted without error"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "turn.completed",
          "session.exited",
        ],
      );

      const turnCompleted = runtimeEvents[4];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Claude runtime interrupted.");
      }

      const sessionExited = runtimeEvents[5];
      assert.equal(sessionExited?.type, "session.exited");

      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps Claude stream failure events structural", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("credential material that must stay in the cause chain"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();

      const runtimeError = runtimeEvents.find((event) => event.type === "runtime.error");
      assert.equal(runtimeError?.type, "runtime.error");
      if (runtimeError?.type === "runtime.error") {
        assert.equal(runtimeError.payload.message, "Claude runtime stream failed.");
        assert.deepEqual(runtimeError.payload.detail, {
          failureCount: 1,
          failureTags: ["ProviderAdapterProcessError"],
        });
      }

      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
        assert.equal(completed.payload.errorMessage, "Claude runtime stream failed.");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes the previous session before replacing an existing thread session", () => {
    const queries: FakeClaudeQuery[] = [];
    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            const query = new FakeClaudeQuery();
            queries.push(query);
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const firstSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const secondSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        resumeCursor: firstSession.resumeCursor,
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const activeSessions = yield* adapter.listSessions();

      assert.equal(queries.length, 2);
      assert.equal(queries[0]?.closeCalls, 1);
      assert.equal(queries[1]?.closeCalls, 0);
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);
      assert.equal(activeSessions.length, 1);
      assert.deepEqual(activeSessions[0]?.resumeCursor, secondSession.resumeCursor);
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "session.started",
          "session.configured",
          "session.state.changed",
        ],
      );
      assert.equal(
        runtimeEvents.some((event) => event.type === "session.exited"),
        false,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("stopSession does not throw into the SDK prompt consumer", () => {
    // The SDK consumes user messages via `for await (... of prompt)`.
    // Stopping a session must end that loop cleanly — not throw an error.
    //
    // FakeClaudeQuery.close() masks this by resolving pending iterators
    // before the shutdown propagates. Override it to match real SDK behavior
    // where close() does not resolve the prompt consumer.
    const query = new FakeClaudeQuery();
    (query as { close: () => void }).close = () => {
      query.closeCalls += 1;
    };

    let promptConsumerError: unknown = undefined;

    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: (input) => {
            // Simulate the SDK consuming the prompt iterable
            (async () => {
              try {
                for await (const _message of input.prompt) {
                  /* SDK processes user messages */
                }
              } catch (error) {
                promptConsumerError = error;
              }
            })();
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.runForEach(
        adapter.streamEvents,
        () => Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(THREAD_ID);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;

      runtimeEventsFiber.interruptUnsafe();

      assert.equal(
        promptConsumerError,
        undefined,
        `Prompt consumer should not receive a thrown error on session stop, ` +
          `but got: "${promptConsumerError instanceof Error ? promptConsumerError.message : String(promptConsumerError)}"`,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("forwards Claude task progress summaries for subagent updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-subagent-1",
        description: "Running background teammate",
        summary: "Code reviewer checked the migration edge cases.",
        usage: {
          total_tokens: 123,
          tool_uses: 4,
          duration_ms: 987,
        },
        session_id: "sdk-session-task-summary",
        uuid: "task-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(
          progressEvent.payload.summary,
          "Code reviewer checked the migration edge cases.",
        );
        assert.equal(progressEvent.payload.description, "Running background teammate");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("consumes undeclared and UX-internal system subtypes without warning rows", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // Undeclared wire-only roster snapshot + every typed UX-internal
      // subtype and top-level type consumed silently: none may surface as
      // unknown-subtype warnings.
      for (const message of [
        {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "t1", task_type: "local_agent", description: "Say hi" }],
          session_id: "session",
          uuid: "roster",
        },
        {
          type: "system",
          subtype: "vcs_state_changed",
          kind: "push",
          cwd: "/tmp/worktree",
          session_id: "session",
          uuid: "vcs",
        },
        {
          type: "system",
          subtype: "code_change_published",
          provider: "github",
          url: "https://github.com/pingdotgg/t3code/pull/1",
          repo: "pingdotgg/t3code",
          identifier: "1",
          session_id: "session",
          uuid: "ccp",
        },
        {
          type: "system",
          subtype: "task_updated",
          task_id: "t1",
          patch: { status: "running" },
          session_id: "session",
          uuid: "tu",
        },
        { type: "system", subtype: "commands_changed", session_id: "session", uuid: "cc" },
        { type: "system", subtype: "model_refusal_fallback", session_id: "session", uuid: "mrf" },
        { type: "system", subtype: "local_command_output", session_id: "session", uuid: "lco" },
        { type: "system", subtype: "plugin_install", session_id: "session", uuid: "pi" },
        { type: "system", subtype: "memory_recall", session_id: "session", uuid: "mr" },
        { type: "system", subtype: "elicitation_complete", session_id: "session", uuid: "ec" },
        { type: "prompt_suggestion", suggestion: "try this", session_id: "session", uuid: "ps" },
        {
          type: "system",
          subtype: "notification",
          key: "context",
          text: "low priority note",
          priority: "low",
          session_id: "session",
          uuid: "notif",
        },
      ]) {
        harness.query.emit(message as unknown as SDKMessage);
      }
      // High-priority notifications DO surface as a warning row.
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "limit",
        text: "context window nearly full",
        priority: "high",
        session_id: "session",
        uuid: "notif-high",
      } as unknown as SDKMessage);
      // session_state_changed maps to the matching session states.
      for (const [state, uuid] of [
        ["running", "ssc-run"],
        ["requires_action", "ssc-req"],
        ["idle", "ssc-idle"],
      ]) {
        harness.query.emit({
          type: "system",
          subtype: "session_state_changed",
          state,
          session_id: "session",
          uuid,
        } as unknown as SDKMessage);
      }
      // api_retry maps to a session heartbeat, not a warning row.
      harness.query.emit({
        type: "system",
        subtype: "api_retry",
        attempt: 3,
        max_retries: 10,
        retry_delay_ms: 1000,
        error_status: 502,
        error: { type: "api_error" },
        session_id: "session",
        uuid: "retry",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const warnings = runtimeEvents.filter((event) => event.type === "runtime.warning");
      // Exactly one warning: the high-priority notification. Nothing else.
      assert.deepEqual(
        warnings.map((event) => event.payload.message),
        ["context window nearly full"],
      );
      const sessionStates = runtimeEvents
        .filter((event) => event.type === "session.state.changed")
        .map((event) =>
          event.type === "session.state.changed"
            ? `${event.payload.state}:${event.payload.reason ?? ""}`
            : "",
        )
        .filter(
          (entry) => entry.startsWith("running:session_state") || entry.includes("session_state"),
        );
      assert.deepEqual(sessionStates, [
        "running:session_state:running",
        "waiting:session_state:requires_action",
        "ready:session_state:idle",
      ]);
      const heartbeat = runtimeEvents.find(
        (event) =>
          event.type === "session.state.changed" &&
          typeof event.payload.reason === "string" &&
          event.payload.reason.startsWith("api_retry:"),
      );
      assert.equal(heartbeat?.type, "session.state.changed");
      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("consumes Claude command lifecycle notifications silently", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const sessionId = "6e81554e-5cff-4b37-8a39-f3a9051ac234";

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const readyMessage = "command lifecycle test ready";
      const readyFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning" && event.payload.message === readyMessage,
      ).pipe(Stream.runDrain, Effect.forkChild);
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "command-lifecycle-ready",
        text: readyMessage,
        priority: "high",
        session_id: sessionId,
        uuid: "command-lifecycle-ready",
      } as unknown as SDKMessage);
      yield* Fiber.join(readyFiber);

      const processedMessage = "command lifecycle messages processed";
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning" && event.payload.message === processedMessage,
      ).pipe(Stream.runCollect, Effect.forkChild);
      for (const [state, uuid] of [
        ["started", "command-started"],
        ["completed", "command-completed"],
      ]) {
        harness.query.emit({
          type: "command_lifecycle",
          command_uuid: "4cd8e8a3-df7a-425d-b6c9-4053abc0b8fd",
          state,
          session_id: sessionId,
          uuid,
        } as unknown as SDKMessage);
      }
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "command-lifecycle-processed",
        text: processedMessage,
        priority: "high",
        session_id: sessionId,
        uuid: "command-lifecycle-processed",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["runtime.warning"],
      );
      const warning = runtimeEvents[0];
      assert.equal(warning?.type, "runtime.warning");
      if (warning?.type === "runtime.warning") {
        assert.equal(warning.payload.message, processedMessage);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores task progress usage before the parent has any usage of its own", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-1",
        description: "Thinking through the patch",
        usage: {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 654,
        },
        session_id: "sdk-session-task-usage",
        uuid: "task-usage-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(usageEvent, undefined);
      assert.equal(progressEvent?.type, "task.progress");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("holds the running total until it exceeds the parent's own usage", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "go", attachments: [] });

      harness.query.emit({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: null, stop_sequence: null },
          usage: { input_tokens: 3_000, output_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: "sdk-session-total-floor",
        uuid: "total-floor-delta",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-total-floor",
        description: "Child barely started",
        usage: { total_tokens: 2_000 },
        session_id: "sdk-session-total-floor",
        uuid: "total-floor-small",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-total-floor",
        description: "Child past the parent",
        usage: { total_tokens: 5_000 },
        session_id: "sdk-session-total-floor",
        uuid: "total-floor-large",
      } as unknown as SDKMessage);

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(runtimeEventsFiber);

      const usageEvents = runtimeEvents.filter(
        (event) => event.type === "thread.token-usage.updated",
      );
      assert.equal(usageEvents.length, 2);
      const [afterDelta, afterLargeTick] = usageEvents;
      if (afterDelta?.type === "thread.token-usage.updated") {
        assert.equal(afterDelta.payload.usage.usedTokens, 3_000);
        assert.equal(afterDelta.payload.usage.totalProcessedTokens, undefined);
      }
      if (afterLargeTick?.type === "thread.token-usage.updated") {
        assert.equal(afterLargeTick.payload.usage.usedTokens, 3_000);
        assert.equal(afterLargeTick.payload.usage.totalProcessedTokens, 5_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps subagent tokens out of the parent context meter (#5942)", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 10,
        duration_api_ms: 8,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-child-usage",
        usage: { input_tokens: 4_000, output_tokens: 200 },
        modelUsage: { [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: { contextWindow: 1_000_000 } },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-child-1",
        description: "Background agent doing the heavy work",
        usage: { total_tokens: 900_000, tool_uses: 40, duration_ms: 1_000 },
        session_id: "sdk-session-child-usage",
        uuid: "task-child-progress-1",
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(runtimeEventsFiber);

      const latest = runtimeEvents
        .filter((event) => event.type === "thread.token-usage.updated")
        .at(-1);
      assert.equal(latest?.type, "thread.token-usage.updated");
      if (latest?.type === "thread.token-usage.updated") {
        assert.equal(latest.payload.usage.usedTokens, 4_200);
        assert.equal(latest.payload.usage.totalProcessedTokens, 900_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("measures the meter against the session model's window, not a subagent's", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "contextWindow", value: "standard" }],
        ),
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "summarize",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sdk-session-window-scope",
        uuid: "result-window-scope",
        usage: { input_tokens: 50_000, output_tokens: 1_000 },
        modelUsage: {
          [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: { contextWindow: 200_000 },
          [SYNTHETIC_SUBAGENT_MODEL]: { contextWindow: 1_000_000 },
        },
      } as unknown as SDKMessage);

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(runtimeEventsFiber);
      const latest = runtimeEvents
        .filter((event) => event.type === "thread.token-usage.updated")
        .at(-1);
      assert.equal(latest?.type, "thread.token-usage.updated");
      if (latest?.type === "thread.token-usage.updated") {
        assert.equal(latest.payload.usage.maxTokens, 200_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses the init model's window when no model was explicitly selected", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "summarize", attachments: [] });

      harness.query.emit({
        type: "system",
        subtype: "init",
        model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
        session_id: "sdk-session-init-window",
        uuid: "init-window",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 10,
        duration_api_ms: 8,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-init-window",
        usage: { input_tokens: 50_000, output_tokens: 1_000 },
        modelUsage: {
          [SYNTHETIC_CLAUDE_STANDARD_MODEL]: { contextWindow: 200_000 },
          [SYNTHETIC_SUBAGENT_MODEL]: { contextWindow: 1_000_000 },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(runtimeEventsFiber);
      const latest = runtimeEvents
        .filter((event) => event.type === "thread.token-usage.updated")
        .at(-1);
      assert.equal(latest?.type, "thread.token-usage.updated");
      if (latest?.type === "thread.token-usage.updated") {
        assert.equal(latest.payload.usage.maxTokens, 200_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("carries a subagent's running total into the parent's next snapshot", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "delegate", attachments: [] });

      harness.query.emit({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: null, stop_sequence: null },
          usage: { input_tokens: 3_000, output_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: "sdk-session-running-total",
        uuid: "parent-running-total",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-running-total",
        description: "Child doing the heavy work",
        usage: { total_tokens: 480_000 },
        session_id: "sdk-session-running-total",
        uuid: "task-running-total-progress",
      } as unknown as SDKMessage);

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(runtimeEventsFiber);
      const latest = runtimeEvents
        .filter((event) => event.type === "thread.token-usage.updated")
        .at(-1);
      assert.equal(latest?.type, "thread.token-usage.updated");
      if (latest?.type === "thread.token-usage.updated") {
        assert.equal(latest.payload.usage.totalProcessedTokens, 480_000);
        assert.equal(latest.payload.usage.usedTokens, 3_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps a subagent's running total when the parent turn completes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "go", attachments: [] });

      harness.query.emit({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: null, stop_sequence: null },
          usage: { input_tokens: 3_000, output_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: "sdk-session-running-total-result",
        uuid: "running-total-result-delta",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-running-total-result",
        description: "Child doing the heavy work",
        usage: { total_tokens: 900_000 },
        session_id: "sdk-session-running-total-result",
        uuid: "running-total-result-task",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 10,
        duration_api_ms: 8,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-running-total-result",
        usage: { input_tokens: 4_000, output_tokens: 200 },
        modelUsage: { [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: { contextWindow: 200_000 } },
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(runtimeEventsFiber);
      const latest = runtimeEvents
        .filter((event) => event.type === "thread.token-usage.updated")
        .at(-1);
      assert.equal(latest?.type, "thread.token-usage.updated");
      if (latest?.type === "thread.token-usage.updated") {
        // #8453 expected 4,200 before #8617 made the per-request 3,000 authoritative.
        assert.equal(latest.payload.usage.usedTokens, 3_000);
        assert.equal(latest.payload.usage.totalProcessedTokens, 900_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("follows a persistent refusal fallback to the model that ran", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild);
      const fallbackModel = `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "summarize", attachments: [] });

      harness.query.emit({
        type: "system",
        subtype: "init",
        model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
        session_id: "sdk-session-refusal",
        uuid: "refusal-init",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "model_refusal_fallback",
        trigger: "refusal",
        direction: "retry",
        original_model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
        fallback_model: fallbackModel,
        request_id: null,
        session_id: "sdk-session-refusal",
        uuid: "refusal-swap",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 10,
        duration_api_ms: 8,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-refusal",
        usage: { input_tokens: 50_000, output_tokens: 1_000 },
        modelUsage: {
          [SYNTHETIC_CLAUDE_STANDARD_MODEL]: { contextWindow: 200_000 },
          [fallbackModel]: { contextWindow: 1_000_000 },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(runtimeEventsFiber);
      const latest = runtimeEvents
        .filter((event) => event.type === "thread.token-usage.updated")
        .at(-1);
      assert.equal(latest?.type, "thread.token-usage.updated");
      if (latest?.type === "thread.token-usage.updated") {
        assert.equal(latest.payload.usage.maxTokens, 1_000_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("measures the window against the model a mid-thread switch selected", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild);
      const initialSelection = createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        SYNTHETIC_CLAUDE_STANDARD_MODEL,
        [{ id: "contextWindow", value: "standard" }],
      );
      const switchedSelection = createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        SYNTHETIC_CLAUDE_CAPABLE_MODEL,
      );
      const switchedModel = `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: initialSelection,
        runtimeMode: "full-access",
      });
      harness.query.emit({
        type: "system",
        subtype: "init",
        model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
        session_id: "sdk-session-switch",
        uuid: "switch-init",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "switch",
        modelSelection: switchedSelection,
        attachments: [],
      });
      harness.query.emit({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: null, stop_sequence: null },
          usage: { input_tokens: 300_000, output_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: "sdk-session-switch",
        uuid: "switch-delta",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;

      const usageBeforeResult = runtimeEvents.findLast(
        (event) => event.type === "thread.token-usage.updated",
      );
      assert.equal(usageBeforeResult?.type, "thread.token-usage.updated");
      if (usageBeforeResult?.type === "thread.token-usage.updated") {
        assert.equal(usageBeforeResult.payload.usage.maxTokens, 1_000_000);
        assert.equal(usageBeforeResult.payload.usage.usedTokens, 300_000);
      }

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 10,
        duration_api_ms: 8,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-switch",
        usage: { input_tokens: 20_000, output_tokens: 500 },
        modelUsage: {
          [SYNTHETIC_CLAUDE_STANDARD_MODEL]: { contextWindow: 200_000 },
          [switchedModel]: { contextWindow: 1_000_000 },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(runtimeEventsFiber);
      const latest = runtimeEvents
        .filter((event) => event.type === "thread.token-usage.updated")
        .at(-1);
      assert.equal(latest?.type, "thread.token-usage.updated");
      if (latest?.type === "thread.token-usage.updated") {
        assert.equal(latest.payload.usage.maxTokens, 1_000_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not re-send a refused model on the next turn with the same selection", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.runForEach(
        adapter.streamEvents,
        () => Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const selection = createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        SYNTHETIC_CLAUDE_CAPABLE_MODEL,
      );
      const apiModel = `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`;
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "first",
        modelSelection: selection,
        attachments: [],
      });
      assert.deepEqual(harness.query.setModelCalls, [apiModel]);

      harness.query.emit({
        type: "system",
        subtype: "model_refusal_fallback",
        trigger: "refusal",
        direction: "retry",
        original_model: apiModel,
        fallback_model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
        request_id: null,
        session_id: "sdk-session-refusal-resend",
        uuid: "refusal-resend-swap",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 10,
        duration_api_ms: 8,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-refusal-resend",
        usage: { input_tokens: 1_000, output_tokens: 10 },
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "second",
        modelSelection: selection,
        attachments: [],
      });
      assert.deepEqual(harness.query.setModelCalls, [apiModel]);

      yield* Fiber.interrupt(runtimeEventsFiber);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "prevents cumulative result usage from overriding per-request context (regression #8594)",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => runtimeEvents.push(event)),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

        harness.query.emit({
          type: "stream_event",
          event: {
            type: "message_delta",
            delta: { stop_reason: null, stop_sequence: null },
            usage: { input_tokens: 112_994, output_tokens: 0 },
          },
          parent_tool_use_id: null,
          session_id: "sdk-session-8594",
          uuid: "parent-usage-8594",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1234,
          duration_api_ms: 1200,
          num_turns: 1,
          result: "done",
          stop_reason: "end_turn",
          session_id: "sdk-session-8594",
          usage: {
            input_tokens: 100_000,
            cache_creation_input_tokens: 50_000,
            cache_read_input_tokens: 2_034_473,
            output_tokens: 18_487,
            total_tokens: 2_202_960,
            iterations: [],
          },
          modelUsage: {
            [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
              contextWindow: 1_000_000,
              maxOutputTokens: 64_000,
            },
          },
        } as unknown as SDKMessage);
        harness.query.finish();

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(runtimeEventsFiber);
        const finalUsageEvent = runtimeEvents
          .filter((event) => event.type === "thread.token-usage.updated")
          .at(-1);
        assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
        if (finalUsageEvent?.type === "thread.token-usage.updated") {
          assert.equal(finalUsageEvent.payload.usage.usedTokens, 112_994);
          assert.equal(finalUsageEvent.payload.usage.totalProcessedTokens, 2_202_960);
          assert.equal(finalUsageEvent.payload.usage.maxTokens, 1_000_000);
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("emits Claude context window on result completion usage snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 2715,
          cache_read_input_tokens: 21144,
          output_tokens: 679,
        },
        modelUsage: {
          [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 24542,
            lastUsedTokens: 24542,
            inputTokens: 23863,
            outputTokens: 679,
            maxTokens: 200000,
            compactsAutomatically: true,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("clamps oversized Claude usage to the reported context window", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-clamped",
        usage: {
          total_tokens: 535000,
        },
        modelUsage: {
          [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 200000,
            lastUsedTokens: 200000,
            totalProcessedTokens: 535000,
            maxTokens: 200000,
            compactsAutomatically: true,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "preserves oversized Claude result totals after task progress snapshots are recorded",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => runtimeEvents.push(event)),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

        harness.query.emit({
          type: "stream_event",
          event: {
            type: "message_delta",
            delta: { stop_reason: null, stop_sequence: null },
            usage: { input_tokens: 12_000, output_tokens: 0 },
          },
          parent_tool_use_id: null,
          session_id: "sdk-session-task-usage-clamped",
          uuid: "parent-baseline-clamped",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "task-usage-clamped",
          description: "Thinking through the patch",
          usage: { total_tokens: 190_000 },
          session_id: "sdk-session-task-usage-clamped",
          uuid: "task-usage-progress-clamped",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1234,
          duration_api_ms: 1200,
          num_turns: 1,
          result: "done",
          stop_reason: "end_turn",
          session_id: "sdk-session-result-usage-clamped-after-progress",
          usage: { total_tokens: 535_000 },
          modelUsage: {
            [SYNTHETIC_CLAUDE_CAPABLE_MODEL]: {
              contextWindow: 200_000,
              maxOutputTokens: 64_000,
            },
          },
        } as unknown as SDKMessage);
        harness.query.finish();

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(runtimeEventsFiber);
        const finalUsageEvent = runtimeEvents
          .filter((event) => event.type === "thread.token-usage.updated")
          .at(-1);
        assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
        if (finalUsageEvent?.type === "thread.token-usage.updated") {
          assert.deepEqual(finalUsageEvent.payload, {
            usage: {
              usedTokens: 12_000,
              lastUsedTokens: 12_000,
              totalProcessedTokens: 535_000,
              inputTokens: 12_000,
              maxTokens: 200_000,
              compactsAutomatically: true,
            },
          });
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "emits completion only after turn result when assistant frames arrive before deltas",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-early-assistant",
          uuid: "assistant-early",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-early",
            content: [
              { type: "tool_use", id: "tool-early", name: "Read", input: { path: "a.ts" } },
            ],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-early-assistant",
          uuid: "stream-early",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "Late text",
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-early-assistant",
          uuid: "result-early",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.map((event) => event.type),
          [
            "session.started",
            "session.configured",
            "session.state.changed",
            "turn.started",
            "thread.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );

        const deltaIndex = runtimeEvents.findIndex((event) => event.type === "content.delta");
        const completedIndex = runtimeEvents.findIndex((event) => event.type === "item.completed");
        assert.equal(deltaIndex >= 0 && completedIndex >= 0 && deltaIndex < completedIndex, true);

        const deltaEvent = runtimeEvents[deltaIndex];
        assert.equal(deltaEvent?.type, "content.delta");
        if (deltaEvent?.type === "content.delta") {
          assert.equal(deltaEvent.payload.delta, "Late text");
          assert.equal(String(deltaEvent.turnId), String(turn.turnId));
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("creates a fresh assistant message when Claude reuses a text block index", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Second",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-reused-text-index",
        uuid: "result-reused-text-index",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "content.delta",
          "item.completed",
        ],
      );

      const assistantDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantDeltas.length, 2);
      if (assistantDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantDeltas;
      assert.equal(firstAssistantDelta?.type, "content.delta");
      assert.equal(secondAssistantDelta?.type, "content.delta");
      if (
        firstAssistantDelta?.type !== "content.delta" ||
        secondAssistantDelta?.type !== "content.delta"
      ) {
        return;
      }
      assert.equal(firstAssistantDelta.payload.delta, "First");
      assert.equal(secondAssistantDelta.payload.delta, "Second");
      assert.notEqual(firstAssistantDelta.itemId, secondAssistantDelta.itemId);

      const assistantCompletions = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(assistantCompletions.length, 2);
      assert.equal(String(assistantCompletions[0]?.itemId), String(firstAssistantDelta.itemId));
      assert.equal(String(assistantCompletions[1]?.itemId), String(secondAssistantDelta.itemId));
      assert.notEqual(
        String(assistantCompletions[0]?.itemId),
        String(assistantCompletions[1]?.itemId),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to assistant payload text when stream deltas are absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-fallback-text",
        uuid: "assistant-fallback",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-fallback",
          content: [{ type: "text", text: "Fallback hello" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-fallback-text",
        uuid: "result-fallback",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Fallback hello");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("segments Claude assistant text blocks around tool calls", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-interleaved-1",
            name: "Grep",
            input: {
              pattern: "assistant",
              path: "src",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-interleaved",
        uuid: "user-tool-result-interleaved",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-interleaved-1",
              content: "src/example.ts:1:assistant",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "text_delta",
            text: "Second message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 2,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-interleaved",
        uuid: "result-interleaved",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.updated",
          "item.completed",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const assistantTextDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantTextDeltas.length, 2);
      if (assistantTextDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantTextDeltas;
      if (!firstAssistantDelta || !secondAssistantDelta) {
        return;
      }
      assert.notEqual(String(firstAssistantDelta.itemId), String(secondAssistantDelta.itemId));

      const firstAssistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.itemId) === String(firstAssistantDelta.itemId),
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      const secondAssistantDeltaIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          String(event.itemId) === String(secondAssistantDelta.itemId),
      );

      assert.equal(
        firstAssistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          secondAssistantDeltaIndex >= 0 &&
          firstAssistantCompletedIndex < toolStartedIndex &&
          toolStartedIndex < secondAssistantDeltaIndex,
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not fabricate provider thread ids before first SDK session_id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      assert.equal(session.threadId, THREAD_ID);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(turn.threadId, THREAD_ID);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-thread-real",
        uuid: "stream-thread-real",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-thread-real",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-thread-real",
        uuid: "result-thread-real",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
        ],
      );

      const sessionStarted = runtimeEvents[0];
      assert.equal(sessionStarted?.type, "session.started");
      if (sessionStarted?.type === "session.started") {
        assert.equal(sessionStarted.threadId, THREAD_ID);
      }

      const threadStarted = runtimeEvents[4];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.equal(threadStarted.threadId, THREAD_ID);
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: "sdk-thread-real",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("bridges approval request/response lifecycle through canUseTool", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-approval-1",
        uuid: "stream-approval-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-approval-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "setMode",
              mode: "default",
              destination: "session",
            },
          ],
          toolUseID: "tool-use-1",
        },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some") {
        return;
      }
      assert.equal(requested.value.type, "request.opened");
      if (requested.value.type !== "request.opened") {
        return;
      }
      assert.deepEqual(requested.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });
      const runtimeRequestId = requested.value.requestId;
      assert.equal(typeof runtimeRequestId, "string");
      if (runtimeRequestId === undefined) {
        return;
      }

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(runtimeRequestId),
        "accept",
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }
      assert.equal(resolved.value.type, "request.resolved");
      if (resolved.value.type !== "request.resolved") {
        return;
      }
      assert.equal(resolved.value.requestId, requested.value.requestId);
      assert.equal(resolved.value.payload.decision, "accept");
      assert.deepEqual(resolved.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("acceptForSession returns session-scoped permission updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this for the session",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const respondToNextRequest = Effect.gen(function* () {
        const requested = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(requested._tag, "Some");
        if (requested._tag !== "Some" || requested.value.type !== "request.opened") {
          return;
        }
        const runtimeRequestId = requested.value.requestId;
        assert.equal(typeof runtimeRequestId, "string");
        if (runtimeRequestId === undefined) {
          return;
        }
        yield* adapter.respondToRequest(
          session.threadId,
          ApprovalRequestId.make(runtimeRequestId),
          "acceptForSession",
        );
        yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);
      });

      // MCP tools frequently arrive with no usable suggestion (Claude Code
      // sends an empty array); the decision must still stick for the session.
      const mcpPermissionPromise = canUseTool(
        "mcp__linear__create_issue",
        { title: "hello" },
        {
          signal: new AbortController().signal,
          suggestions: [],
          toolUseID: "tool-use-mcp-1",
        },
      );
      yield* respondToNextRequest;
      const mcpPermission = (yield* Effect.promise(() => mcpPermissionPromise)) as PermissionResult;
      assert.equal(mcpPermission.behavior, "allow");
      if (mcpPermission.behavior !== "allow") {
        return;
      }
      assert.deepEqual(mcpPermission.updatedPermissions, [
        {
          type: "addRules",
          rules: [{ toolName: "mcp__linear__create_issue" }],
          behavior: "allow",
          destination: "session",
        },
      ]);

      // Received suggestions are reused but rescoped to the session —
      // echoing "localSettings" would persist a session-only choice to disk.
      const bashPermissionPromise = canUseTool(
        "Bash",
        { command: "git status" },
        {
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "addRules",
              rules: [{ toolName: "Bash", ruleContent: "git status" }],
              behavior: "allow",
              destination: "localSettings",
            },
          ],
          toolUseID: "tool-use-bash-1",
        },
      );
      yield* respondToNextRequest;
      const bashPermission = (yield* Effect.promise(
        () => bashPermissionPromise,
      )) as PermissionResult;
      assert.equal(bashPermission.behavior, "allow");
      if (bashPermission.behavior !== "allow") {
        return;
      }
      assert.deepEqual(bashPermission.updatedPermissions, [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "git status" }],
          behavior: "allow",
          destination: "session",
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Agent tools and read-only Claude tools correctly for approvals", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const agentPermissionPromise = canUseTool(
        "Agent",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "tool-agent-1",
        },
      );

      const agentRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(agentRequested._tag, "Some");
      if (agentRequested._tag !== "Some" || agentRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(agentRequested.value.payload.requestType, "dynamic_tool_call");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(agentRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => agentPermissionPromise);

      const grepPermissionPromise = canUseTool(
        "Grep",
        { pattern: "foo", path: "src" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-grep-approval-1",
        },
      );

      const grepRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(grepRequested._tag, "Some");
      if (grepRequested._tag !== "Some" || grepRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(grepRequested.value.payload.requestType, "file_read_approval");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(grepRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => grepPermissionPromise);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes Claude resume ids without pinning a stale assistant checkpoint", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: "resume-thread-1",
          resume: "550e8400-e29b-41d4-a716-446655440000",
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, RESUME_THREAD_ID);
      assert.deepEqual(session.resumeCursor, {
        threadId: RESUME_THREAD_ID,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        resumeSessionAt: "assistant-99",
        turnCount: 3,
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, "550e8400-e29b-41d4-a716-446655440000");
      assert.equal(createInput?.options.sessionId, undefined);
      assert.equal(createInput?.options.resumeSessionAt, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the resume cursor on the main transcript's last assistant message", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate some work",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-sidechain",
        uuid: "assistant-main-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-main-1",
          content: [{ type: "text", text: "Main transcript" }],
        },
      } as unknown as SDKMessage);

      // A subagent's reply lives in its own sidechain file. Adopting its uuid
      // would point resumeSessionAt at a message the resumed session cannot
      // find in the main transcript.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-sidechain",
        uuid: "assistant-subagent-1",
        parent_tool_use_id: "tool-use-subagent",
        message: {
          id: "assistant-message-subagent-1",
          content: [{ type: "text", text: "Subagent transcript" }],
        },
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;

      const activeSessions = yield* adapter.listSessions();
      const cursor = activeSessions[0]?.resumeCursor as
        | { readonly resumeSessionAt?: string }
        | undefined;
      assert.equal(cursor?.resumeSessionAt, "assistant-main-1");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("preserves durable resume ids across Claude resume hooks", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const durableSessionId = "550e8400-e29b-41d4-a716-446655440000";
      const transientHookSessionId = "7368d0c7-40a3-4d8a-bcc1-ac80c49f2719";

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: durableSessionId,
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "hook_started",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        session_id: transientHookSessionId,
        uuid: "resume-hook-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "hook_response",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        output: "",
        stdout: "",
        stderr: "",
        outcome: "success",
        session_id: transientHookSessionId,
        uuid: "resume-hook-response",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        claude_code_version: "test",
        cwd: "/tmp/claude-adapter-test",
        tools: [],
        mcp_servers: [],
        model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
        permissionMode: "bypassPermissions",
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
        session_id: durableSessionId,
        uuid: "resume-init",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const threadStartedEvents = runtimeEvents.filter((event) => event.type === "thread.started");
      assert.equal(threadStartedEvents.length, 1);
      const threadStarted = threadStartedEvents[0];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: durableSessionId,
        });
      }

      const activeSessions = yield* adapter.listSessions();
      const resumeCursor = activeSessions[0]?.resumeCursor as
        | {
            readonly resume?: string;
          }
        | undefined;
      assert.equal(resumeCursor?.resume, durableSessionId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses an app-generated Claude session id for fresh sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      const sessionResumeCursor = session.resumeCursor as {
        threadId?: string;
        resume?: string;
        turnCount?: number;
      };
      assert.equal(sessionResumeCursor.threadId, THREAD_ID);
      assert.equal(typeof sessionResumeCursor.resume, "string");
      assert.equal(sessionResumeCursor.turnCount, 0);
      assert.match(
        sessionResumeCursor.resume ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(createInput?.options.resume, undefined);
      assert.equal(createInput?.options.sessionId, sessionResumeCursor.resume);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "supports rollbackThread by trimming in-memory turns and preserving earlier turns",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const firstTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "first",
          attachments: [],
        });

        const firstCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-rollback",
          uuid: "result-first",
        } as unknown as SDKMessage);

        const firstCompleted = yield* Fiber.join(firstCompletedFiber);
        assert.equal(firstCompleted._tag, "Some");
        if (firstCompleted._tag === "Some" && firstCompleted.value.type === "turn.completed") {
          assert.equal(String(firstCompleted.value.turnId), String(firstTurn.turnId));
        }

        const secondTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "second",
          attachments: [],
        });

        const secondCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-rollback",
          uuid: "result-second",
        } as unknown as SDKMessage);

        const secondCompleted = yield* Fiber.join(secondCompletedFiber);
        assert.equal(secondCompleted._tag, "Some");
        if (secondCompleted._tag === "Some" && secondCompleted.value.type === "turn.completed") {
          assert.equal(String(secondCompleted.value.turnId), String(secondTurn.turnId));
        }

        const threadBeforeRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadBeforeRollback.turns.length, 2);

        const rolledBack = yield* adapter.rollbackThread(session.threadId, 1);
        assert.equal(rolledBack.turns.length, 1);
        assert.equal(rolledBack.turns[0]?.id, firstTurn.turnId);

        const threadAfterRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadAfterRollback.turns.length, 1);
        assert.equal(threadAfterRollback.turns[0]?.id, firstTurn.turnId);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("updates model on sendTurn when model override is provided", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: SYNTHETIC_CLAUDE_CAPABLE_MODEL,
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, [
        `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`,
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("updates model on sendTurn for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("claude_openrouter");
    const harness = makeHarness({
      instanceId: customInstanceId,
      claudeConfig: { customModels: ["openai/gpt-5.5"] },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          instanceId: customInstanceId,
          model: "openai/gpt-5.5",
        },
        attachments: [],
      });

      // Custom models carry the selected effort (default high) as a
      // parenthesized model-name suffix.
      assert.deepEqual(harness.query.setModelCalls, ["openai/gpt-5.5(high)"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("updates a custom model when only its effort changes", () => {
    const harness = makeHarness({ claudeConfig: { customModels: ["gpt-5.6-sol"] } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "gpt-5.6-sol",
          [{ id: "effort", value: "low" }],
        ),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "gpt-5.6-sol",
          [{ id: "effort", value: "medium" }],
        ),
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["gpt-5.6-sol(medium)"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "does not re-set the Claude model when the session already uses the same effective API model",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const modelSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: SYNTHETIC_CLAUDE_CAPABLE_MODEL,
        };

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          modelSelection,
          attachments: [],
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello again",
          modelSelection,
          attachments: [],
        });

        assert.deepEqual(harness.query.setModelCalls, []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("re-sets the Claude model when the effective API model changes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "contextWindow", value: "expanded" }],
        ),
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello again",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          [{ id: "contextWindow", value: "standard" }],
        ),
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, [
        `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`,
        SYNTHETIC_CLAUDE_CAPABLE_MODEL,
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sets plan permission mode on sendTurn when interactionMode is plan", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this for me",
        interactionMode: "plan",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect.each<{ runtimeMode: RuntimeMode; expectedBase: PermissionMode }>([
    { runtimeMode: "full-access", expectedBase: "bypassPermissions" },
    { runtimeMode: "approval-required", expectedBase: "default" },
    { runtimeMode: "auto-accept-edits", expectedBase: "acceptEdits" },
  ])(
    "restores $expectedBase permission mode after plan turn ($runtimeMode)",
    ({ runtimeMode, expectedBase }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode,
        });

        // First turn in plan mode
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
        });

        // Complete the turn so we can send another
        const turnCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: `sdk-session-${runtimeMode}`,
          uuid: `result-${runtimeMode}`,
        } as unknown as SDKMessage);

        yield* Fiber.join(turnCompletedFiber);

        // Second turn back to default
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "now do it",
          interactionMode: "default",
          attachments: [],
        });

        assert.deepEqual(harness.query.setPermissionModeCalls, ["plan", expectedBase]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("does not call setPermissionMode when interactionMode is absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("captures ExitPlanMode as a proposed plan and denies auto-exit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "ExitPlanMode",
        {
          plan: "# Ship it\n\n- one\n- two",
          allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
        },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-exit-1",
        },
      );

      const proposedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Ship it\n\n- one\n- two");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-exit-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "deny");
      const deniedResult = permissionResult as PermissionResult & {
        message?: string;
      };
      assert.equal(deniedResult.message?.includes("captured your proposed plan"), true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("extracts proposed plans from assistant ExitPlanMode snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const proposedEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.proposed.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-exit-plan",
        uuid: "assistant-exit-plan",
        parent_tool_use_id: null,
        message: {
          model: SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          id: "msg-exit-plan",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-exit-2",
              name: "ExitPlanMode",
              input: {
                plan: "# Final plan\n\n- capture it",
              },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      } as unknown as SDKMessage);

      const proposedEvent = yield* Fiber.join(proposedEventFiber);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Final plan\n\n- capture it");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-exit-2"),
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("routes Claude resume compaction through the shared user-input UI", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: { resume: "550e8400-e29b-41d4-a716-446655440000" },
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const onUserDialog = harness.getLastCreateQueryInput()?.options.onUserDialog;
      assert.equal(typeof onUserDialog, "function");
      if (!onUserDialog) return;

      const dialogPromise = onUserDialog(
        {
          dialogKind: "resume_return",
          payload: { sessionAgeMinutes: 145, estimatedTokens: 275123 },
        },
        { signal: new AbortController().signal },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some" || requested.value.type !== "user-input.requested") return;
      const question = requested.value.payload.questions[0];
      assert.equal(question?.header, "Resume session");
      assert.match(question?.question ?? "", /2h 25m/);
      assert.match(question?.question ?? "", /275,123 tokens/);
      assert.deepEqual(
        question?.options.map((option) => option.label),
        ["Compact and continue", "Keep full history", "Don't ask again"],
      );
      if (!question || !requested.value.requestId) return;

      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.make(requested.value.requestId),
        { [question.id]: "Compact and continue" },
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag === "Some") assert.equal(resolved.value.type, "user-input.resolved");
      assert.deepEqual(yield* Effect.promise(() => dialogPromise), {
        behavior: "completed",
        result: "compact",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("handles AskUserQuestion via user-input.requested/resolved lifecycle", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Start session in approval-required mode so canUseTool fires.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      // Drain the session startup events (started, configured, state.changed).
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "question turn",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-user-input-1",
        uuid: "stream-user-input-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-user-input-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      // Simulate Claude calling AskUserQuestion with structured questions.
      const askInput = {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "React.js" },
              { label: "Vue", description: "Vue.js" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-1",
      });

      // The adapter should emit a user-input.requested event.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some") {
        return;
      }
      assert.equal(requestedEvent.value.type, "user-input.requested");
      if (requestedEvent.value.type !== "user-input.requested") {
        return;
      }
      const requestId = requestedEvent.value.requestId;
      assert.equal(typeof requestId, "string");
      assert.equal(requestedEvent.value.payload.questions.length, 1);
      assert.equal(requestedEvent.value.payload.questions[0]?.question, "Which framework?");
      // Regression for #2388: `id` must equal the full question text so the
      // UI's draft-answer key matches what the SDK looks up downstream.
      assert.equal(requestedEvent.value.payload.questions[0]?.id, "Which framework?");
      assert.deepEqual(requestedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // Respond with the user's answers.
      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make(requestId!), {
        "Which framework?": "React",
      });

      // The adapter should emit a user-input.resolved event.
      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some") {
        return;
      }
      assert.equal(resolvedEvent.value.type, "user-input.resolved");
      if (resolvedEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {
        "Which framework?": "React",
      });
      assert.deepEqual(resolvedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // The canUseTool promise should resolve with the answers in SDK format.
      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Which framework?": "React" });
      // Original questions should be passed through.
      assert.deepEqual(updatedInput.questions, askInput.questions);

      // Compatibility check for #2388: the answers shape we hand to the SDK
      // must produce a non-empty rendered tool_result on BOTH SDK iteration
      // patterns we have seen, so we don't regress the issue and we don't
      // break users still on the older Claude CLI.
      const sdkAnswers = updatedInput.answers as Record<string, unknown>;
      const sdkQuestions = updatedInput.questions as ReadonlyArray<{
        readonly question: string;
      }>;

      // Claude CLI 2.1.119 — key-agnostic Object.entries iteration. Any key
      // works here, but it must at least round-trip into a non-empty string.
      const v119Rendered = Object.entries(sdkAnswers)
        .map(([key, value]) => `"${key}"="${String(value)}"`)
        .join(", ");
      assert.equal(v119Rendered, '"Which framework?"="React"');

      // Claude CLI 2.1.121 — lookup by full question text. This is the path
      // that regressed in #2388 when the answers were keyed by `header`.
      const v121Rendered = sdkQuestions
        .map(({ question }) => {
          const answer = sdkAnswers[question];
          return answer === undefined ? null : `"${question}"="${String(answer)}"`;
        })
        .filter((entry): entry is string => entry !== null)
        .join(", ");
      assert.notEqual(v121Rendered, "", "Expected non-empty SDK 2.1.121 tool_result (#2388)");
      assert.equal(v121Rendered, '"Which framework?"="React"');
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("routes AskUserQuestion through user-input flow even in full-access mode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // In full-access mode, regular tools are auto-approved.
      // AskUserQuestion should still go through the user-input flow.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const askInput = {
        questions: [
          {
            question: "Deploy to which env?",
            header: "Env",
            options: [
              { label: "Staging", description: "Staging environment" },
              { label: "Production", description: "Production environment" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-2",
      });

      // Should still get user-input.requested even in full-access mode.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const requestId = requestedEvent.value.requestId;

      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make(requestId!), {
        "Deploy to which env?": "Staging",
      });

      // Drain the resolved event.
      yield* Stream.runHead(adapter.streamEvents);

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Deploy to which env?": "Staging" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies AskUserQuestion when the waiting turn is aborted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const controller = new AbortController();
      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: controller.signal,
          toolUseID: "tool-ask-abort",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      assert.equal(requestedEvent.value.threadId, session.threadId);

      controller.abort();

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {});

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies AskUserQuestion when the signal aborted before the listener registered", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      // Abort before the call so the adapter's listener registration can
      // never observe the abort event, only the recheck can.
      const controller = new AbortController();
      controller.abort();
      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: controller.signal,
          toolUseID: "tool-ask-pre-aborted",
        },
      );

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["user-input.requested", "user-input.resolved"],
      );
      const resolvedEvent = runtimeEvents[1];
      if (resolvedEvent?.type === "user-input.resolved") {
        assert.deepEqual(resolvedEvent.payload.answers, {});
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stopping a session settles pending user-input waits", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        { signal: new AbortController().signal, toolUseID: "tool-ask-stop" },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }

      // The session dies while the question is still on screen.
      yield* adapter.stopSession(THREAD_ID);

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {});

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("writes provider-native observability records when enabled", () => {
    const nativeEvents: Array<{
      event?: {
        provider?: string;
        method?: string;
        threadId?: string;
        turnId?: string;
      };
    }> = [];
    const nativeThreadIds: Array<string | null> = [];
    const harness = makeHarness({
      nativeEventLogger: {
        filePath: "memory://claude-native-events",
        write: (event, threadId) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-native-log",
        uuid: "stream-native-log",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-native-log",
        uuid: "result-native-log",
      } as unknown as SDKMessage);

      const turnCompleted = yield* Fiber.join(turnCompletedFiber);
      assert.equal(turnCompleted._tag, "Some");

      assert.equal(nativeEvents.length > 0, true);
      assert.equal(
        nativeEvents.some((record) => record.event?.provider === "claudeAgent"),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) =>
            String(
              (record.event as { readonly providerThreadId?: string } | undefined)
                ?.providerThreadId,
            ) === "sdk-session-native-log",
        ),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => String(record.event?.turnId) === String(turn.turnId)),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) => record.event?.method === "claude/stream_event/content_block_delta/text_delta",
        ),
        true,
      );
      assert.equal(
        nativeThreadIds.every((threadId) => threadId === String(THREAD_ID)),
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
