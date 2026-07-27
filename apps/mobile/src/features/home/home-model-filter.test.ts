import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHomeModelFilterOptions } from "./home-model-filter";

const environmentId = EnvironmentId.make("environment-1");

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

describe("buildHomeModelFilterOptions", () => {
  it("lists each model once, label-sorted, ignoring archived threads", () => {
    const options = buildHomeModelFilterOptions({
      threads: [
        makeThread({ id: ThreadId.make("a"), title: "A" }),
        makeThread({ id: ThreadId.make("b"), title: "B" }),
        makeThread({
          id: ThreadId.make("c"),
          title: "C",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "claude-opus-4-5",
          },
        }),
        makeThread({
          id: ThreadId.make("archived"),
          title: "Archived",
          archivedAt: "2026-06-02T00:00:00.000Z",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "claude-haiku-4-5",
          },
        }),
      ],
      serverConfigs: new Map(),
    });

    // No server config loaded, so the slug is its own label.
    expect(options).toEqual([
      { key: "claude-opus-4-5", label: "claude-opus-4-5" },
      { key: "gpt-5.4", label: "gpt-5.4" },
    ]);
  });
});
