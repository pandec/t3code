// @effect-diagnostics nodeBuiltinImport:off - integration fixture setup uses the installed Git binary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderCatalogInstance,
  type ProviderCatalogResult,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { sanitizeGitRepositoryEnvironment } from "../git/Utils.ts";
import { claudeProjectDirectoryName } from "../provider/Drivers/ClaudeSessionImport.ts";
import {
  decideSessionPlacement,
  deriveSessionDestination,
  deriveSessionWorktreePath,
  ensureWorktree,
  placeSessionFile,
  resolveCliModelSelection,
  resolveImportInstance,
  SessionCliError,
  sessionHttpError,
  sniffSessionTranscript,
} from "./session.ts";

const claudeSessionId = "9fc85367-4ed9-4dc7-a44e-bee92408ff84";

const providerInstance = (
  input: Partial<ProviderCatalogInstance> &
    Pick<ProviderCatalogInstance, "instanceId" | "driverKind">,
): ProviderCatalogInstance => ({
  instanceId: input.instanceId,
  driverKind: input.driverKind,
  displayName: input.displayName ?? input.instanceId,
  enabled: input.enabled ?? true,
  importCapable: input.importCapable ?? true,
  ...(input.home === undefined ? {} : { home: input.home }),
  models: input.models ?? [],
});

it.effect("sniffs Codex rollout metadata and the last advertised model", () =>
  Effect.gen(function* () {
    const sniffed = yield* sniffSessionTranscript({
      fileName: "rollout-2026-07-25.jsonl",
      content: [
        '{"timestamp":"2026-07-25T08:09:10.000Z","type":"session_meta","payload":{"id":"codex-native-id","cwd":"/repo/source"}}',
        '{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}',
      ].join("\n"),
    });

    expect(sniffed).toMatchObject({
      provider: "codex",
      nativeSessionId: "codex-native-id",
      sourceCwd: "/repo/source",
      lastSeenModel: "gpt-5.6-sol",
      timestamp: "2026-07-25T08:09:10.000Z",
      datePath: { year: "2026", month: "07", day: "25" },
    });
  }),
);

it.effect("sniffs Claude typed JSONL and requires the filename UUID", () =>
  Effect.gen(function* () {
    const sniffed = yield* sniffSessionTranscript({
      fileName: `${claudeSessionId}.jsonl`,
      content: [
        `{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-07-25T08:09:10.000Z","sessionId":"${claudeSessionId}","cwd":"/repo/source","message":{"role":"user","content":"hello"}}`,
        `{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-07-25T08:09:11.000Z","sessionId":"${claudeSessionId}","cwd":"/repo/source","message":{"role":"assistant","model":"claude-sonnet-5","content":[]}}`,
      ].join("\n"),
    });

    expect(sniffed).toMatchObject({
      provider: "claudeAgent",
      nativeSessionId: claudeSessionId,
      sourceCwd: "/repo/source",
      lastSeenModel: "claude-sonnet-5",
    });
  }),
);

it.effect("rejects malformed and unknown transcript formats", () =>
  Effect.gen(function* () {
    const malformed = yield* sniffSessionTranscript({
      fileName: "bad.jsonl",
      content: "{not-json",
    }).pipe(Effect.flip);
    expect(malformed.detail).toContain("not valid JSON");

    const unknown = yield* sniffSessionTranscript({
      fileName: "bad.jsonl",
      content: '{"type":"user","cwd":"/repo"}',
    }).pipe(Effect.flip);
    expect(unknown.detail).toContain("Unknown session format");

    const unsupportedClaudeRecord = yield* sniffSessionTranscript({
      fileName: `${claudeSessionId}.jsonl`,
      content: `{"type":"adversarial-new-type","sessionId":"${claudeSessionId}","cwd":"/repo"}`,
    }).pipe(Effect.flip);
    expect(unsupportedClaudeRecord.detail).toContain("adversarial-new-type");

    const nonIsoCodexTimestamp = yield* sniffSessionTranscript({
      fileName: "rollout.jsonl",
      content:
        '{"timestamp":"July 25, 2026","type":"session_meta","payload":{"id":"codex-native-id","cwd":"/repo"}}',
    }).pipe(Effect.flip);
    expect(nonIsoCodexTimestamp.detail).toContain("valid ISO calendar date");

    const normalizedInvalidCodexDate = yield* sniffSessionTranscript({
      fileName: "rollout.jsonl",
      content:
        '{"timestamp":"2026-02-31T08:09:10.000Z","type":"session_meta","payload":{"id":"codex-native-id","cwd":"/repo"}}',
    }).pipe(Effect.flip);
    expect(normalizedInvalidCodexDate.detail).toContain("valid ISO calendar date");
  }),
);

it.effect("resolves explicit provider homes and reports same-driver ambiguity", () =>
  Effect.gen(function* () {
    const catalog: ProviderCatalogResult = {
      instances: [
        providerInstance({
          instanceId: ProviderInstanceId.make("claude_personal"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
          home: "/homes/personal/.claude",
        }),
        providerInstance({
          instanceId: ProviderInstanceId.make("claude_work"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
          home: "/homes/work/.claude",
        }),
      ],
    };
    const ambiguous = yield* resolveImportInstance({
      catalog,
      provider: "claudeAgent",
    }).pipe(Effect.flip);
    expect(ambiguous.detail).toContain("claude_personal, claude_work");

    const explicit = yield* resolveImportInstance({
      catalog,
      provider: "claudeAgent",
      explicitInstanceId: "claude_work",
    });
    expect(explicit.home).toBe("/homes/work/.claude");
  }),
);

it("derives Claude/Codex destinations from per-instance homes and effective cwd", () => {
  const effectiveCwd = "/repo/worktrees/feature";
  const claudePath = deriveSessionDestination({
    session: {
      provider: "claudeAgent",
      nativeSessionId: claudeSessionId,
      sourceCwd: "/old/repo",
      lastSeenModel: null,
      timestamp: null,
      originalFileName: `${claudeSessionId}.jsonl`,
    },
    instanceHome: "/homes/work/.claude",
    effectiveCwd,
  });
  expect(claudePath).toBe(
    `/homes/work/.claude/projects/${claudeProjectDirectoryName(effectiveCwd)}/${claudeSessionId}.jsonl`,
  );

  const codexPath = deriveSessionDestination({
    session: {
      provider: "codex",
      nativeSessionId: "codex-id",
      sourceCwd: "/old/repo",
      lastSeenModel: null,
      timestamp: "2026-07-05T22:00:00.000Z",
      datePath: { year: "2026", month: "07", day: "05" },
      originalFileName: "rollout-original.jsonl",
    },
    instanceHome: "/homes/work/.codex",
    effectiveCwd,
  });
  expect(codexPath).toBe("/homes/work/.codex/sessions/2026/07/05/rollout-original.jsonl");
});

it("derives the server worktree naming scheme", () => {
  expect(
    deriveSessionWorktreePath({
      baseDir: "/state",
      workspaceRoot: "/repos/t3code",
      branch: "feature/session-handover",
    }),
  ).toBe("/state/worktrees/t3code/feature-session-handover");
});

it.layer(NodeServices.layer)("session worktree validation", (it) => {
  it.effect("rejects a derived path owned by another repository", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-session-worktree-"))),
      (baseDir) =>
        Effect.gen(function* () {
          const workspaceRoot = NodePath.join(baseDir, "repos", "project");
          const conflictingPath = deriveSessionWorktreePath({
            baseDir,
            workspaceRoot,
            branch: "feature",
          });
          NodeFS.mkdirSync(workspaceRoot, { recursive: true });
          NodeFS.mkdirSync(conflictingPath, { recursive: true });
          for (const repository of [workspaceRoot, conflictingPath]) {
            NodeChildProcess.execFileSync("git", ["init", "-q", repository], {
              env: sanitizeGitRepositoryEnvironment(),
            });
            NodeChildProcess.execFileSync(
              "git",
              [
                "-C",
                repository,
                "-c",
                "user.name=T3 Test",
                "-c",
                "user.email=t3@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "fixture",
              ],
              { env: sanitizeGitRepositoryEnvironment() },
            );
            NodeChildProcess.execFileSync("git", ["-C", repository, "branch", "-M", "feature"], {
              env: sanitizeGitRepositoryEnvironment(),
            });
          }

          const error = yield* ensureWorktree({
            baseDir,
            workspaceRoot,
            branch: "feature",
          }).pipe(Effect.flip);
          expect(Schema.is(SessionCliError)(error)).toBe(true);
          if (!Schema.is(SessionCliError)(error)) return;
          expect(error.detail).toContain("different Git repository");
        }),
      (baseDir) =>
        Effect.sync(() => {
          NodeFS.rmSync(baseDir, { recursive: true, force: true });
        }),
    ),
  );
});

it("decides retry-safe placement without overwriting", () => {
  const source = new Uint8Array([1, 2, 3]);
  expect(decideSessionPlacement(source, null)).toBe("write");
  expect(decideSessionPlacement(source, new Uint8Array([1, 2, 3]))).toBe("skip-identical");
  expect(decideSessionPlacement(source, new Uint8Array([1, 2, 4]))).toBe("error-different");
});

it.layer(NodeServices.layer)("atomic session placement", (it) => {
  it.effect(
    "places through a synced temp file, skips identical, and rejects different content",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-session-placement-",
        });
        const destinationPath = path.join(directory, "nested", "session.jsonl");
        const bytes = new TextEncoder().encode('{"type":"session_meta"}\n');

        const placed = yield* placeSessionFile({ destinationPath, bytes });
        expect(placed.action).toBe("placed");
        assert.deepEqual(yield* fileSystem.readFile(destinationPath), bytes);

        const skipped = yield* placeSessionFile({ destinationPath, bytes });
        expect(skipped.action).toBe("skipped-identical");

        const conflict = yield* placeSessionFile({
          destinationPath,
          bytes: new TextEncoder().encode("different"),
        }).pipe(Effect.flip);
        expect(conflict.detail).toContain("different content");
      }),
  );
});

it.effect("maps effort by driver kind and validates advertised choices", () =>
  Effect.gen(function* () {
    const claude = providerInstance({
      instanceId: ProviderInstanceId.make("claude"),
      driverKind: ProviderDriverKind.make("claudeAgent"),
      models: [
        {
          slug: "claude-sonnet-5",
          name: "Sonnet",
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [{ id: "high", label: "High" }],
            },
          ],
        },
      ],
    });
    const claudeSelection = yield* resolveCliModelSelection({
      instance: claude,
      explicitModel: "claude-sonnet-5",
      effort: "high",
    });
    expect(claudeSelection?.options).toEqual([{ id: "effort", value: "high" }]);

    const codex = providerInstance({
      instanceId: ProviderInstanceId.make("codex"),
      driverKind: ProviderDriverKind.make("codex"),
      models: [
        {
          slug: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning effort",
              type: "select",
              options: [{ id: "medium", label: "Medium" }],
            },
          ],
        },
      ],
    });
    const codexSelection = yield* resolveCliModelSelection({
      instance: codex,
      explicitModel: "gpt-5.6-sol",
      effort: "medium",
    });
    expect(codexSelection?.options).toEqual([{ id: "reasoningEffort", value: "medium" }]);
  }),
);

it.effect("rejects --effort without a concrete model", () =>
  Effect.gen(function* () {
    const error = yield* resolveCliModelSelection({
      instance: providerInstance({
        instanceId: ProviderInstanceId.make("codex"),
        driverKind: ProviderDriverKind.make("codex"),
      }),
      sniffedModel: null,
      effort: "high",
    }).pipe(Effect.flip);

    expect(error.detail).toContain("--effort requires");
  }),
);

it("labels only real transport deadlines as timeouts", () => {
  const timeout = sessionHttpError("provider catalog", new Cause.TimeoutError());
  expect(timeout).toBeInstanceOf(SessionCliError);
  expect(timeout.message).toContain("within the allowed time");

  const requestFailure = sessionHttpError("provider catalog", new Error("connection refused"));
  expect(requestFailure._tag).toBe("CliOrchestrationRequestError");
  expect(requestFailure.message).toBe("Failed to call the running server.");
});
