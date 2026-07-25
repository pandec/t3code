import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderCatalogInstance,
  type ProviderCatalogResult,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { claudeProjectDirectoryName } from "../provider/Drivers/ClaudeSessionImport.ts";
import {
  decideSessionPlacement,
  deriveSessionDestination,
  deriveSessionWorktreePath,
  placeSessionFile,
  resolveCliModelSelection,
  resolveImportInstance,
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
    });
  }),
);

it.effect("sniffs Claude typed JSONL and requires the filename UUID", () =>
  Effect.gen(function* () {
    const sniffed = yield* sniffSessionTranscript({
      fileName: `${claudeSessionId}.jsonl`,
      content: [
        `{"type":"user","sessionId":"${claudeSessionId}","cwd":"/repo/source","message":{"role":"user","content":"hello"}}`,
        `{"type":"assistant","sessionId":"${claudeSessionId}","cwd":"/repo/source","message":{"role":"assistant","model":"claude-sonnet-5","content":[]}}`,
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
