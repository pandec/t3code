import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  defaultInstanceIdForDriver,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type ModelSelection,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { seedNewDraftModelState } from "./useHandleNewThread";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const TEST_PROJECT_ID = ProjectId.make("project-1");
const TEST_PROJECT_REF = scopeProjectRef(TEST_ENVIRONMENT_ID, TEST_PROJECT_ID);
const LOGICAL_PROJECT_KEY = "logical-project-a";
const OTHER_LOGICAL_PROJECT_KEY = "logical-project-b";

function toSelections(
  options: Record<string, string | boolean | undefined> | undefined,
): ReadonlyArray<ProviderOptionSelection> {
  const result: Array<ProviderOptionSelection> = [];
  if (!options) return result;
  for (const [id, value] of Object.entries(options)) {
    if (typeof value === "string" || typeof value === "boolean") {
      result.push({ id, value });
    }
  }
  return result;
}

function modelSelection(
  provider: ProviderDriverKind,
  model: string,
  options?: Record<string, string | boolean | undefined>,
): ModelSelection {
  return createModelSelection(defaultInstanceIdForDriver(provider), model, toSelections(options));
}

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

function createDraft(draftId: DraftId): void {
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(LOGICAL_PROJECT_KEY, TEST_PROJECT_REF, draftId, {
      threadId: ThreadId.make(`thread-${draftId}`),
    });
}

function draftFor(draftId: DraftId) {
  return useComposerDraftStore.getState().draftsByThreadKey[draftId] ?? undefined;
}

describe("seedNewDraftModelState", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("seeds the project default model over the global sticky selection", () => {
    const draftId = DraftId.make("draft-project-default");
    useComposerDraftStore
      .getState()
      .setStickyModelSelection(modelSelection(CODEX_DRIVER, "gpt-5.4"));
    createDraft(draftId);

    seedNewDraftModelState({
      draftId,
      logicalProjectKey: LOGICAL_PROJECT_KEY,
      projectDefaultModelSelection: modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"),
      carryModelSelection: null,
      carrySourceLogicalProjectKey: null,
    });

    expect(draftFor(draftId)).toMatchObject({
      activeProvider: "claudeAgent",
      modelSelectionByProvider: {
        claudeAgent: modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"),
        // Sticky per-provider memory stays available for other providers.
        codex: modelSelection(CODEX_DRIVER, "gpt-5.4"),
      },
    });
  });

  it("falls back to the sticky selection when the project has no default", () => {
    const draftId = DraftId.make("draft-sticky-fallback");
    useComposerDraftStore
      .getState()
      .setStickyModelSelection(modelSelection(CODEX_DRIVER, "gpt-5.4"));
    createDraft(draftId);

    seedNewDraftModelState({
      draftId,
      logicalProjectKey: LOGICAL_PROJECT_KEY,
      projectDefaultModelSelection: null,
      carryModelSelection: null,
      carrySourceLogicalProjectKey: null,
    });

    expect(draftFor(draftId)).toMatchObject({
      activeProvider: "codex",
      modelSelectionByProvider: {
        codex: modelSelection(CODEX_DRIVER, "gpt-5.4"),
      },
    });
  });

  it("lets a same-project carried selection win over the project default", () => {
    const draftId = DraftId.make("draft-same-project-carry");
    createDraft(draftId);

    seedNewDraftModelState({
      draftId,
      logicalProjectKey: LOGICAL_PROJECT_KEY,
      projectDefaultModelSelection: modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"),
      carryModelSelection: modelSelection(CODEX_DRIVER, "gpt-5.4", { reasoningEffort: "high" }),
      carrySourceLogicalProjectKey: LOGICAL_PROJECT_KEY,
    });

    expect(draftFor(draftId)).toMatchObject({
      activeProvider: "codex",
      modelSelectionByProvider: {
        codex: modelSelection(CODEX_DRIVER, "gpt-5.4", { reasoningEffort: "high" }),
      },
    });
  });

  it("prefers the target project's default over a cross-project carried selection", () => {
    const draftId = DraftId.make("draft-cross-project-carry");
    createDraft(draftId);

    seedNewDraftModelState({
      draftId,
      logicalProjectKey: LOGICAL_PROJECT_KEY,
      projectDefaultModelSelection: modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"),
      carryModelSelection: modelSelection(CODEX_DRIVER, "gpt-5.4"),
      carrySourceLogicalProjectKey: OTHER_LOGICAL_PROJECT_KEY,
    });

    expect(draftFor(draftId)).toMatchObject({
      activeProvider: "claudeAgent",
      modelSelectionByProvider: {
        claudeAgent: modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"),
      },
    });
  });

  it("keeps sticky option memory when the project default names the same provider", () => {
    const draftId = DraftId.make("draft-option-memory");
    useComposerDraftStore
      .getState()
      .setStickyModelSelection(
        modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
      );
    createDraft(draftId);

    seedNewDraftModelState({
      draftId,
      logicalProjectKey: LOGICAL_PROJECT_KEY,
      projectDefaultModelSelection: modelSelection(CLAUDE_AGENT_DRIVER, "claude-sonnet-4-5"),
      carryModelSelection: null,
      carrySourceLogicalProjectKey: null,
    });

    // The default stores provider+model; sticky option memory still applies.
    expect(draftFor(draftId)).toMatchObject({
      activeProvider: "claudeAgent",
      modelSelectionByProvider: {
        claudeAgent: modelSelection(CLAUDE_AGENT_DRIVER, "claude-sonnet-4-5", { effort: "max" }),
      },
    });
  });
});
